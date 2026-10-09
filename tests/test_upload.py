"""POST /image_browser/upload — the most write-shaped request in the pack.

Every test drives the REAL registered handler against a tmp dir standing in for
a sandboxed root (``folder_paths`` stubbed, the same way tests/test_helpers.py
drives /mkdir). aiohttp is stubbed by conftest, so the multipart body is a
small fake reader with the two methods the handler uses — ``reader.next()`` and
``part.read_chunk()`` — whose names and semantics were checked against
aiohttp 3.11's ``MultipartReader`` / ``BodyPartReader``.

The fake counts the bytes each part handed out. That count is how "rejected
before anything touches disk" is asserted rather than assumed: a refused part
must never have been READ, and no file of any name (a ``.part`` temp included)
may exist afterwards.

Security controls are two-sided in the same test where that is possible — a
refusal is paired with the same request shape succeeding — because a handler
hard-wired to refuse everything passes every one-sided negative here.
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import pytest

import image_browser as ib

UPLOAD_HEADERS = {
    "Content-Type": "multipart/form-data; boundary=----x",
    ib.UPLOAD_HEADER: "1",
    "Sec-Fetch-Site": "same-origin",
    "Origin": "http://127.0.0.1:8188",
    "Host": "127.0.0.1:8188",
}


class _Part:
    """One multipart part. ``filename`` None means a plain form field."""

    def __init__(self, name, data=b"", filename=None):
        self.name = name
        self.filename = filename
        self._data = data if isinstance(data, bytes) else data.encode()
        self.consumed = 0

    async def read_chunk(self, size=8192):
        # Hand out at most 3 bytes at a time so the streaming loop really loops.
        chunk = self._data[self.consumed : self.consumed + min(size, 3)]
        self.consumed += len(chunk)
        return chunk


class _Reader:
    def __init__(self, parts):
        self._parts = list(parts)

    async def next(self):
        return self._parts.pop(0) if self._parts else None


def _field(name, value):
    return _Part(name, value)


def _file(filename, data=b"\x89PNG-bytes"):
    return _Part("file", data, filename=filename)


def _request(parts, headers=None, settings=None):
    reader = _Reader(parts)

    async def multipart():
        return reader

    req = SimpleNamespace(
        headers=dict(UPLOAD_HEADERS if headers is None else headers), multipart=multipart
    )
    if settings is not None:
        req.comfy_settings = dict(settings)
    return req


def _upload(parts, **kw):
    return asyncio.run(ib.image_browser_upload(_request(parts, **kw)))


def _dest(type_name="input", subfolder=""):
    return [_field("type", type_name), _field("subfolder", subfolder)]


@pytest.fixture
def root(tmp_path, monkeypatch):
    import folder_paths

    sandbox = tmp_path / "input"
    sandbox.mkdir()
    monkeypatch.setattr(
        folder_paths, "get_directory_by_type", lambda t: str(sandbox), raising=False
    )
    return sandbox


def _all_files(path):
    return sorted(
        os.path.relpath(os.path.join(d, f), path) for d, _dirs, fs in os.walk(path) for f in fs
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestUploadLands:
    def test_files_land_in_the_current_folder_with_their_bytes(self, root):
        (root / "album").mkdir()
        resp = _upload(
            [*_dest("input", "album"), _file("a.png", b"AAAA"), _file("b.webm", b"BBBBBBB")]
        )
        assert resp.status == 200
        assert resp._body["ok"] is True
        assert resp._body["uploaded"] == ["a.png", "b.webm"]
        assert resp._body["errors"] == []
        assert (root / "album" / "a.png").read_bytes() == b"AAAA"
        assert (root / "album" / "b.webm").read_bytes() == b"BBBBBBB"
        # No temp file is left beside them.
        assert _all_files(root) == ["album/a.png", "album/b.webm"]

    def test_the_root_itself_is_a_valid_destination(self, root):
        resp = _upload([*_dest("input", ""), _file("top.jpg", b"J")])
        assert resp._body["ok"] is True
        assert (root / "top.jpg").read_bytes() == b"J"

    def test_a_missing_subfolder_field_means_the_root(self, root):
        resp = _upload([_field("type", "input"), _file("top.jpg", b"J")])
        assert resp._body["ok"] is True
        assert (root / "top.jpg").is_file()


# ---------------------------------------------------------------------------
# The perimeter
# ---------------------------------------------------------------------------


class TestSandboxedTypesOnly:
    def test_type_path_is_refused_before_any_part_is_read(self, root):
        """ADR-0002: an upload must not be the write that widens the perimeter.
        Paired with the identical request against a sandboxed type succeeding."""
        part = _file("a.png", b"AAAA")
        resp = _upload([*_dest("path", str(root)), part])
        assert resp.status == 400
        assert "input/output/temp" in resp._body["error"]
        assert part.consumed == 0
        assert _all_files(root) == []

        ok = _upload([*_dest("input", ""), _file("a.png", b"AAAA")])
        assert ok._body["ok"] is True

    @pytest.mark.parametrize("bad", ["models", "", "../input"])
    def test_any_other_type_is_refused(self, root, bad):
        part = _file("a.png")
        resp = _upload([*_dest(bad, ""), part])
        assert resp.status == 400
        assert part.consumed == 0
        assert _all_files(root) == []

    def test_a_file_before_the_type_field_is_refused(self, root):
        """The destination has to be known before a byte is streamed; a body that
        names it afterwards is refused outright rather than buffered."""
        part = _file("a.png")
        resp = _upload([part, *_dest("input", "")])
        assert resp.status == 400
        assert part.consumed == 0
        assert _all_files(root) == []

    def test_a_destination_field_after_a_file_is_refused(self, root):
        """Changing the destination mid-body would let the first files land in one
        folder and the rest in another — refused, not honoured."""
        resp = _upload([*_dest("input", ""), _file("a.png"), _field("subfolder", "elsewhere")])
        assert resp.status == 400

    def test_a_subfolder_that_escapes_the_root_is_refused(self, root):
        part = _file("a.png")
        resp = _upload([*_dest("input", "../.."), part])
        assert resp.status == 400
        assert part.consumed == 0
        assert _all_files(root.parent) == []

    def test_a_missing_subfolder_answers_404(self, root):
        part = _file("a.png")
        resp = _upload([*_dest("input", "nope"), part])
        assert resp.status == 404
        assert part.consumed == 0
        assert not (root / "nope").exists()

    def test_no_file_parts_is_a_400(self, root):
        resp = _upload(_dest("input", ""))
        assert resp.status == 400
        assert resp._body["ok"] is False


class TestFilenames:
    @pytest.mark.parametrize(
        ("sent", "landed"),
        [
            ("C:\\fakepath\\photo.png", "photo.png"),
            ("C:\\Users\\me\\Pictures\\photo.png", "photo.png"),
            ("/storage/emulated/0/DCIM/Camera/IMG_0001.jpg", "IMG_0001.jpg"),
            ("/private/var/mobile/tmp/IMG_0002.mp4", "IMG_0002.mp4"),
        ],
    )
    def test_a_full_device_path_is_basenamed_into_the_current_folder(self, root, sent, landed):
        resp = _upload([*_dest("input", ""), _file(sent, b"X")])
        assert resp._body["uploaded"] == [landed]
        assert _all_files(root) == [landed]

    @pytest.mark.parametrize(
        "sent",
        [
            "../escape.png",
            "..\\..\\escape.png",
            "sub/../../escape.png",
            "C:\\x\\..\\..\\escape.png",
        ],
    )
    def test_a_traversing_filename_is_refused_not_basenamed(self, root, sent):
        """A browser never sends `..` segments, so one is intent, not a device
        path — refusing it is the honest answer. Paired with a clean name in the
        same request landing, so the refusal is not a refuse-everything handler."""
        bad = _file(sent, b"EVIL")
        resp = _upload([*_dest("input", ""), bad, _file("fine.png", b"OK")])
        assert resp._body["uploaded"] == ["fine.png"]
        assert [e["name"] for e in resp._body["errors"]] == [sent]
        assert resp._body["errors"][0]["status"] == 400
        assert bad.consumed == 0
        assert _all_files(root.parent) == ["input/fine.png"]

    @pytest.mark.parametrize("sent", ["", ".", "..", "dir/", "C:\\fakepath\\", "a\x00.png"])
    def test_a_name_with_no_bare_basename_is_refused(self, root, sent):
        bad = _file(sent)
        resp = _upload([*_dest("input", ""), bad, _file("fine.png")])
        assert resp._body["uploaded"] == ["fine.png"]
        assert len(resp._body["errors"]) == 1
        assert bad.consumed == 0
        assert _all_files(root) == ["fine.png"]

    @pytest.mark.parametrize("sent", ["evil.sh", "photo.heic", "page.html", "noext", "x.png.exe"])
    def test_a_disallowed_extension_is_refused_before_a_byte_is_read(self, root, sent):
        bad = _file(sent, b"#!/bin/sh")
        resp = _upload([*_dest("input", ""), bad, _file("ok.png", b"P")])
        assert resp._body["uploaded"] == ["ok.png"]
        assert resp._body["errors"] == [
            {"name": sent, "error": "unsupported file type", "status": 400}
        ]
        assert bad.consumed == 0
        assert _all_files(root) == ["ok.png"]

    def test_the_extension_is_read_case_insensitively_from_the_SERVER_side_name(self, root):
        resp = _upload([*_dest("input", ""), _file("SHOUT.PNG", b"P")])
        assert resp._body["uploaded"] == ["SHOUT.PNG"]


class TestNeverClobber:
    def test_an_existing_name_answers_409_naming_it_and_the_file_is_unchanged(self, root):
        (root / "taken.png").write_bytes(b"ORIGINAL")
        part = _file("taken.png", b"NEW")
        resp = _upload([*_dest("input", ""), part])
        assert resp.status == 409
        assert resp._body["ok"] is False
        assert "taken.png" in resp._body["error"]
        assert resp._body["errors"] == [
            {"name": "taken.png", "error": resp._body["error"], "status": 409}
        ]
        assert (root / "taken.png").read_bytes() == b"ORIGINAL"
        assert part.consumed == 0
        assert _all_files(root) == ["taken.png"]

    def test_an_existing_FOLDER_of_that_name_is_a_collision_too(self, root):
        (root / "clip.mp4").mkdir()
        resp = _upload([*_dest("input", ""), _file("clip.mp4")])
        assert resp.status == 409
        assert (root / "clip.mp4").is_dir()

    def test_the_same_name_twice_in_one_request_lands_once(self, root):
        resp = _upload([*_dest("input", ""), _file("dup.png", b"ONE"), _file("dup.png", b"TWO")])
        assert resp._body["uploaded"] == ["dup.png"]
        assert resp._body["errors"][0]["status"] == 409
        assert (root / "dup.png").read_bytes() == b"ONE"

    def test_a_file_that_appears_DURING_the_stream_is_still_not_clobbered(self, root):
        """The existence check before streaming is a fast path, not the guard: the
        placement itself must refuse an existing target, or a file created while
        the bytes were in flight is silently overwritten."""
        late = root / "race.png"

        class _Racing(_Part):
            async def read_chunk(self, size=8192):
                if not late.exists():
                    late.write_bytes(b"ARRIVED")
                return await super().read_chunk(size)

        resp = _upload([*_dest("input", ""), _Racing("file", b"MINE", filename="race.png")])
        assert resp.status == 409
        assert late.read_bytes() == b"ARRIVED"
        assert _all_files(root) == ["race.png"]

    def test_without_hard_links_the_fallback_still_refuses_to_clobber(self, root, monkeypatch):
        """FAT/exFAT and some network mounts have no link(2). The fallback must
        place the file there AND keep the no-clobber guarantee."""

        def no_links(src, dst):
            raise PermissionError(1, "Operation not permitted")

        monkeypatch.setattr(ib.os, "link", no_links)
        resp = _upload([*_dest("input", ""), _file("fresh.png", b"F")])
        assert resp._body["uploaded"] == ["fresh.png"]
        assert (root / "fresh.png").read_bytes() == b"F"
        assert _all_files(root) == ["fresh.png"]

        late = root / "race.png"

        class _Racing(_Part):
            async def read_chunk(self, size=8192):
                if not late.exists():
                    late.write_bytes(b"ARRIVED")
                return await super().read_chunk(size)

        resp = _upload([*_dest("input", ""), _Racing("file", b"MINE", filename="race.png")])
        assert resp.status == 409
        assert late.read_bytes() == b"ARRIVED"
        assert _all_files(root) == ["fresh.png", "race.png"]

    def test_a_temp_name_that_already_exists_is_never_deleted(self, root, monkeypatch):
        """The temp file is removed in a `finally` — which must only ever remove a
        file THIS upload created. A colliding temp name fails the exclusive
        create, and the file already holding that name is someone else's."""
        monkeypatch.setattr(ib.secrets, "token_hex", lambda n: "fixed")
        squatter = root / ".ib-upload-fixed.part"
        squatter.write_bytes(b"NOT MINE")
        resp = _upload([*_dest("input", ""), _file("a.png", b"A")])
        assert resp._body["ok"] is False
        assert resp._body["errors"][0]["status"] == 500
        assert squatter.read_bytes() == b"NOT MINE"
        assert not (root / "a.png").exists()

        # Same request once the name is free: it lands and leaves no temp behind.
        squatter.unlink()
        ok = _upload([*_dest("input", ""), _file("a.png", b"A")])
        assert ok._body["uploaded"] == ["a.png"]
        assert _all_files(root) == ["a.png"]


class TestBounds:
    def test_an_oversized_part_is_refused_and_leaves_nothing_behind(self, root, monkeypatch):
        monkeypatch.setattr(ib, "_max_upload_bytes", lambda: 5)
        resp = _upload(
            [*_dest("input", ""), _file("big.png", b"0123456789"), _file("small.png", b"01234")]
        )
        assert resp._body["uploaded"] == ["small.png"]
        assert resp._body["errors"][0]["name"] == "big.png"
        assert resp._body["errors"][0]["status"] == 413
        # Exactly at the cap lands; one byte over does not — and no .part remains.
        assert _all_files(root) == ["small.png"]

    def test_parts_past_the_per_request_cap_are_reported_not_written(self, root, monkeypatch):
        monkeypatch.setattr(ib, "MAX_UPLOAD_FILES", 2)
        extra = _file("c.png")
        resp = _upload([*_dest("input", ""), _file("a.png"), _file("b.png"), extra])
        assert resp._body["uploaded"] == ["a.png", "b.png"]
        assert resp._body["errors"][0]["name"] == "c.png"
        assert extra.consumed == 0
        assert _all_files(root) == ["a.png", "b.png"]

    def test_an_overlong_form_field_is_refused(self, root):
        resp = _upload(
            [_field("type", "input"), _field("subfolder", "a" * 10_000), _file("a.png")]
        )
        assert resp.status == 400
        assert _all_files(root) == []

    def test_the_cap_follows_comfyuis_own_max_upload_size(self, monkeypatch):
        import sys
        import types

        cli = types.ModuleType("comfy.cli_args")
        cli.args = SimpleNamespace(max_upload_size=3)
        comfy = types.ModuleType("comfy")
        comfy.cli_args = cli
        monkeypatch.setitem(sys.modules, "comfy", comfy)
        monkeypatch.setitem(sys.modules, "comfy.cli_args", cli)
        assert ib._max_upload_bytes() == 3 * 1024 * 1024

        cli.args = SimpleNamespace(max_upload_size=float("nan"))
        assert ib._max_upload_bytes() == ib.DEFAULT_MAX_UPLOAD_MB * 1024 * 1024

    def test_without_comfyui_the_cap_is_comfyuis_default(self, monkeypatch):
        import sys

        monkeypatch.setitem(sys.modules, "comfy.cli_args", None)
        assert ib._max_upload_bytes() == ib.DEFAULT_MAX_UPLOAD_MB * 1024 * 1024


class TestPartialFailure:
    def test_a_mixed_batch_lands_the_good_parts_and_reports_the_bad(self, root):
        """The phone multi-select case: a .heic beside four images. The four land;
        the response is still ok:true with per-item errors, the /delete_many
        contract."""
        (root / "exists.png").write_bytes(b"KEEP")
        resp = _upload(
            [
                *_dest("input", ""),
                _file("one.png", b"1"),
                _file("IMG_1234.HEIC", b"heic"),
                _file("exists.png", b"NEW"),
                _file("../up.png", b"x"),
                _file("two.jpg", b"2"),
            ]
        )
        assert resp.status == 200
        assert resp._body["ok"] is True
        assert resp._body["uploaded"] == ["one.png", "two.jpg"]
        assert [(e["name"], e["status"]) for e in resp._body["errors"]] == [
            ("IMG_1234.HEIC", 400),
            ("exists.png", 409),
            ("../up.png", 400),
        ]
        assert (root / "exists.png").read_bytes() == b"KEEP"
        assert _all_files(root.parent) == ["input/exists.png", "input/one.png", "input/two.jpg"]

    def test_when_nothing_lands_for_MIXED_reasons_the_status_is_400(self, root):
        (root / "exists.png").write_bytes(b"KEEP")
        resp = _upload([*_dest("input", ""), _file("x.heic"), _file("exists.png")])
        assert resp.status == 400
        assert resp._body["ok"] is False
        assert len(resp._body["errors"]) == 2


class TestSymlinkContainment:
    def test_an_escaping_symlinked_subfolder_is_refused_and_a_real_one_is_not(
        self, root, tmp_path
    ):
        outside = tmp_path / "outside"
        outside.mkdir()
        (root / "link").symlink_to(outside, target_is_directory=True)
        (root / "real").mkdir()

        resp = _upload([*_dest("input", "link"), _file("a.png")])
        assert resp._body["ok"] is False
        assert list(outside.iterdir()) == []

        ok = _upload([*_dest("input", "real"), _file("a.png")])
        assert ok._body["ok"] is True
        assert (root / "real" / "a.png").is_file()

    def test_the_symlinked_subfolder_opt_in_is_honoured(self, root, tmp_path):
        outside = tmp_path / "nas"
        outside.mkdir()
        (root / "renders").symlink_to(outside, target_is_directory=True)
        resp = _upload(
            [*_dest("input", "renders"), _file("a.png")],
            settings={ib.SETTING_ALLOW_LINKED_SUBFOLDER_WRITES: True},
        )
        assert resp._body["ok"] is True
        assert (outside / "a.png").is_file()


# ---------------------------------------------------------------------------
# The request gate
# ---------------------------------------------------------------------------


class TestUploadGate:
    """Multipart is a CORS-SIMPLE content type — a cross-origin <form> can send it
    with no preflight — so the JSON requirement every other POST leans on cannot
    apply here. The custom header takes its place: a form cannot set one, and a
    cross-origin fetch that does needs a preflight this server never grants."""

    def test_multipart_with_the_header_is_accepted_and_without_it_is_refused(self):
        assert ib._reject_non_upload(SimpleNamespace(headers=dict(UPLOAD_HEADERS))) is None
        bare = {k: v for k, v in UPLOAD_HEADERS.items() if k != ib.UPLOAD_HEADER}
        resp = ib._reject_non_upload(SimpleNamespace(headers=bare))
        assert resp is not None
        assert resp.status == 415

    @pytest.mark.parametrize(
        "ctype", ["application/json", "text/plain", "application/x-www-form-urlencoded", ""]
    )
    def test_anything_but_multipart_is_refused_even_with_the_header(self, ctype):
        resp = ib._reject_non_upload(
            SimpleNamespace(headers={**UPLOAD_HEADERS, "Content-Type": ctype})
        )
        assert resp.status == 415

    def test_the_header_must_carry_the_expected_value(self):
        resp = ib._reject_non_upload(
            SimpleNamespace(headers={**UPLOAD_HEADERS, ib.UPLOAD_HEADER: "0"})
        )
        assert resp.status == 415

    def test_the_handler_is_gated_end_to_end(self, root):
        """Through the registered handler, both directions on one body."""
        bare = {k: v for k, v in UPLOAD_HEADERS.items() if k != ib.UPLOAD_HEADER}
        refused = _upload([*_dest("input", ""), _file("a.png")], headers=bare)
        assert refused.status == 415
        cross = _upload(
            [*_dest("input", ""), _file("a.png")],
            headers={**UPLOAD_HEADERS, "Sec-Fetch-Site": "cross-site"},
        )
        assert cross.status == 403
        assert _all_files(root) == []

        served = _upload([*_dest("input", ""), _file("a.png")])
        assert served._body["ok"] is True

    def test_the_json_gate_is_unchanged_for_every_other_post(self):
        """The upload gate is a second body gate, not a loosening of the first: a
        multipart body with the upload header still cannot reach /delete."""
        resp = asyncio.run(
            ib.image_browser_delete(SimpleNamespace(headers=dict(UPLOAD_HEADERS), json=None))
        )
        assert resp.status == 415

    def test_the_upload_route_is_registered_and_guarded(self):
        import server

        rows = [
            r
            for r in server.PromptServer.instance.routes.registered
            if r.path == "/image_browser/upload"
        ]
        assert [r.method for r in rows] == ["POST"]
        assert getattr(rows[0].handler, "image_browser_guarded", False) is True
