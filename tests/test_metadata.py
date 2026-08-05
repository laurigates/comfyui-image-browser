"""Tests for image_meta's container parsers, the generation-metadata mapper, and
the /metadata endpoint perimeter.

Byte containers are synthesized in-process — conftest stubs PIL, so nothing here
may depend on a real encoder. The builders below construct spec-shaped chunks
(real CRCs, real TIFF offsets) so a passing parse is evidence about the format,
not about the fixture.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import struct
import zlib
from types import SimpleNamespace

import folder_paths  # the conftest stub

import image_browser as ib
import image_meta

# ---------- PNG builders ---------------------------------------------


def _chunk(ctype: bytes, data: bytes) -> bytes:
    """One PNG chunk: length + type + data + CRC (same shape as _make_itxt)."""
    body = ctype + data
    crc = zlib.crc32(body) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + body + crc.to_bytes(4, "big")


def _png(chunks: list[tuple[bytes, bytes]]) -> bytes:
    return image_meta.PNG_SIG + b"".join(_chunk(t, d) for t, d in chunks)


IHDR = (b"IHDR", b"\x00" * 13)
IDAT = (b"IDAT", b"x")
IEND = (b"IEND", b"")


def _text(key: bytes, value: bytes) -> tuple[bytes, bytes]:
    return (b"tEXt", key + b"\x00" + value)


def _ztxt(key: bytes, value: bytes) -> tuple[bytes, bytes]:
    # keyword \0 compmethod(0) zlib-stream
    return (b"zTXt", key + b"\x00\x00" + zlib.compress(value))


def _itxt(key: bytes, value: bytes, comp: bool = False) -> tuple[bytes, bytes]:
    # keyword \0 compflag compmethod lang \0 translated \0 text
    payload = zlib.compress(value) if comp else value
    head = key + b"\x00" + (b"\x01" if comp else b"\x00") + b"\x00" + b"\x00" + b"\x00"
    return (b"iTXt", head + payload)


# ---------- JPEG / EXIF builders --------------------------------------


def _tiff(user_comment: bytes, order: bytes = b"II", description: bytes = b"") -> bytes:
    """A minimal TIFF block: IFD0 (ImageDescription? + ExifIFDPointer) -> UserComment."""
    e = "<" if order == b"II" else ">"
    ifd0_entries = []
    if description:
        ifd0_entries.append((0x010E, 2, len(description)))
    ifd0_entries.append((0x8769, 4, 1))
    # 8 header + IFD0 (2 + 12*n + 4) + sub-IFD (2 + 12 + 4)
    ifd0_size = 2 + 12 * len(ifd0_entries) + 4
    sub_off = 8 + ifd0_size
    data_off = sub_off + 18
    desc_off = data_off + len(user_comment)

    ifd0 = struct.pack(e + "H", len(ifd0_entries))
    for tag, typ, count in ifd0_entries:
        value = desc_off if tag == 0x010E else sub_off
        ifd0 += struct.pack(e + "HHII", tag, typ, count, value)
    ifd0 += struct.pack(e + "I", 0)

    sub = struct.pack(e + "H", 1)
    sub += struct.pack(e + "HHII", 0x9286, 7, len(user_comment), data_off)
    sub += struct.pack(e + "I", 0)
    return order + struct.pack(e + "HI", 42, 8) + ifd0 + sub + user_comment + description


def _tiff_tags(tags: dict[int, bytes], order: bytes = b"II") -> bytes:
    """A TIFF block holding ASCII string tags in IFD0 only (no ExifIFD).

    ``_tiff`` above always builds the ExifIFD/UserComment path; this builds the
    IFD0 string tags ComfyUI core's SaveAnimatedWEBP writes into — 0x0110 for
    ``prompt:<json>`` and 0x010F downwards for each extra_pnginfo key.
    """
    e = "<" if order == b"II" else ">"
    items = sorted(tags.items())
    data_off = 8 + 2 + 12 * len(items) + 4
    ifd = struct.pack(e + "H", len(items))
    blobs = b""
    for tag, value in items:
        payload = value + b"\x00"  # ASCII tags are NUL-terminated, count includes it
        if len(payload) <= 4:
            field = payload.ljust(4, b"\x00")  # short values sit inline
        else:
            field = struct.pack(e + "I", data_off + len(blobs))
            blobs += payload
        ifd += struct.pack(e + "HHI", tag, 2, len(payload)) + field
    ifd += struct.pack(e + "I", 0)
    return order + struct.pack(e + "HI", 42, 8) + ifd + blobs


def _app1(payload: bytes) -> bytes:
    return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload


def _com(text: bytes) -> bytes:
    return b"\xff\xfe" + (len(text) + 2).to_bytes(2, "big") + text


def _jpeg(*segments: bytes) -> bytes:
    return b"\xff\xd8" + b"".join(segments) + b"\xff\xda\x00\x02" + b"\xff\xd9"


def _jpeg_exif(user_comment: bytes, order: bytes = b"II", description: bytes = b"") -> bytes:
    block = image_meta.JPEG_EXIF_PREFIX + _tiff(user_comment, order, description)
    return _jpeg(_app1(block))


# ---------- WebP builders --------------------------------------------


def _webp(chunks: list[tuple[bytes, bytes]]) -> bytes:
    body = b""
    for fourcc, payload in chunks:
        body += fourcc + len(payload).to_bytes(4, "little") + payload
        if len(payload) & 1:
            body += b"\x00"  # RIFF pads payloads to an even length
    return b"RIFF" + (4 + len(body)).to_bytes(4, "little") + b"WEBP" + body


# ---------- ISOBMFF (MP4/MOV) builders --------------------------------
#
# Shapes taken from the box trees of real ComfyUI outputs, not from the spec
# alone — the two writers differ structurally and only one of them is what
# ComfyUI's own frontend parser can read:
#
#   core SaveVideo : moov/udta/meta/{keys,ilst}, ilst items typed by a 1-based
#                    index into the keys box
#   kijai save_video: moov/udta/meta/ilst ONLY (no keys box), items typed by
#                    the iTunes fourcc `©cmt`, holding a double-encoded
#                    {"prompt": "...", "workflow": "..."} envelope


def _box(btype: bytes, payload: bytes) -> bytes:
    return (len(payload) + 8).to_bytes(4, "big") + btype + payload


def _keys_box(names: list[bytes]) -> bytes:
    entries = b"".join((len(n) + 8).to_bytes(4, "big") + b"mdta" + n for n in names)
    return _box(b"keys", b"\x00" * 4 + len(names).to_bytes(4, "big") + entries)


def _data_box(value: bytes) -> bytes:
    # type indicator (4) + locale (4) + value
    return _box(b"data", b"\x00\x00\x00\x01" + b"\x00" * 4 + value)


def _mp4(ilst_items: bytes, keys: list[bytes] | None = None, ftyp: bool = True) -> bytes:
    meta_body = b"\x00" * 4  # `meta` is a FullBox: version/flags first
    if keys:
        meta_body += _keys_box(keys)
    meta_body += _box(b"ilst", ilst_items)
    moov = _box(b"moov", _box(b"udta", _box(b"meta", meta_body)))
    head = _box(b"ftyp", b"isom" + b"\x00" * 8) if ftyp else b""
    # mdat FIRST, as in real outputs: the walk must seek past megabytes of
    # media to reach a moov at the end, which a prefix scan would never do.
    return head + _box(b"mdat", b"\x00" * 4096) + moov


def _indexed_item(index: int, value: bytes) -> bytes:
    return _box(index.to_bytes(4, "big"), _data_box(value))


def _atom_item(fourcc: bytes, value: bytes) -> bytes:
    return _box(fourcc, _data_box(value))


# ---------- Matroska (WebM/MKV) builders ------------------------------


def _vint(value: int) -> bytes:
    """Encode an EBML element SIZE (marker bit set, data bits hold the value)."""
    for length in range(1, 9):
        if value < (1 << (7 * length)) - 1:
            return (value | (1 << (7 * length))).to_bytes(length, "big")
    raise ValueError("size too large for the test builder")


def _elem(elem_id: int, payload: bytes) -> bytes:
    id_bytes = elem_id.to_bytes((elem_id.bit_length() + 7) // 8, "big")
    return id_bytes + _vint(len(payload)) + payload


def _simple_tag(name: bytes, value: bytes) -> bytes:
    return _elem(
        image_meta.EBML_ID_SIMPLE_TAG,
        _elem(image_meta.EBML_ID_TAG_NAME, name) + _elem(image_meta.EBML_ID_TAG_STRING, value),
    )


def _webm(tags: bytes, cluster_bytes: int = 4096) -> bytes:
    # A Cluster before the Tags element, so the walk is shown skipping media by
    # declared size rather than scanning through it.
    segment = _elem(0x1F43B675, b"\x00" * cluster_bytes) + _elem(
        image_meta.EBML_ID_TAGS, _elem(image_meta.EBML_ID_TAG, tags)
    )
    return (
        image_meta.EBML_SIG + _vint(4) + b"\x00" * 4 + _elem(image_meta.EBML_ID_SEGMENT, segment)
    )


def _read(tmp_path, name: str, data: bytes) -> tuple[dict[str, str], bool]:
    p = tmp_path / name
    p.write_bytes(data)
    return image_meta.read_raw_metadata(str(p))


# ---------- PNG -------------------------------------------------------


class TestPngRaw:
    def test_text_chunk_round_trip(self, tmp_path):
        raw, truncated = _read(tmp_path, "a.png", _png([IHDR, _text(b"parameters", b"hi"), IEND]))
        assert raw == {"parameters": "hi"}
        assert truncated is False

    def test_ztxt_is_inflated(self, tmp_path):
        raw, _t = _read(tmp_path, "a.png", _png([IHDR, _ztxt(b"prompt", b'{"1": 2}'), IEND]))
        assert raw["prompt"] == '{"1": 2}'

    def test_itxt_uncompressed(self, tmp_path):
        raw, _t = _read(tmp_path, "a.png", _png([IHDR, _itxt(b"workflow", b"ui"), IEND]))
        assert raw["workflow"] == "ui"

    def test_itxt_compressed(self, tmp_path):
        data = _png([IHDR, _itxt(b"workflow", b"zipped", comp=True), IEND])
        raw, _t = _read(tmp_path, "a.png", data)
        assert raw["workflow"] == "zipped"

    def test_text_after_idat_is_found(self, tmp_path):
        """Locks the deliberate divergence from xmp_meta.png_get_xmp, which
        stops at IDAT for its cheap /list probe — some rewriters park their
        text chunks after the pixel data."""
        data = _png([IHDR, IDAT, _text(b"parameters", b"late"), IEND])
        raw, _t = _read(tmp_path, "a.png", data)
        assert raw == {"parameters": "late"}

    def test_bare_png_has_no_metadata(self, tmp_path):
        assert _read(tmp_path, "a.png", _png([IHDR, IDAT, IEND])) == ({}, False)

    def test_duplicate_keyword_first_wins(self, tmp_path):
        data = _png([IHDR, _text(b"parameters", b"first"), _text(b"parameters", b"second"), IEND])
        raw, _t = _read(tmp_path, "a.png", data)
        assert raw["parameters"] == "first"

    def test_utf8_text_survives(self, tmp_path):
        data = _png([IHDR, _text(b"parameters", "ähm 🐈".encode()), IEND])
        raw, _t = _read(tmp_path, "a.png", data)
        assert raw["parameters"] == "ähm 🐈"


# ---------- JPEG ------------------------------------------------------


class TestJpegRaw:
    def test_user_comment_ascii_prefix(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(b"ASCII\x00\x00\x00a cat"))
        assert raw["UserComment"] == "a cat"

    def test_user_comment_unicode_little_endian(self, tmp_path):
        uc = b"UNICODE\x00" + "a cat".encode("utf-16-le")
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(uc, order=b"II"))
        assert raw["UserComment"] == "a cat"

    def test_user_comment_unicode_big_endian(self, tmp_path):
        uc = b"UNICODE\x00" + "a cat".encode("utf-16-be")
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(uc, order=b"MM"))
        assert raw["UserComment"] == "a cat"

    def test_bom_overrides_tiff_byte_order(self, tmp_path):
        # BOM says little-endian while the TIFF header says big — the in-band
        # BOM must win.
        uc = b"UNICODE\x00" + b"\xff\xfe" + "a cat".encode("utf-16-le")
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(uc, order=b"MM"))
        assert raw["UserComment"] == "a cat"

    def test_user_comment_nul_prefix(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(b"\x00" * 8 + b"a cat"))
        assert raw["UserComment"] == "a cat"

    def test_user_comment_without_charset_prefix(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(b"Steps: 20, Seed: 1, CFG scale: 8"))
        assert raw["UserComment"] == "Steps: 20, Seed: 1, CFG scale: 8"

    def test_jis_prefix_is_skipped(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(b"JIS\x00\x00\x00\x00\x00garbage"))
        assert raw.get("UserComment", "") == ""

    def test_image_description(self, tmp_path):
        data = _jpeg_exif(b"ASCII\x00\x00\x00x", description=b"a forge caption\x00")
        raw, _t = _read(tmp_path, "a.jpg", data)
        assert raw["ImageDescription"] == "a forge caption"

    def test_com_segment(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpeg", _jpeg(_com(b"a comment")))
        assert raw["Comment"] == "a comment"

    def test_xmp_app1(self, tmp_path):
        payload = image_meta.JPEG_XMP_PREFIX + b"<x:xmpmeta/>"
        raw, _t = _read(tmp_path, "a.jpg", _jpeg(_app1(payload)))
        assert raw["XMP"] == "<x:xmpmeta/>"

    def test_fill_bytes_before_marker_tolerated(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpg", _jpeg(b"\xff\xff\xff" + _com(b"padded")[1:]))
        assert raw["Comment"] == "padded"


# ---------- WebP ------------------------------------------------------


class TestWebpRaw:
    def test_exif_chunk_bare_tiff(self, tmp_path):
        data = _webp([(b"VP8 ", b"px"), (b"EXIF", _tiff(b"ASCII\x00\x00\x00a cat"))])
        raw, _t = _read(tmp_path, "a.webp", data)
        assert raw["UserComment"] == "a cat"

    def test_exif_chunk_with_jpeg_prefix(self, tmp_path):
        block = image_meta.JPEG_EXIF_PREFIX + _tiff(b"ASCII\x00\x00\x00a cat")
        raw, _t = _read(tmp_path, "a.webp", _webp([(b"EXIF", block)]))
        assert raw["UserComment"] == "a cat"

    def test_odd_length_chunk_pad_is_skipped(self, tmp_path):
        # An odd XMP payload followed by another chunk: forgetting the RIFF pad
        # byte loses every chunk after it.
        data = _webp([(b"XMP ", b"odd"), (b"EXIF", _tiff(b"ASCII\x00\x00\x00a cat"))])
        raw, _t = _read(tmp_path, "a.webp", data)
        assert raw["XMP"] == "odd"
        assert raw["UserComment"] == "a cat"


# ---------- malformed containers --------------------------------------


class TestMalformedNeverRaises:
    def _ok(self, result):
        raw, truncated = result
        assert isinstance(raw, dict)
        assert isinstance(truncated, bool)
        return raw

    def test_bad_png_signature(self, tmp_path):
        assert self._ok(_read(tmp_path, "a.png", b"NOTAPNG" + b"\x00" * 40)) == {}

    def test_png_chunk_length_past_eof(self, tmp_path):
        data = image_meta.PNG_SIG + (1 << 30).to_bytes(4, "big") + b"tEXt" + b"k\x00v"
        assert self._ok(_read(tmp_path, "a.png", data)) == {}

    def test_png_chunk_past_eof_keeps_earlier_chunks(self, tmp_path):
        # The framing check must stop the walk, not discard the walk: chunks
        # that were fully present before the bad header still count. Pairs with
        # TestCaps.test_single_value_cap_trims_and_flags, which locks the other
        # side — a short read caused by the *budget* keeps its partial value.
        data = _png([IHDR, _text(b"parameters", b"kept")])
        data += (1 << 30).to_bytes(4, "big") + b"tEXt" + b"k\x00v"
        assert self._ok(_read(tmp_path, "a.png", data)) == {"parameters": "kept"}

    def test_jpeg_segment_length_past_eof(self, tmp_path):
        # A COM segment declaring 64 KiB with 7 bytes behind it: the tail is not
        # a comment the writer wrote, so it must not be reported as one.
        data = b"\xff\xd8" + b"\xff\xfe" + b"\xff\xff" + b"nonsense"[:7]
        assert self._ok(_read(tmp_path, "a.jpg", data)) == {}

    def test_webp_chunk_size_past_eof(self, tmp_path):
        # Same for RIFF, where the chunk size is little-endian and the enclosing
        # RIFF size (honest here) can't catch it.
        body = b"XMP " + (1 << 20).to_bytes(4, "little") + b"lies"
        data = b"RIFF" + (4 + len(body)).to_bytes(4, "little") + b"WEBP" + body
        assert self._ok(_read(tmp_path, "a.webp", data)) == {}

    def test_truncated_three_byte_file(self, tmp_path):
        assert self._ok(_read(tmp_path, "a.png", b"\x89PN")) == {}

    def test_empty_file(self, tmp_path):
        for name in ("a.png", "a.jpg", "a.webp"):
            assert self._ok(_read(tmp_path, name, b"")) == {}

    def test_bad_zlib_omits_key_but_keeps_others(self, tmp_path):
        bad = (b"zTXt", b"prompt\x00\x00" + b"not-a-zlib-stream")
        data = _png([IHDR, bad, _text(b"parameters", b"kept"), IEND])
        raw = self._ok(_read(tmp_path, "a.png", data))
        assert "prompt" not in raw
        assert raw["parameters"] == "kept"

    def test_jpeg_segment_length_below_two(self, tmp_path):
        assert self._ok(_read(tmp_path, "a.jpg", b"\xff\xd8\xff\xe1\x00\x01")) == {}

    def test_jpeg_truncated_mid_app1(self, tmp_path):
        data = b"\xff\xd8" + b"\xff\xe1\xff\xff" + image_meta.JPEG_XMP_PREFIX + b"<x"
        self._ok(_read(tmp_path, "a.jpg", data))

    def test_tiff_magic_not_42(self, tmp_path):
        broken = b"II" + struct.pack("<HI", 41, 8) + b"\x00" * 32
        data = _jpeg(_app1(image_meta.JPEG_EXIF_PREFIX + broken))
        assert self._ok(_read(tmp_path, "a.jpg", data)) == {}

    def test_exif_offset_past_block_end(self, tmp_path):
        e = "<"
        ifd0 = struct.pack(e + "H", 1)
        ifd0 += struct.pack(e + "HHII", 0x8769, 4, 1, 0x7FFFFFFF)  # bogus pointer
        ifd0 += struct.pack(e + "I", 0)
        block = b"II" + struct.pack(e + "HI", 42, 8) + ifd0
        data = _jpeg(_app1(image_meta.JPEG_EXIF_PREFIX + block))
        assert self._ok(_read(tmp_path, "a.jpg", data)) == {}

    def test_riff_size_field_lies(self, tmp_path):
        body = b"EXIF" + (1 << 20).to_bytes(4, "little") + b"short"
        data = b"RIFF" + (1 << 24).to_bytes(4, "little") + b"WEBP" + body
        self._ok(_read(tmp_path, "a.webp", data))

    def test_extension_without_a_parser(self, tmp_path):
        # .gif / .tif are in IMG_EXTS but have no parser here — an honest
        # "nothing read", never an error.
        for name in ("a.gif", "a.tif"):
            assert _read(tmp_path, name, b"GIF89a" + b"\x00" * 32) == ({}, False)


# ---------- caps ------------------------------------------------------


class TestCaps:
    def test_single_value_cap_trims_and_flags(self, tmp_path, monkeypatch):
        monkeypatch.setattr(image_meta, "MAX_VALUE_BYTES", 64)
        data = _png([IHDR, _text(b"parameters", b"A" * 4096), IEND])
        raw, truncated = _read(tmp_path, "a.png", data)
        assert truncated is True
        assert len(raw["parameters"]) <= 64

    def test_total_cap_drops_later_keys(self, tmp_path, monkeypatch):
        monkeypatch.setattr(image_meta, "MAX_TOTAL_BYTES", 20)
        data = _png(
            [
                IHDR,
                _text(b"one", b"x" * 30),
                _text(b"two", b"y" * 30),
                _text(b"three", b"z" * 30),
                IEND,
            ]
        )
        raw, truncated = _read(tmp_path, "a.png", data)
        assert truncated is True
        assert len(raw) < 3

    def test_zip_bomb_ztxt_is_bounded(self, tmp_path, monkeypatch):
        """Locks the decompressobj(max_length=…) guard — zlib.decompress here
        would materialise 8 MB from a ~8 KB chunk."""
        monkeypatch.setattr(image_meta, "MAX_VALUE_BYTES", 64)
        data = _png([IHDR, _ztxt(b"parameters", b"A" * 8_000_000), IEND])
        raw, truncated = _read(tmp_path, "a.png", data)
        assert truncated is True
        assert len(raw.get("parameters", "")) <= 64

    def test_fill_byte_run_is_bounded(self, tmp_path):
        """Locks MAX_FILL_BYTES. The 0xFF fill run sits *inside* one segment, so
        MAX_CHUNKS never bounded it: an all-0xFF file was walked to EOF one
        read(1) at a time (measured 3.9 s for 64 MiB) to return nothing. A run
        past the cap means the stream isn't a JPEG we can frame, so the segment
        behind it must stay unread — remove the bound and this comment is found.
        """
        run = b"\xff" * (image_meta.MAX_FILL_BYTES + 2)
        data = b"\xff\xd8" + run + _com(b"past the fill cap")[1:]
        assert _read(tmp_path, "a.jpg", data) == ({}, False)

    def test_text_chunk_cap_stops_the_walk_and_flags_it(self, tmp_path, monkeypatch):
        monkeypatch.setattr(image_meta, "MAX_TEXT_CHUNKS", 1)
        data = _png([IHDR, _text(b"one", b"kept"), _text(b"two", b"dropped"), IEND])
        raw, truncated = _read(tmp_path, "a.png", data)
        assert raw == {"one": "kept"}
        # Giving up must be *reported*: the frontend paints "no embedded
        # metadata" off an empty raw with truncated False.
        assert truncated is True

    def test_walk_backstop_flags_truncated(self, tmp_path, monkeypatch):
        monkeypatch.setattr(image_meta, "MAX_WALK_CHUNKS", 1)
        data = _png([IHDR, _text(b"parameters", b"never reached"), IEND])
        raw, truncated = _read(tmp_path, "a.png", data)
        assert raw == {}
        assert truncated is True

    def test_walk_backstop_terminates_on_endless_tiny_chunks(self, tmp_path):
        """The backstop's whole job: a hostile file must not be walked to EOF.

        MAX_WALK_CHUNKS x 12 bytes of empty chunks is a fraction of this file, so
        reaching the end would mean the bound is gone.
        """
        junk = _chunk(b"junk", b"") * (image_meta.MAX_WALK_CHUNKS * 2)
        raw, truncated = _read(tmp_path, "a.png", image_meta.PNG_SIG + _chunk(*IHDR) + junk)
        assert raw == {}
        assert truncated is True

    def test_text_chunk_after_many_idat_chunks_is_still_found(self, tmp_path):
        """The regression: MAX_CHUNKS used to count IDAT too, so the allowance
        was spent on *pixel data the walk only seeks past*. PIL (and therefore
        ComfyUI) writes 64 KB IDAT blocks, so a ~39 MB PNG holds ~600 of them —
        past the old 512 cap. Measured before the fix: 400 IDATs found the
        prompt, 600 returned ({}, False), i.e. "this image has no metadata and
        nothing was truncated" for an ordinary generated file. Tiny IDATs here
        reproduce the cliff without writing 39 MB.
        """
        chunks = [IHDR, *([IDAT] * (image_meta.MAX_TEXT_CHUNKS + 88))]
        chunks += [_text(b"prompt", b"REAL PROMPT"), IEND]
        raw, truncated = _read(tmp_path, "a.png", _png(chunks))
        assert raw == {"prompt": "REAL PROMPT"}
        assert truncated is False

    def test_duplicate_keys_drain_the_inflate_budget(self, tmp_path, monkeypatch):
        """Request amplification: `add` used to return on a duplicate key
        *before* charging `remaining`, so `budget()` never drained and every
        chunk got a fresh MAX_VALUE_BYTES inflate allowance. Measured on a
        276 KB PNG holding 512 zTXt chunks all keyed `prompt`: 255.5 MB inflated
        in 581 ms (vs 2.0 MB / 5.6 ms once charged) — synchronously on the
        aiohttp event loop, so every other endpoint stalls with it.
        """
        monkeypatch.setattr(image_meta, "MAX_VALUE_BYTES", 4096)
        monkeypatch.setattr(image_meta, "MAX_TOTAL_BYTES", 8192)
        produced = []
        real = image_meta._inflate

        def counting(blob, limit):
            text, clipped = real(blob, limit)
            produced.append(len(text.encode()) if text else 0)
            return text, clipped

        monkeypatch.setattr(image_meta, "_inflate", counting)
        dup = _ztxt(b"prompt", b"A" * 65536)
        raw, truncated = _read(tmp_path, "a.png", _png([IHDR, *([dup] * 64), IEND]))
        assert raw["prompt"] == "A" * 4096  # first occurrence still wins
        assert truncated is True
        # The whole point: total inflate work stays inside the total cap instead
        # of scaling with the chunk count (64 * 4096 = 256 KB before the fix).
        assert sum(produced) <= image_meta.MAX_TOTAL_BYTES

    def test_varying_keys_cannot_sidestep_the_inflate_budget(self, tmp_path, monkeypatch):
        """The other half of the bound: distinct keys must not buy more inflate
        allowance than the total cap either. This path was already correct
        (measured 2.0 MB either way) — the assertion is here so the duplicate fix
        cannot be "fixed" back into a per-key allowance."""
        monkeypatch.setattr(image_meta, "MAX_VALUE_BYTES", 4096)
        monkeypatch.setattr(image_meta, "MAX_TOTAL_BYTES", 8192)
        produced = []
        real = image_meta._inflate

        def counting(blob, limit):
            text, clipped = real(blob, limit)
            produced.append(len(text.encode()) if text else 0)
            return text, clipped

        monkeypatch.setattr(image_meta, "_inflate", counting)
        chunks = [_ztxt(f"prompt{i}".encode(), b"A" * 65536) for i in range(64)]
        raw, truncated = _read(tmp_path, "a.png", _png([IHDR, *chunks, IEND]))
        assert truncated is True
        assert len(raw) < 64
        assert sum(produced) <= image_meta.MAX_TOTAL_BYTES

    def test_dropped_duplicate_still_charges_the_collector(self):
        """Unit-locks the same thing on the collector itself, since that is where
        the accounting lives — the cap bounds the read+inflate that produced the
        string, not the dict slot it lands in."""
        c = image_meta._Collector()
        c.add("k", "x" * 100)
        after_first = c.remaining
        c.add("k", "y" * 100)
        assert c.raw == {"k": "x" * 100}
        assert c.remaining == after_first - 100


# ---------- ComfyUI graph --------------------------------------------


def _ckpt(name="sd_xl_base_1.0.safetensors"):
    return {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": name}}


def _encode(text, node="4"):
    return {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": [node, 1]}}


FULL_GRAPH = {
    "4": _ckpt(),
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024}},
    "6": _encode("a cat in a hat"),
    "7": _encode("blurry, low quality"),
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 123456789,
            "steps": 20,
            "cfg": 8.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "ComfyUI", "images": ["8", 0]}},
}

# SamplerCustomAdvanced — the stock core sampler for every Flux/SD3 workflow.
# BOTH prompts are non-empty on purpose: with one of them blank this fixture is
# degenerate, because that is the single shape where guessing "the non-empty text
# node is the positive" happens to agree with the wiring. Filled/filled is the
# normal case and the one that proves the guider delegation actually runs.
SCA_GRAPH = {
    "1": _ckpt("flux1-dev.safetensors"),
    "2": _encode("positive text", node="1"),
    "3": _encode("ugly, deformed hands", node="1"),
    "4": {
        "class_type": "CFGGuider",
        "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "cfg": 3.5},
    },
    "5": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "dpmpp_2m"}},
    "6": {
        "class_type": "BasicScheduler",
        "inputs": {"model": ["1", 0], "scheduler": "sgm_uniform", "steps": 25, "denoise": 1.0},
    },
    "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
    "8": {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": ["7", 0],
            "guider": ["4", 0],
            "sampler": ["5", 0],
            "sigmas": ["6", 0],
            "latent_image": ["9", 0],
        },
    },
    "9": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024}},
}


# A stock hires-fix graph: KSampler #3 makes the first-pass latent, LatentUpscale
# feeds it to KSampler #10, and #10 is what the saved pixels came from. Both
# samplers hold the same four widgets and the same two conditioning links on
# purpose — that is the shape where a richness ranking ties and the tie-break
# decides which pass's seed the user is shown.
HIRES_GRAPH = {
    "4": _ckpt("sd15.safetensors"),
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 512}},
    "6": _encode("a cat"),
    "7": _encode("blurry"),
    "3": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 111,
            "steps": 20,
            "cfg": 8.0,
            "sampler_name": "euler",
            "scheduler": "normal",
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["5", 0],
        },
    },
    "8": {"class_type": "LatentUpscale", "inputs": {"samples": ["3", 0], "width": 1024}},
    "10": {
        "class_type": "KSampler",
        "inputs": {
            "seed": 999,
            "steps": 10,
            "cfg": 6.0,
            "sampler_name": "dpmpp_2m",
            "scheduler": "karras",
            "model": ["4", 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": ["8", 0],
        },
    },
    "11": {"class_type": "SaveImage", "inputs": {"filename_prefix": "x", "images": ["12", 0]}},
}


def _ui_workflow(positive: str, negative: str) -> dict:
    """A UI-format ("workflow") graph with real links and named input sockets.

    Shaped like the frontend's own serialisation: ``links`` entries are
    ``[link_id, origin_id, origin_slot, target_id, target_slot, type]`` and every
    node names the socket each link lands on. The wiring is the only thing that
    says which encoder is the positive, so a fixture without it proves nothing
    about role resolution. Node 4's ``widgets_values[0]`` is a bare string too
    (the ckpt name) — reachable from an encoder's ``clip`` input, and therefore
    the trap a "leading string is the prompt" reader falls into.
    """
    return {
        "last_node_id": 7,
        "last_link_id": 6,
        "nodes": [
            {
                "id": 4,
                "type": "CheckpointLoaderSimple",
                "inputs": [],
                "widgets_values": ["sd15.safetensors"],
            },
            {
                "id": 6,
                "type": "CLIPTextEncode",
                "inputs": [{"name": "clip", "type": "CLIP", "link": 5}],
                "widgets_values": [positive],
            },
            {
                "id": 7,
                "type": "CLIPTextEncode",
                "inputs": [{"name": "clip", "type": "CLIP", "link": 3}],
                "widgets_values": [negative],
            },
            {
                "id": 3,
                "type": "KSampler",
                "inputs": [
                    {"name": "model", "type": "MODEL", "link": 1},
                    {"name": "positive", "type": "CONDITIONING", "link": 4},
                    {"name": "negative", "type": "CONDITIONING", "link": 6},
                    {"name": "latent_image", "type": "LATENT", "link": 2},
                ],
                "widgets_values": [12345, "randomize", 20, 8.0, "euler", "normal", 1],
            },
            {"id": 5, "type": "EmptyLatentImage", "inputs": [], "widgets_values": [512, 512, 1]},
        ],
        "links": [
            [1, 4, 0, 3, 0, "MODEL"],
            [2, 5, 0, 3, 3, "LATENT"],
            [3, 4, 1, 7, 0, "CLIP"],
            [4, 6, 0, 3, 1, "CONDITIONING"],
            [5, 4, 1, 6, 0, "CLIP"],
            [6, 7, 0, 3, 2, "CONDITIONING"],
        ],
    }


def _parse(graph, key="prompt"):
    return image_meta.parse_generation_meta({key: json.dumps(graph)})


class TestParseComfy:
    def test_full_ksampler_graph(self):
        source, summary = _parse(FULL_GRAPH)
        assert source == "comfyui"
        assert summary == {
            "positive": "a cat in a hat",
            "negative": "blurry, low quality",
            "seed": "123456789",
            "steps": "20",
            "cfg": "8.0",
            "sampler": "euler",
            "scheduler": "normal",
            "model": "sd_xl_base_1.0.safetensors",
        }

    def test_ksampler_advanced_noise_seed(self):
        graph = {
            "1": _ckpt(),
            "2": _encode("p", node="1"),
            "3": {
                "class_type": "KSamplerAdvanced",
                "inputs": {
                    "noise_seed": 999,
                    "steps": 30,
                    "positive": ["2", 0],
                    "model": ["1", 0],
                },
            },
        }
        _source, summary = _parse(graph)
        assert summary["seed"] == "999"
        assert summary["steps"] == "30"

    def test_sampler_custom_advanced_satellites(self):
        source, summary = _parse(SCA_GRAPH)
        assert source == "comfyui"
        # Every field lives on a different satellite node here.
        assert summary["seed"] == "42"
        assert summary["steps"] == "25"
        assert summary["cfg"] == "3.5"
        assert summary["sampler"] == "dpmpp_2m"
        assert summary["scheduler"] == "sgm_uniform"
        assert summary["model"] == "flux1-dev.safetensors"
        # Both prompts resolve, and they resolve through the CFGGuider — the
        # sampler node itself has neither key. Reading them off the sampler
        # left BOTH absent on every real Flux/SD3 image.
        assert summary["positive"] == "positive text"
        assert summary["negative"] == "ugly, deformed hands"

    def test_sampler_custom_advanced_empty_positive_keeps_the_roles(self):
        """The role of a prompt comes from the wiring, never from which text is
        non-empty. An empty positive beside a filled negative is the shape where
        the old guess reported the *negative* as the prompt — copy that and you
        generate a materially different image."""
        graph = dict(SCA_GRAPH)
        graph["2"] = _encode("", node="1")
        _source, summary = _parse(graph)
        assert summary["positive"] == ""
        assert summary["negative"] == "ugly, deformed hands"

    def test_guider_delegation_is_what_finds_the_conditioning(self):
        """Unit-locks _cond_inputs, which shipped defined-but-never-called: it
        must hand back the *guider's* inputs for SamplerCustomAdvanced (which
        holds no positive/negative of its own) and the sampler's own for a
        KSampler."""
        sca = image_meta._inputs_of(SCA_GRAPH["8"])
        cond = image_meta._cond_inputs(SCA_GRAPH, sca)
        assert cond is not sca
        assert cond["positive"] == ["2", 0]
        assert cond["negative"] == ["3", 0]

        ks = image_meta._inputs_of(FULL_GRAPH["3"])
        assert image_meta._cond_inputs(FULL_GRAPH, ks) is ks

    def test_conditioning_passthrough_chain_resolves(self):
        graph = {
            "1": _ckpt(),
            "2": _encode("deep prompt", node="1"),
            "3": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["2", 0]}},
            "4": {
                "class_type": "ConditioningSetTimestepRange",
                "inputs": {"conditioning": ["3", 0], "start": 0.0, "end": 1.0},
            },
            "5": {
                "class_type": "KSampler",
                "inputs": {"seed": 1, "steps": 4, "positive": ["4", 0], "model": ["1", 0]},
            },
        }
        _source, summary = _parse(graph)
        assert summary["positive"] == "deep prompt"

    def test_link_cycle_terminates(self):
        graph = {
            "1": {
                "class_type": "KSampler",
                "inputs": {"seed": 1, "positive": ["2", 0], "negative": ["3", 0]},
            },
            "2": {
                "class_type": "ConditioningCombine",
                "inputs": {"conditioning_1": ["3", 0], "conditioning_2": ["2", 0]},
            },
            "3": {"class_type": "ConditioningCombine", "inputs": {"conditioning_1": ["2", 0]}},
        }
        source, summary = _parse(graph)
        assert source == "comfyui"
        assert summary["seed"] == "1"
        assert "positive" not in summary

    def test_linked_cfg_is_omitted_not_stringified(self):
        graph = {
            "1": _ckpt(),
            "2": _encode("p", node="1"),
            "3": {
                "class_type": "KSampler",
                "inputs": {"seed": 5, "cfg": ["9", 0], "positive": ["2", 0], "model": ["1", 0]},
            },
        }
        _source, summary = _parse(graph)
        assert "cfg" not in summary

    def test_richest_sampler_wins_over_lower_id(self):
        graph = {
            "2": {"class_type": "KSampler", "inputs": {"steps": 5}},
            "10": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": 222,
                    "steps": 20,
                    "cfg": 7.0,
                    "positive": ["11", 0],
                    "negative": ["12", 0],
                },
            },
            "11": _encode("pos", node="1"),
            "12": _encode("neg", node="1"),
        }
        _source, summary = _parse(graph)
        assert summary["seed"] == "222"

    def test_hires_fix_reports_the_second_pass(self):
        """The pass that made the pixels is the LAST one in the latent chain.
        Ranking "richest, then lowest numeric id" reported KSampler #3's seed 111
        / steps 20 / euler for an image #10 produced with seed 999 / steps 10 /
        dpmpp_2m — both nodes score identically, so the id tie-break decided, and
        a user who pastes seed 111 back into a KSampler gets a different image.
        Node id order is deterministic but it is not evidence."""
        _source, summary = _parse(HIRES_GRAPH)
        assert summary["seed"] == "999"
        assert summary["steps"] == "10"
        assert summary["cfg"] == "6.0"
        assert summary["sampler"] == "dpmpp_2m"
        assert summary["scheduler"] == "karras"
        # The prompts are shared by both passes here, so they still resolve.
        assert summary["positive"] == "a cat"

    def test_terminal_sampler_wins_even_when_it_reads_poorer(self):
        """Wiring beats richness, not the other way round: converting the second
        pass's cfg to an input makes pass 1 the "richest" node, and richness-first
        would hand back pass 1's whole row. cfg is then simply absent — honest,
        because it really is unreadable — while everything else is pass 2's."""
        graph = json.loads(json.dumps(HIRES_GRAPH))
        graph["10"]["inputs"]["cfg"] = ["13", 0]
        _source, summary = _parse(graph)
        assert summary["seed"] == "999"
        assert summary["sampler"] == "dpmpp_2m"
        assert "cfg" not in summary

    def test_sampler_chain_through_a_vae_round_trip_is_followed(self):
        """A refiner pass usually takes an *image*, not a latent: pass 1 ->
        VAEDecode -> upscale -> VAEEncode -> pass 2. The consumption test walks
        any link type for exactly this reason."""
        graph = json.loads(json.dumps(HIRES_GRAPH))
        graph["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0]}}
        graph["14"] = {"class_type": "ImageScaleBy", "inputs": {"image": ["8", 0], "scale_by": 2}}
        graph["15"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["14", 0]}}
        graph["10"]["inputs"]["latent_image"] = ["15", 0]
        _source, summary = _parse(graph)
        assert summary["seed"] == "999"

    def test_genuinely_ambiguous_samplers_omit_rather_than_guess(self):
        """Two equally readable samplers with no latent path between them (an
        XY-plot, a batch graph, two independent branches): the graph does not say
        which one made *this* file, so nothing about the sampler is reported.
        Same rule as the prompt roles — an absent key beats a coin-flipped one.
        `source` stays "comfyui" because the container really did carry a graph.
        """
        rich = {
            "seed": 111,
            "steps": 20,
            "cfg": 8.0,
            "positive": ["20", 0],
            "negative": ["21", 0],
        }
        graph = {
            "10": {"class_type": "KSampler", "inputs": dict(rich, seed=999)},
            "3": {"class_type": "KSampler", "inputs": dict(rich)},
            "20": _encode("pos", node="1"),
            "21": _encode("neg", node="1"),
        }
        source, summary = _parse(graph)
        assert source == "comfyui"
        assert summary == {}

    def test_a_sampler_cycle_still_terminates(self):
        """Hand-edited graphs cycle. With every sampler consumed by another one
        the terminal set is empty, which must fall back to the whole set (and
        then abstain on the tie) rather than crash or loop."""
        graph = {
            "1": {"class_type": "KSampler", "inputs": {"seed": 1, "latent_image": ["2", 0]}},
            "2": {"class_type": "KSampler", "inputs": {"seed": 2, "latent_image": ["1", 0]}},
        }
        source, summary = _parse(graph)
        assert source == "comfyui"
        assert "seed" not in summary

    def test_unresolvable_link_omits_the_prompt_even_with_one_text_node(self):
        """There is deliberately NO text-node fallback. "The graph has exactly
        one text node, so it is the positive" is inference about a *role*, and
        the role is only knowable from the wiring — the module's own rule is that
        an absent key beats a wrong one. The rest of the summary still resolves,
        which is what keeps this an omission and not a parse failure."""
        graph = {
            "1": {"class_type": "KSampler", "inputs": {"seed": 7, "positive": ["99", 0]}},
            "2": _encode("only one", node="1"),
        }
        _source, summary = _parse(graph)
        assert summary["seed"] == "7"
        assert "positive" not in summary
        assert "negative" not in summary

    def test_two_text_nodes_one_empty_are_not_role_guessed(self):
        """The shape the old two-node guess was built for. It cannot tell which
        encoder is which (it discarded the node ids), so it must yield nothing."""
        graph = {
            "1": {"class_type": "KSampler", "inputs": {"seed": 7, "positive": ["99", 0]}},
            "2": _encode("the prompt", node="1"),
            "3": _encode("   ", node="1"),
        }
        _source, summary = _parse(graph)
        assert "positive" not in summary
        assert "negative" not in summary

    def test_lone_utility_text_node_is_not_reported_as_a_prompt(self):
        """TEXT_INPUT_KEYS includes ``string``/``prompt``, so the only
        text-carrying node in a graph is routinely a utility node holding a path
        or a filename prefix. Nothing wires it to conditioning, so nothing may
        call it the positive prompt."""
        graph = {
            "1": {"class_type": "KSampler", "inputs": {"seed": 7, "positive": ["99", 0]}},
            "2": {
                "class_type": "StringConstant",
                "inputs": {"string": "/home/user/ComfyUI/notes/todo.txt"},
            },
        }
        _source, summary = _parse(graph)
        assert "positive" not in summary

    def test_three_text_nodes_omit_both_prompts(self):
        graph = {
            "1": {"class_type": "KSampler", "inputs": {"seed": 7, "positive": ["99", 0]}},
            "2": _encode("a", node="1"),
            "3": _encode("b", node="1"),
            "4": _encode("c", node="1"),
        }
        _source, summary = _parse(graph)
        assert "positive" not in summary
        assert "negative" not in summary

    def test_chain_past_the_depth_bound_omits_rather_than_guesses(self):
        """A conditioning chain longer than MAX_LINK_DEPTH ends the walk. That
        used to hand the prompt to the text-node guess, which then reported the
        chain's text as the positive without having walked to it — a right answer
        by luck here and a wrong one the moment a second text node exists."""
        depth = image_meta.MAX_LINK_DEPTH + 5
        graph: dict = {
            "1": {"class_type": "KSampler", "inputs": {"seed": 1, "positive": ["2", 0]}},
            str(depth + 2): _encode("DEEP", node="1"),
        }
        for i in range(2, depth + 2):
            graph[str(i)] = {
                "class_type": "ConditioningZeroOut",
                "inputs": {"conditioning": [str(i + 1), 0]},
            }
        _source, summary = _parse(graph)
        assert "positive" not in summary

    def test_structural_text_terminator_accepts_custom_class(self):
        graph = {
            "1": _ckpt(),
            "2": {"class_type": "smZ CLIPTextEncode", "inputs": {"text": "community encoder"}},
            "3": {
                "class_type": "KSampler",
                "inputs": {"seed": 1, "positive": ["2", 0], "negative": ["2", 0]},
            },
        }
        _source, summary = _parse(graph)
        assert summary["positive"] == "community encoder"


# ---------- A1111 / Forge --------------------------------------------

A1111_BLOCK = (
    "a cat in a hat, masterpiece\n"
    "Negative prompt: blurry, low quality\n"
    "Steps: 20, Sampler: Euler a, Schedule type: Karras, CFG scale: 8, Seed: 123, "
    'Size: 512x512, Model hash: abc123, Model: sd15, Lora hashes: "a: 1, b: 2", Version: v1.9.4'
)


class TestParseA1111:
    def test_full_classic_block(self):
        source, summary = image_meta.parse_generation_meta({"parameters": A1111_BLOCK})
        assert source == "a1111"
        assert summary == {
            "positive": "a cat in a hat, masterpiece",
            "negative": "blurry, low quality",
            "steps": "20",
            "sampler": "Euler a",
            "scheduler": "Karras",
            "cfg": "8",
            "seed": "123",
            "model": "sd15",
        }

    def test_sampler_suffix_is_not_split_into_scheduler(self):
        block = "cat\nSteps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1"
        _source, summary = image_meta.parse_generation_meta({"parameters": block})
        assert summary["sampler"] == "DPM++ 2M Karras"
        assert "scheduler" not in summary

    def test_quoted_comma_does_not_split_a_token(self):
        pairs = dict(image_meta._split_settings('Steps: 20, Lora hashes: "a: 1, b: 2", Seed: 9'))
        assert pairs["Lora hashes"] == '"a: 1, b: 2"'
        assert pairs["Seed"] == "9"

    def test_missing_negative_marker_omits_the_key(self):
        block = "just a positive\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 2"
        _source, summary = image_meta.parse_generation_meta({"parameters": block})
        assert summary["positive"] == "just a positive"
        assert "negative" not in summary

    def test_block_in_user_comment_is_detected(self):
        source, summary = image_meta.parse_generation_meta({"UserComment": A1111_BLOCK})
        assert source == "a1111"
        assert summary["seed"] == "123"

    def test_settings_line_is_found_behind_a_trailing_line(self):
        """The settings line is NOT reliably ``lines[-1]``. Forge appends
        ``Template:``, civitai and other re-taggers append a ``Hashes:`` block,
        ADetailer appends its own lines. Recognising only the last line meant one
        trailing line dumped the entire settings line into the reported NEGATIVE
        prompt ("dog\\nSteps: 20, Sampler: …, Seed: 111, Model: x\\nTemplate: foo")
        and dropped seed/steps/cfg/sampler/model altogether — a wrong prompt
        reported as data, and nothing to re-run from.
        """
        head = (
            "a cat\nNegative prompt: dog\n"
            "Steps: 20, Sampler: DPM++ 2M, CFG scale: 7, Seed: 111, Model: x"
        )
        tails = ("Template: foo", 'Hashes: {"model": "abc"}', "ADetailer model: face_yolov8n.pt")
        for tail in tails:
            _source, summary = image_meta.parse_generation_meta({"parameters": head + "\n" + tail})
            assert summary == {
                "positive": "a cat",
                "negative": "dog",
                "steps": "20",
                "sampler": "DPM++ 2M",
                "cfg": "7",
                "seed": "111",
                "model": "x",
            }, tail

    def test_several_trailing_lines_are_scanned_past(self):
        block = (
            "a cat\nNegative prompt: dog\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 3\n"
            "Template: foo\nNegative Template: bar\nHashes: {}\nVersion: f2.0"
        )
        _source, summary = image_meta.parse_generation_meta({"parameters": block})
        assert summary["negative"] == "dog"
        assert summary["seed"] == "3"

    def test_multiline_prompt_survives_the_backward_scan(self):
        """The scan stops at the first line that is not ``Key: value`` — prompt
        prose — so a multi-line prompt is not chopped into the settings slot."""
        block = (
            "a cat\nsitting on a mat\nNegative prompt: dog\nrunning\n"
            "Steps: 20, Sampler: Euler, CFG scale: 7, Seed: 4"
        )
        _source, summary = image_meta.parse_generation_meta({"parameters": block})
        assert summary["positive"] == "a cat\nsitting on a mat"
        assert summary["negative"] == "dog\nrunning"
        assert summary["seed"] == "4"

    def test_unsplittable_settings_are_not_reported_as_a_prompt(self):
        """Belt and braces for the same failure: if the params block is somehow
        still inside the prompt text (a trailing block past A1111_TAIL_SCAN, or a
        shape we do not recognise), the prompt key is omitted rather than
        reported as a prompt somebody would paste back into another tool."""
        block = "a cat\nNegative prompt: dog\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 5\n"
        block += "\n".join(f"Extra {i}: x" for i in range(image_meta.A1111_TAIL_SCAN + 2))
        _source, summary = image_meta.parse_generation_meta({"parameters": block})
        assert "negative" not in summary
        assert summary["positive"] == "a cat"

    def test_camera_caption_is_not_promoted(self):
        source, summary = image_meta.parse_generation_meta({"Comment": "Shot on a Canon, f/1.8"})
        assert (source, summary) == ("none", {})


# ---------- graphs outside PNG text chunks ----------------------------


class TestGraphInNonPngContainers:
    """Comfy-graph detection must not be structurally PNG-only.

    ``prompt``/``workflow`` are PNG text-chunk keywords, and only PNG has text
    chunks — a JPEG or WebP writer parks the same JSON in EXIF UserComment, the
    JPEG COM segment, or the IFD0 string tags core's SaveAnimatedWEBP uses.
    Dispatching on the two PNG keys alone meant the whole EXIF reader could
    never reach the Comfy parsers: a JPEG carrying a complete graph answered
    ``source="none"`` with an honest-looking "no generation data".
    """

    def test_api_graph_in_jpeg_user_comment(self, tmp_path):
        uc = b"ASCII\x00\x00\x00" + json.dumps(FULL_GRAPH).encode()
        raw, _t = _read(tmp_path, "a.jpg", _jpeg_exif(uc))
        source, summary = image_meta.parse_generation_meta(raw)
        assert source == "comfyui"
        assert summary["seed"] == "123456789"
        assert summary["steps"] == "20"
        assert summary["positive"] == "a cat in a hat"
        assert summary["model"] == "sd_xl_base_1.0.safetensors"

    def test_api_graph_in_jpeg_com_segment(self, tmp_path):
        raw, _t = _read(tmp_path, "a.jpg", _jpeg(_com(json.dumps(FULL_GRAPH).encode())))
        source, summary = image_meta.parse_generation_meta(raw)
        assert (source, summary["sampler"]) == ("comfyui", "euler")

    def test_webp_core_exif_layout_yields_prompt_and_workflow(self, tmp_path):
        """SaveAnimatedWEBP writes ``"prompt:<json>"`` into 0x0110 and each
        extra_pnginfo key from 0x010F downwards (``"workflow:<json>"``). Reading
        only 0x010E + the ExifIFD's UserComment left a core-layout WebP reporting
        "No embedded metadata in this file"."""
        block = _tiff_tags(
            {
                0x0110: b"prompt:" + json.dumps(FULL_GRAPH).encode(),
                0x010F: b"workflow:" + json.dumps(_ui_workflow("a cat", "blurry")).encode(),
            }
        )
        raw, _t = _read(tmp_path, "a.webp", _webp([(b"VP8 ", b"px"), (b"EXIF", block)]))
        # The "<key>:" prefix is split back off, so the parsers see the very keys
        # a PNG writer would have used — no per-container knowledge downstream.
        assert set(raw) == {"prompt", "workflow"}
        source, summary = image_meta.parse_generation_meta(raw)
        assert source == "comfyui"
        assert summary["seed"] == "123456789"
        assert summary["negative"] == "blurry, low quality"

    def test_camera_make_and_model_stay_camera_fields(self, tmp_path):
        """The un-prefixing must not fire on ordinary IFD0 strings — the guard is
        a known pnginfo key followed by a JSON object, not just a colon."""
        block = _tiff_tags({0x010F: b"Canon", 0x0110: b"prompt: sharp focus, f/1.8"})
        raw, _t = _read(tmp_path, "a.jpg", _jpeg(_app1(image_meta.JPEG_EXIF_PREFIX + block)))
        assert raw == {"Make": "Canon", "Model": "prompt: sharp focus, f/1.8"}
        assert image_meta.parse_generation_meta(raw) == ("none", {})

    def test_api_graph_wins_over_a_ui_graph_in_another_key(self):
        """Which raw key a writer chose is an accident of the container, so the
        API graph gets first refusal across all of them — it is the form that can
        yield the numbers honestly."""
        raw = {
            "UserComment": json.dumps(_ui_workflow("ui pos", "ui neg")),
            "Comment": json.dumps(FULL_GRAPH),
        }
        _source, summary = image_meta.parse_generation_meta(raw)
        assert summary["positive"] == "a cat in a hat"
        assert summary["steps"] == "20"

    def test_a1111_block_in_user_comment_still_wins_when_no_graph_present(self):
        source, summary = image_meta.parse_generation_meta({"UserComment": A1111_BLOCK})
        assert (source, summary["seed"]) == ("a1111", "123")


# ---------- fallthrough ----------------------------------------------


class TestParseFallthrough:
    def test_empty_mapping(self):
        assert image_meta.parse_generation_meta({}) == ("none", {})

    def test_unparsable_prompt(self):
        assert image_meta.parse_generation_meta({"prompt": "not json"}) == ("none", {})

    def test_prompt_is_a_list(self):
        assert image_meta.parse_generation_meta({"prompt": "[1,2]"}) == ("none", {})

    def test_prompt_with_wrong_value_types(self):
        source, summary = image_meta.parse_generation_meta({"prompt": '{"1": {"class_type": 5}}'})
        assert (source, summary) == ("none", {})

    def test_ui_graph_only_yields_prompts_without_numbers(self):
        source, summary = _parse(_ui_workflow("a cat", "blurry"), key="workflow")
        assert source == "comfyui"
        # The KSampler's widgets_values hold seed/steps/cfg, deliberately unread:
        # the array is positional with no names, so index -> field mislabels
        # across frontend versions. An absent seed is honest, a wrong one is not.
        assert summary == {"positive": "a cat", "negative": "blurry"}

    def test_ui_graph_roles_come_from_the_links_not_the_fill_state(self):
        """The UI format names its sockets and keeps its wiring in ``links``, so
        the roles are readable there too — no "the non-empty one is the positive"
        guess, which reported this graph's negative as its prompt."""
        _source, summary = _parse(_ui_workflow("", "ugly, deformed"), key="workflow")
        assert summary == {"positive": "", "negative": "ugly, deformed"}

    def test_ui_graph_without_links_omits_the_prompts(self):
        """A workflow whose links were stripped (or a serialiser shape we do not
        recognise) yields no roles at all — still ``comfyui``, since the
        container really did carry a workflow."""
        workflow = _ui_workflow("a cat", "blurry")
        workflow["links"] = []
        source, summary = _parse(workflow, key="workflow")
        assert (source, summary) == ("comfyui", {})

    def test_ui_graph_object_form_links_are_understood(self):
        workflow = _ui_workflow("a cat", "blurry")
        workflow["links"] = [
            {"id": lid, "origin_id": src, "origin_slot": slot}
            for lid, src, slot, _tgt, _tslot, _type in workflow["links"]
        ]
        _source, summary = _parse(workflow, key="workflow")
        assert summary == {"positive": "a cat", "negative": "blurry"}

    def test_ui_graph_ignores_a_loader_string_reachable_from_the_encoder(self):
        """The encoder's text is a converted input here, so the walk continues
        past it — through ``clip`` to the checkpoint loader, whose
        ``widgets_values[0]`` is also a bare leading string. Only text-ish node
        types may contribute text, or the ckpt name lands in the prompt row."""
        workflow = _ui_workflow("a cat", "blurry")
        for node in workflow["nodes"]:
            if node["id"] == 6:  # the positive encoder
                node["widgets_values"] = []
                node["inputs"].append({"name": "text", "type": "STRING", "link": 20})
        workflow["links"].append([20, 4, 0, 6, 1, "STRING"])
        _source, summary = _parse(workflow, key="workflow")
        assert "positive" not in summary
        assert summary["negative"] == "blurry"

    def test_ui_graph_sampler_custom_advanced_resolves_through_the_guider(self):
        """The UI form of a Flux/SD3 workflow: the sampler holds no conditioning
        at all, only a ``guider`` link. Reusing _cond_inputs over the
        reconstructed graph is what keeps the two prompts apart here as well."""
        workflow = _ui_workflow("a cat", "blurry")
        for node in workflow["nodes"]:
            if node["id"] == 3:
                node["type"] = "SamplerCustomAdvanced"
                node["inputs"] = [{"name": "guider", "type": "GUIDER", "link": 7}]
                node["widgets_values"] = []
        workflow["nodes"].append(
            {
                "id": 8,
                "type": "CFGGuider",
                "inputs": [
                    {"name": "positive", "type": "CONDITIONING", "link": 4},
                    {"name": "negative", "type": "CONDITIONING", "link": 6},
                ],
                "widgets_values": [3.5],
            }
        )
        workflow["links"].append([7, 8, 0, 3, 0, "GUIDER"])
        _source, summary = _parse(workflow, key="workflow")
        assert summary == {"positive": "a cat", "negative": "blurry"}

    def test_ui_graph_used_when_prompt_unparsable(self):
        source, summary = image_meta.parse_generation_meta(
            {"prompt": "not json", "workflow": json.dumps(_ui_workflow("only", "neg"))}
        )
        assert (source, summary) == ("comfyui", {"positive": "only", "negative": "neg"})


# ---------- the endpoint ---------------------------------------------


class _FakeGetRequest:
    """Stand-in for a GET aiohttp.web.Request — /metadata reads .rel_url.query."""

    def __init__(self, query):
        self.rel_url = SimpleNamespace(query=query)


A1111_PNG = _png(
    [
        IHDR,
        _text(
            b"parameters",
            b"a cat\nNegative prompt: blurry\n"
            b"Steps: 20, Sampler: Euler, CFG scale: 8, Seed: 5, Model: sd15",
        ),
        IDAT,
        IEND,
    ]
)


class TestMetadataEndpoint:
    def _call(self, query):
        return asyncio.run(ib.image_browser_metadata(_FakeGetRequest(query)))

    def test_non_image_extension_is_400_before_any_disk_touch(self, monkeypatch):
        """A 400 (not 404) for a file that doesn't exist is the proof that the
        IMG_EXTS gate runs before os.path.isfile — unlike /file, which stats an
        arbitrary caller-supplied path first."""

        def boom(_path):
            raise AssertionError("the extension gate must precede os.path.isfile")

        monkeypatch.setattr(os.path, "isfile", boom)
        resp = self._call({"path": "/nonexistent/a.txt"})
        assert resp.status == 400
        assert resp._body["error"] == "unsupported file type"

    def test_missing_image_is_404(self):
        resp = self._call({"path": "/nonexistent/a.png"})
        assert resp.status == 404
        assert resp._body["error"] == "file not found"

    def test_missing_path_is_400(self):
        resp = self._call({})
        assert resp.status == 400
        assert "missing path" in resp._body["error"]

    def test_traversal_name_is_400(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        resp = self._call({"type": "input", "name": "../x.png"})
        assert resp.status == 400
        assert "invalid name" in resp._body["error"]

    def test_subfolder_escape_is_400(self, tmp_path, monkeypatch):
        root = tmp_path / "root"
        root.mkdir()
        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(root), raising=False
        )
        resp = self._call({"type": "temp", "subfolder": "../out", "name": "a.png"})
        assert resp.status == 400
        assert "escapes root" in resp._body["error"]

    def test_happy_path_mode(self, tmp_path):
        (tmp_path / "a.png").write_bytes(A1111_PNG)
        resp = self._call({"path": str(tmp_path / "a.png")})
        assert resp.status == 200
        body = resp._body
        assert body["ok"] is True
        assert body["format"] == "png"
        assert body["source"] == "a1111"
        assert body["summary"]["seed"] == "5"
        assert body["truncated"] is False
        assert "parameters" in body["raw"]

    def test_happy_path_sandboxed(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        (tmp_path / "a.png").write_bytes(A1111_PNG)
        resp = self._call({"type": "output", "subfolder": "", "name": "a.png"})
        assert resp.status == 200
        assert resp._body["source"] == "a1111"
        assert resp._body["summary"]["negative"] == "blurry"

    def test_image_without_a_parser_is_200_and_empty(self, tmp_path):
        (tmp_path / "a.gif").write_bytes(b"GIF89a" + b"\x00" * 16)
        resp = self._call({"path": str(tmp_path / "a.gif")})
        assert resp.status == 200
        assert resp._body["format"] == ""
        assert resp._body["source"] == "none"
        assert resp._body["raw"] == {}

    def test_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(r.method == "GET" and r.path == "/image_browser/metadata" for r in registered)


# ---------- Video containers ------------------------------------------


VIDEO_GRAPH_JSON = json.dumps(FULL_GRAPH)
UI_WORKFLOW_JSON = json.dumps({"nodes": [{"id": 1, "type": "KSampler"}], "links": []})


class TestIsobmffRaw:
    """MP4/MOV — the `keys`+`ilst` form core SaveVideo writes."""

    def test_indexed_keys_round_trip(self, tmp_path):
        data = _mp4(
            _indexed_item(1, VIDEO_GRAPH_JSON.encode())
            + _indexed_item(2, UI_WORKFLOW_JSON.encode()),
            keys=[b"prompt", b"workflow"],
        )
        raw, truncated = _read(tmp_path, "a.mp4", data)
        assert raw["prompt"] == VIDEO_GRAPH_JSON
        assert raw["workflow"] == UI_WORKFLOW_JSON
        assert truncated is False

    def test_moov_after_a_large_mdat_is_still_found(self, tmp_path):
        """The builder puts mdat first, as real outputs do. A prefix-scan parser
        (which is what ComfyUI's frontend does, bounded at 64 MB) depends on the
        file being small enough; seeking by declared box size does not."""
        data = _mp4(
            _indexed_item(1, b'{"1": {"class_type": "X", "inputs": {}}}'), keys=[b"prompt"]
        )
        assert data.index(b"mdat") < data.index(b"moov")
        raw, _t = _read(tmp_path, "a.mp4", data)
        assert "prompt" in raw

    def test_mov_and_m4v_use_the_same_reader(self, tmp_path):
        data = _mp4(_indexed_item(1, b"hello"), keys=[b"prompt"])
        for name in ("a.mov", "a.m4v"):
            raw, _t = _read(tmp_path, name, data)
            assert raw["prompt"] == "hello"

    def test_key_case_is_normalised(self, tmp_path):
        """The graph lookup downstream keys on lowercase `prompt`/`workflow`."""
        raw, _t = _read(tmp_path, "a.mp4", _mp4(_indexed_item(1, b"x"), keys=[b"WORKFLOW"]))
        assert raw == {"workflow": "x"}

    def test_missing_ftyp_reads_nothing(self, tmp_path):
        data = _mp4(_indexed_item(1, b"x"), keys=[b"prompt"], ftyp=False)
        assert _read(tmp_path, "a.mp4", data) == ({}, False)

    def test_unknown_index_without_a_keys_box_is_skipped(self, tmp_path):
        """An index that names nothing must not invent a key. `\x00\x00\x00\x01`
        is not printable, so it is dropped rather than becoming a raw entry."""
        assert _read(tmp_path, "a.mp4", _mp4(_indexed_item(1, b"x"))) == ({}, False)

    def test_truncated_box_yields_what_was_readable(self, tmp_path):
        full = _mp4(_indexed_item(1, b"value"), keys=[b"prompt"])
        raw, _t = _read(tmp_path, "a.mp4", full[: len(full) - 3])
        assert raw == {}  # never raises; a clipped box simply stops the walk

    def test_value_is_capped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(image_meta, "MAX_VALUE_BYTES", 16)
        data = _mp4(_indexed_item(1, b"y" * 500), keys=[b"prompt"])
        raw, truncated = _read(tmp_path, "a.mp4", data)
        assert len(raw["prompt"]) == 16
        assert truncated is True


class TestIsobmffAtoms:
    """MP4 — the bare `©cmt` atom form kijai's writers use (no `keys` box).

    This is the layout ComfyUI's own parser bails on, and 26% of the videos on
    the reference install are written this way.
    """

    def _envelope(self) -> bytes:
        return json.dumps({"prompt": VIDEO_GRAPH_JSON, "workflow": UI_WORKFLOW_JSON}).encode()

    def test_comment_envelope_is_unwrapped(self, tmp_path):
        raw, _t = _read(tmp_path, "a.mp4", _mp4(_atom_item(b"\xa9cmt", self._envelope())))
        assert raw["prompt"] == VIDEO_GRAPH_JSON
        assert raw["workflow"] == UI_WORKFLOW_JSON
        # The envelope is kept: it is genuinely what the writer stored, and the
        # raw view is a verbatim report of the file.
        assert "comment" in raw

    def test_unwrapped_envelope_parses_into_a_summary(self, tmp_path):
        """The point of unwrapping: a graph left inside the envelope is invisible
        to parse_generation_meta, which looks for one AT a GRAPH_KEYS slot."""
        raw, _t = _read(tmp_path, "a.mp4", _mp4(_atom_item(b"\xa9cmt", self._envelope())))
        source, summary = image_meta.parse_generation_meta(raw)
        assert source == "comfyui"
        assert summary["seed"] == "123456789"

    def test_a_plain_human_comment_is_left_alone(self, tmp_path):
        raw, _t = _read(tmp_path, "a.mp4", _mp4(_atom_item(b"\xa9cmt", b"shot on a phone")))
        assert raw == {"comment": "shot on a phone"}

    def test_json_comment_without_graph_keys_adds_nothing(self, tmp_path):
        data = _mp4(_atom_item(b"\xa9cmt", b'{"camera": "a7iv"}'))
        raw, _t = _read(tmp_path, "a.mp4", data)
        assert set(raw) == {"comment"}

    def test_a_native_tag_is_never_overridden_by_the_envelope(self, tmp_path):
        """Both forms present: the real tag wins, because it is the one the
        writer addressed deliberately rather than a value lifted out of a blob."""
        envelope = json.dumps({"workflow": "from-envelope"}).encode()
        data = _mp4(
            _indexed_item(1, b"from-native-tag") + _atom_item(b"\xa9cmt", envelope),
            keys=[b"workflow"],
        )
        raw, _t = _read(tmp_path, "a.mp4", data)
        assert raw["workflow"] == "from-native-tag"

    def test_known_atoms_get_readable_names(self, tmp_path):
        data = _mp4(_atom_item(b"\xa9nam", b"a title") + _atom_item(b"\xa9too", b"Lavf62"))
        raw, _t = _read(tmp_path, "a.mp4", data)
        assert raw == {"title": "a title", "encoder": "Lavf62"}


class TestMatroskaRaw:
    """WebM/MKV — SimpleTag name/value pairs."""

    def test_uppercase_tags_are_lowercased(self, tmp_path):
        """Matroska tag names are conventionally upper — that is a container
        convention, not something the writer chose, so it must not decide
        whether the graph is findable."""
        data = _webm(
            _simple_tag(b"WORKFLOW", UI_WORKFLOW_JSON.encode())
            + _simple_tag(b"PROMPT", VIDEO_GRAPH_JSON.encode())
        )
        raw, truncated = _read(tmp_path, "a.webm", data)
        assert raw["workflow"] == UI_WORKFLOW_JSON
        assert raw["prompt"] == VIDEO_GRAPH_JSON
        assert truncated is False

    def test_tags_after_a_cluster_are_found(self, tmp_path):
        """The Cluster is skipped by its declared size, so tags written after the
        media data are still reached."""
        data = _webm(_simple_tag(b"PROMPT", b'{"1": {"class_type": "X", "inputs": {}}}'))
        assert data.index(b"PROMPT") > 4096
        raw, _t = _read(tmp_path, "a.webm", data)
        assert "prompt" in raw

    def test_mkv_uses_the_same_reader(self, tmp_path):
        raw, _t = _read(tmp_path, "a.mkv", _webm(_simple_tag(b"PROMPT", b"x")))
        assert raw == {"prompt": "x"}

    def test_comment_envelope_is_unwrapped(self, tmp_path):
        envelope = json.dumps({"prompt": VIDEO_GRAPH_JSON}).encode()
        raw, _t = _read(tmp_path, "a.webm", _webm(_simple_tag(b"COMMENT", envelope)))
        assert raw["prompt"] == VIDEO_GRAPH_JSON
        source, _summary = image_meta.parse_generation_meta(raw)
        assert source == "comfyui"

    def test_not_matroska_reads_nothing(self, tmp_path):
        assert _read(tmp_path, "a.webm", b"NOTEBML" + b"\x00" * 64) == ({}, False)

    def test_truncated_element_yields_what_was_readable(self, tmp_path):
        full = _webm(_simple_tag(b"PROMPT", b"value"))
        raw, _t = _read(tmp_path, "a.webm", full[: len(full) - 3])
        assert raw == {}

    def test_deep_nesting_does_not_recurse_without_bound(self, tmp_path):
        """EBML is self-describing with no structural end marker, so a crafted
        file can nest SimpleTags arbitrarily. The depth cap must turn that into
        a bounded read, not a RecursionError on the event loop."""
        payload = _simple_tag(b"PROMPT", b"deep")
        for _ in range(200):
            payload = _elem(image_meta.EBML_ID_SIMPLE_TAG, payload)
        raw, truncated = _read(tmp_path, "a.webm", _webm(payload))
        assert raw == {}
        assert truncated is True

    def test_value_is_capped(self, tmp_path, monkeypatch):
        monkeypatch.setattr(image_meta, "MAX_VALUE_BYTES", 16)
        raw, truncated = _read(tmp_path, "a.webm", _webm(_simple_tag(b"PROMPT", b"z" * 500)))
        assert len(raw["prompt"]) == 16
        assert truncated is True


class TestVideoMetadataGate:
    """The /metadata perimeter, and the frontend mirror of it."""

    def _call(self, query):
        return asyncio.run(ib.image_browser_metadata(_FakeGetRequest(query)))

    def test_readable_video_answers_200_with_a_summary(self, tmp_path):
        data = _mp4(_indexed_item(1, VIDEO_GRAPH_JSON.encode()), keys=[b"prompt"])
        (tmp_path / "clip.mp4").write_bytes(data)
        resp = self._call({"path": str(tmp_path / "clip.mp4")})
        assert resp.status == 200
        assert resp._body["format"] == "mp4"
        assert resp._body["source"] == "comfyui"
        assert resp._body["summary"]["seed"] == "123456789"

    def test_container_without_a_reader_is_400_before_any_disk_touch(self, monkeypatch):
        """.avi is in VIDEO_EXTS — it lists and previews — but has no reader, so
        the endpoint rejects it and the frontend withholds the ⓘ / ⤓ buttons.
        A 400 for a path that does not exist proves the gate precedes isfile."""

        def boom(_path):
            raise AssertionError("the extension gate must precede os.path.isfile")

        monkeypatch.setattr(os.path, "isfile", boom)
        resp = self._call({"path": "/nonexistent/clip.avi"})
        assert resp.status == 400
        assert resp._body["error"] == "unsupported file type"

    def test_images_without_a_parser_still_pass_the_gate(self, tmp_path):
        """Widening the gate to video must not narrow it for images: every
        IMG_EXTS member is still accepted, answering 200 + empty."""
        assert ".gif" in ib.METADATA_EXTS
        assert ".tif" in ib.METADATA_EXTS

    def test_frontend_mirror_matches_the_backend_gate(self):
        """The ⓘ / ⤓ buttons are gated client-side by META_VIDEO_EXTS in
        src/api.ts. The backend derives its own set from image_meta.FORMAT_EXTS,
        so the two can silently drift — and a drifted mirror ships a control that
        is present here and rejected there. Read the literal back out of the
        source rather than trusting a comment to keep them aligned."""
        src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "api.ts").read_text(
            encoding="utf-8"
        )
        match = re.search(r"export const META_VIDEO_EXTS = new Set\(\[(.*?)\]\)", src, re.S)
        assert match, "META_VIDEO_EXTS literal not found in src/api.ts"
        frontend = set(re.findall(r'"(\.[a-z0-9]+)"', match.group(1)))
        backend = ib.VIDEO_EXTS & set(image_meta.FORMAT_EXTS)
        assert frontend == backend


# Imported at the bottom so the class above can reference the stubbed server
# without leaking the import into the pure-helper tests above.
from server import PromptServer  # noqa: E402
