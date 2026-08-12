"""Unit tests for the pure/validation helpers in image_browser.

Focus on the security perimeter of the write endpoints: the resolver must reject
arbitrary-path writes, traversal in names, and non-media extensions BEFORE it
touches the (stubbed) folder_paths. Happy-path containment needs a real
folder_paths and is covered by the live smoke matrix.
"""

from __future__ import annotations

import asyncio
import json
import os
import zlib
from types import SimpleNamespace

import image_browser as ib
import image_meta
import safeview_store


class TestParseExtensions:
    def test_empty_defaults_to_all_media(self):
        assert ib._parse_extensions("") == ib.IMG_EXTS | ib.VIDEO_EXTS

    def test_normalizes_missing_dot_and_case(self):
        assert ib._parse_extensions("PNG,mp4") == {".png", ".mp4"}

    def test_whitespace_and_empties_ignored(self):
        assert ib._parse_extensions(" .jpg , , webp ") == {".jpg", ".webp"}


class TestIsBareName:
    def test_accepts_plain_filename(self):
        assert ib._is_bare_name("photo.png")

    def test_rejects_traversal_and_separators(self):
        assert not ib._is_bare_name("../secret.png")
        assert not ib._is_bare_name("sub/photo.png")
        assert not ib._is_bare_name("..")
        assert not ib._is_bare_name(".")

    def test_rejects_empty_and_non_str(self):
        assert not ib._is_bare_name("")
        assert not ib._is_bare_name(None)
        assert not ib._is_bare_name(5)


class TestResolveSandboxedFileRejections:
    """These all short-circuit before folder_paths is consulted."""

    def test_rejects_path_type(self):
        target, err = ib._resolve_sandboxed_file("path", "", "a.png")
        assert target is None
        assert "input/output/temp" in err

    def test_rejects_unknown_type(self):
        target, err = ib._resolve_sandboxed_file("models", "", "a.png")
        assert target is None
        assert "input/output/temp" in err

    def test_rejects_traversal_name(self):
        target, err = ib._resolve_sandboxed_file("input", "", "../etc/passwd")
        assert target is None
        assert err == "invalid name"

    def test_rejects_non_media_extension(self):
        target, err = ib._resolve_sandboxed_file("output", "", "payload.exe")
        assert target is None
        assert err == "unsupported file type"


class TestResolveSandboxedDir:
    """Folder-deletion resolver: same write perimeter as files, no extension gate."""

    def test_rejects_path_type(self):
        target, err = ib._resolve_sandboxed_dir("path", "", "subdir")
        assert target is None
        assert "input/output/temp" in err

    def test_rejects_unknown_type(self):
        target, err = ib._resolve_sandboxed_dir("models", "", "subdir")
        assert target is None
        assert "input/output/temp" in err

    def test_rejects_traversal_name(self):
        target, err = ib._resolve_sandboxed_dir("output", "", "../outside")
        assert target is None
        assert err == "invalid name"

    def test_rejects_empty_name(self):
        # An empty name would resolve to the root itself — must never delete it.
        target, err = ib._resolve_sandboxed_dir("output", "", "")
        assert target is None
        assert err == "invalid name"

    def test_accepts_extensionless_dir_name(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        target, err = ib._resolve_sandboxed_dir("output", "sub", "myfolder")
        assert err == ""
        assert target == str(tmp_path / "sub" / "myfolder")


class TestCountDirContents:
    def test_empty_dir(self, tmp_path):
        assert ib._count_dir_contents(str(tmp_path)) == (0, 0)

    def test_counts_nested_files_and_dirs(self, tmp_path):
        (tmp_path / "a.png").write_bytes(b"x")
        sub = tmp_path / "sub"
        deep = sub / "deep"
        deep.mkdir(parents=True)
        (sub / "b.png").write_bytes(b"x")
        (deep / "c.txt").write_bytes(b"x")
        assert ib._count_dir_contents(str(tmp_path)) == (3, 2)

    def test_symlinked_dir_not_followed(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.png").write_bytes(b"x")
        inner = tmp_path / "inner"
        inner.mkdir()
        (inner / "link").symlink_to(outside, target_is_directory=True)
        # The link counts as a single dir entry; its contents are not traversed.
        assert ib._count_dir_contents(str(inner)) == (0, 1)


class _FakeRequest:
    """Minimal stand-in for aiohttp.web.Request — /rmdir only reads .json()."""

    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class _FakeGetRequest:
    """Stand-in for a GET aiohttp.web.Request — /list reads .rel_url.query."""

    def __init__(self, query):
        self.rel_url = SimpleNamespace(query=query)


class TestListRecursive:
    """Drive the real /list handler in flat (recursive) mode against a tmp tree.

    /list is a GET reading .rel_url.query, so it needs the query-shaped fake
    above (not the json-body _FakeRequest the POST endpoints use)."""

    def _call(self, query):
        return asyncio.run(ib.image_browser_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def test_recursive_lists_descendants_with_subpath(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "top.png").write_bytes(b"x")
        deep = tmp_path / "sub" / "deep"
        deep.mkdir(parents=True)
        (deep / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["ok"] is True
        # Flat view returns files only — no folder cards.
        assert resp._body["dirs"] == []
        assert resp._body["truncated"] is False
        by_name = {f["name"]: f for f in resp._body["files"]}
        assert by_name["top.png"]["subpath"] == ""
        assert by_name["nested.png"]["subpath"] == "sub/deep"

    def test_non_recursive_is_single_level_without_subpath(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "top.png").write_bytes(b"x")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": ""})
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"top.png"}  # the nested file is not surfaced
        assert "subpath" not in resp._body["files"][0]
        assert [d["name"] for d in resp._body["dirs"]] == ["sub"]

    def test_recursive_prunes_hidden_and_pycache(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "keep.png").write_bytes(b"x")
        (tmp_path / ".hidden.png").write_bytes(b"x")
        cache = tmp_path / "__pycache__"
        cache.mkdir()
        (cache / "junk.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"keep.png"}

    def test_recursive_does_not_follow_symlinked_dir(self, tmp_path, monkeypatch):
        base = tmp_path / "root"
        base.mkdir()
        self._sandbox(base, monkeypatch)
        outside = tmp_path / "outside"  # sibling of base — reachable only via the link
        outside.mkdir()
        (outside / "secret.png").write_bytes(b"x")
        inner = base / "inner"
        inner.mkdir()
        (inner / "link").symlink_to(outside, target_is_directory=True)
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        names = {f["name"] for f in resp._body["files"]}
        assert "secret.png" not in names

    def test_recursive_ignored_for_path_type(self, tmp_path, monkeypatch):
        # recursive is a sandboxed-root affordance; type=path stays single-level.
        (tmp_path / "top.png").write_bytes(b"x")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "path", "path": str(tmp_path), "recursive": "1"})
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"top.png"}
        assert [d["name"] for d in resp._body["dirs"]] == ["sub"]

    def test_recursive_truncates_at_cap(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "FLAT_LIST_CAP", 3)
        for i in range(5):
            (tmp_path / f"f{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is True
        assert len(resp._body["files"]) == 3

    def test_truncation_keeps_the_newest_not_the_first_walked(self, tmp_path, monkeypatch):
        """The cap must bite by mtime, not by directory-walk order.

        The walk descends alphabetically, so a cap applied during the walk would
        return a/ and b/ and never reach z/ — silently hiding the newest file,
        which is the one thing the flat view exists to surface.
        """
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "FLAT_LIST_CAP", 2)
        for folder, name, mtime in (
            ("a", "oldest.png", 1000),
            ("b", "middle.png", 2000),
            ("z", "newest.png", 3000),
        ):
            d = tmp_path / folder
            d.mkdir()
            f = d / name
            f.write_bytes(b"x")
            os.utime(f, (mtime, mtime))

        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is True
        names = {f["name"] for f in resp._body["files"]}
        # The two newest survive; the alphabetically-first, oldest file is cut.
        assert names == {"newest.png", "middle.png"}
        assert "oldest.png" not in names
        # Subpaths still address the real nested folders.
        by_name = {f["name"]: f for f in resp._body["files"]}
        assert by_name["newest.png"]["subpath"] == "z"

    def test_untruncated_walk_covers_the_whole_subtree(self, tmp_path, monkeypatch):
        """Under the cap, nothing is dropped and truncated stays False."""
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "FLAT_LIST_CAP", 10)
        for folder in ("a", "m", "z"):
            d = tmp_path / folder
            d.mkdir()
            (d / f"{folder}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is False
        assert {f["name"] for f in resp._body["files"]} == {"a.png", "m.png", "z.png"}

    def test_probes_run_only_on_files_that_ship(self, tmp_path, monkeypatch):
        """Sorting before probing is also what keeps a truncated walk cheap.

        _scan_file_entry opens each file twice (PIL header + XMP rating). Under
        a cap it must run cap times, not once per file in the subtree.
        """
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "FLAT_LIST_CAP", 2)
        probed: list[str] = []
        real = ib._scan_file_entry

        def counting(path, name, ext, st, image_subset):
            probed.append(name)
            return real(path, name, ext, st, image_subset)

        monkeypatch.setattr(ib, "_scan_file_entry", counting)
        for i in range(6):
            f = tmp_path / f"f{i}.png"
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))

        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert len(resp._body["files"]) == 2
        # Six files enumerated, two probed — and they are the two newest.
        assert sorted(probed) == ["f4.png", "f5.png"]

    def test_enumeration_backstop_marks_truncated(self, tmp_path, monkeypatch):
        """FLAT_WALK_CAP bounds the cheap pass; hitting it drops the newest-N
        guarantee, so the response must still say truncated."""
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "FLAT_WALK_CAP", 2)
        monkeypatch.setattr(ib, "FLAT_LIST_CAP", 100)
        for i in range(5):
            (tmp_path / f"f{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is True
        assert len(resp._body["files"]) == 2


class TestListDirCap:
    """The non-recursive path is capped too — it had the same unbounded hole."""

    def _call(self, query):
        return asyncio.run(ib.image_browser_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def test_caps_at_dir_list_cap_keeping_the_newest(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "DIR_LIST_CAP", 2)
        for i in range(5):
            f = tmp_path / f"f{i}.png"
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))
        resp = self._call({"type": "output", "subfolder": ""})
        assert resp._body["truncated"] is True
        assert {f["name"] for f in resp._body["files"]} == {"f3.png", "f4.png"}

    def test_probes_run_only_on_files_that_ship(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "DIR_LIST_CAP", 2)
        probed: list[str] = []
        real = ib._scan_file_entry

        def counting(path, name, ext, st, image_subset):
            probed.append(name)
            return real(path, name, ext, st, image_subset)

        monkeypatch.setattr(ib, "_scan_file_entry", counting)
        for i in range(6):
            f = tmp_path / f"f{i}.png"
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))
        self._call({"type": "output", "subfolder": ""})
        assert sorted(probed) == ["f4.png", "f5.png"]

    def test_under_the_cap_nothing_is_dropped_or_flagged(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "DIR_LIST_CAP", 10)
        for i in range(3):
            (tmp_path / f"f{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": ""})
        assert resp._body["truncated"] is False
        assert len(resp._body["files"]) == 3
        # Still no subpath key on the non-recursive path.
        assert "subpath" not in resp._body["files"][0]


class TestListKindFilter:
    """`kind=` — the toolbar's All / Images / Videos filter, applied server-side.

    Server-side is the requirement, not an implementation detail: the narrowing
    sits above the mtime sort + cap in _probe_newest, so the cap is spent on the
    kind that was asked for. That is what the recursive case below pins down.
    """

    def _call(self, query):
        return asyncio.run(ib.image_browser_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def _mixed(self, base):
        (base / "a.png").write_bytes(b"x")
        (base / "b.mp4").write_bytes(b"x")

    def _names(self, resp):
        return {f["name"] for f in resp._body["files"]}

    def test_videos_narrows_to_video_extensions(self, tmp_path, monkeypatch):
        # Fails if the narrowing is deleted.
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert self._names(self._call({"type": "output", "kind": "videos"})) == {"b.mp4"}

    def test_images_narrows_to_image_extensions(self, tmp_path, monkeypatch):
        # Fails if IMG_EXTS/VIDEO_EXTS are swapped in KIND_FILTERS.
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert self._names(self._call({"type": "output", "kind": "images"})) == {"a.png"}

    def test_absent_kind_lists_both(self, tmp_path, monkeypatch):
        # Fails if the narrowing is applied unconditionally.
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert self._names(self._call({"type": "output"})) == {"a.png", "b.mp4"}

    def test_unrecognised_kind_narrows_nothing(self, tmp_path, monkeypatch):
        """An odd `kind` is answerable, so it answers — it does not 400.

        Locks the leniency decision: fails if the lookup is changed to raise on
        an unknown key, or if an else-branch guesses a family. The frontend
        whitelists on read, so this is only reachable by hand-built URLs.
        """
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        # Singular typo — the exact drift the mirror test below also guards.
        assert self._names(self._call({"type": "output", "kind": "video"})) == {
            "a.png",
            "b.mp4",
        }

    def test_narrowing_reaches_the_recursive_walk(self, tmp_path, monkeypatch):
        """Flat view filters too — fails if the narrowing moves below the
        `if recursive:` split, where it would only reach the dir lister."""
        self._sandbox(tmp_path, monkeypatch)
        deep = tmp_path / "sub" / "deep"
        deep.mkdir(parents=True)
        (deep / "nested.mp4").write_bytes(b"x")
        (deep / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "output", "recursive": "1", "kind": "videos"})
        assert self._names(resp) == {"nested.mp4"}
        assert resp._body["files"][0]["subpath"] == "sub/deep"

    def test_applies_on_the_path_tab(self, tmp_path, monkeypatch):
        """The deliberate divergence from `recursive`, which IS gated to the
        sandboxed roots. Extension filtering costs nothing extra on an arbitrary
        base, so the browse… tab filters like any other. Fails the moment
        someone mirrors `recursive`'s `and type_name in SANDBOXED_TYPES`."""
        self._mixed(tmp_path)
        resp = self._call({"type": "path", "path": str(tmp_path), "kind": "videos"})
        assert self._names(resp) == {"b.mp4"}

    def test_composes_with_an_explicit_extensions_list(self, tmp_path, monkeypatch):
        """Intersects rather than overrides, so a caller's own narrowing is not
        silently discarded. Fails if `&=` becomes `=` — c.webm would reappear."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        (tmp_path / "c.webm").write_bytes(b"x")
        resp = self._call({"type": "output", "extensions": "mp4,png", "kind": "videos"})
        assert self._names(resp) == {"b.mp4"}

    def test_frontend_filter_names_match_the_backend_kinds(self):
        """The frontend's VALID_FILTERS must name exactly the kinds the backend
        honours, plus "all" (which is expressed by omitting the param).

        A one-character drift — "videos" on one side, "video" on the other —
        would be a SILENT no-filter: the request succeeds, every file comes
        back, and the UI shows the segment as active. Nothing else can see it,
        which is why the literal is read back out of the source here. Sibling of
        tests/test_metadata.py::test_frontend_mirror_matches_the_backend_gate.
        """
        import re

        src = os.path.join(os.path.dirname(__file__), "..", "src", "browser.ts")
        with open(src, encoding="utf-8") as fh:
            text = fh.read()
        m = re.search(r"VALID_FILTERS = new Set\(\[(.*?)\]\)", text, re.S)
        assert m, "VALID_FILTERS literal not found in src/browser.ts"
        frontend = set(re.findall(r'"([^"]+)"', m.group(1)))
        assert frontend == {"all"} | set(ib.KIND_FILTERS)


class TestSafeViewMatcher:
    """The token matcher — a direct port of the kit's `tokenize`/`parseKeywords`.

    The two sides MUST agree: hiding happens here, blurring happens in the
    frontend, and a file one considers sensitive and the other does not renders
    blurred in one grid and plain in another. `comfyui-gallery-loader` ports the
    identical pair, so a drift here is a three-way disagreement.
    """

    def test_matches_a_whole_token_in_the_name(self):
        assert ib.is_safe_match({"nsfw"}, "", "", "my_nsfw_pic.png")

    def test_matches_a_whole_token_in_a_folder_segment(self):
        assert ib.is_safe_match({"nsfw"}, "output/nsfw/2026-08-04", "", "pic.png")

    def test_matches_any_of_the_parts_it_is_given(self):
        """The predicate itself is part-agnostic; which parts the /list handler
        hands it (name + root + folder segments) is pinned end-to-end by
        TestListSafeHide::test_matches_the_root_segment."""
        assert ib.is_safe_match({"temp"}, "temp/", "", "pic.png")

    def test_case_is_ignored(self):
        assert ib.is_safe_match({"nsfw"}, "output/NSFW", "", "PIC.PNG")

    # --- The two controls. A substring implementation passes every test above
    # --- and fails only these, which is exactly why they are here.

    def test_a_short_keyword_does_not_match_a_longer_word(self):
        """CONTROL: `ass` must not match `assets/`.

        The false-positive class this guards is invisible to the user — a
        wrongly-hidden file and a deliberately-hidden one look identical
        (absent), so nothing would ever report it.

        BOTH DIRECTIONS, on the same keyword, in the same test. The negative
        alone passes against a matcher hard-wired to `return False` — it proves
        only that nothing is over-matched, never that anything is matched — so
        it cannot tell "correct" from "inert". The positive is what gives it
        teeth. (Measured: with `is_safe_match` returning False as its first
        statement, the negative-only version passed.)
        """
        assert not ib.is_safe_match({"ass"}, "output/assets", "", "classic.png")
        assert ib.is_safe_match({"ass"}, "output/ass", "", "classic.png")

    def test_a_keyword_does_not_match_a_word_that_merely_starts_with_it(self):
        """CONTROL: `nsfw` must not match `nsfwish.png` — but must match `nsfw.png`.

        Two-sided for the reason given above.
        """
        assert not ib.is_safe_match({"nsfw"}, "output/holiday", "", "nsfwish.png")
        assert ib.is_safe_match({"nsfw"}, "output/holiday", "", "nsfw.png")

    def test_no_keywords_matches_nothing(self):
        assert not ib.is_safe_match(set(), "output/nsfw", "", "nsfw.png")

    def test_tokenize_splits_on_every_non_alphanumeric(self):
        assert ib.safe_tokenize("output/nsfw/2026-08-04") == {"output", "nsfw", "2026", "08", "04"}

    def test_parse_keywords_accepts_commas_and_whitespace_and_dedupes(self):
        assert ib.parse_safe_keywords("nsfw, private  nsfw") == {"nsfw", "private"}

    def test_parse_keywords_strips_punctuation_from_each_keyword(self):
        """A keyword carrying punctuation could never equal a token, so it is
        normalized the same way the haystack is. Fails if the strip is dropped —
        `nsfw!` would then silently match nothing at all."""
        assert ib.parse_safe_keywords("#nsfw!") == {"nsfw"}

    def test_parse_keywords_of_an_empty_value_is_empty(self):
        assert ib.parse_safe_keywords("") == set()


class TestListSafeHide:
    """`safe_kw` / `safe_hide` — Safe View's server-side hide.

    DISCRETION, NOT ACCESS CONTROL: this is a rendering preference the browser
    asks for, and every other endpoint still serves the same files to the same
    caller. The tests below pin behaviour, not a security boundary.
    """

    def _call(self, query):
        return asyncio.run(ib.image_browser_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def _names(self, resp):
        return {f["name"] for f in resp._body["files"]}

    def _mixed(self, base):
        (base / "holiday.png").write_bytes(b"x")
        (base / "my_nsfw_pic.png").write_bytes(b"x")

    def test_hides_a_matching_file(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == {"holiday.png"}

    def test_absent_params_hide_nothing(self, tmp_path, monkeypatch):
        """The default request must behave exactly as it did before Safe View.

        Asserts the DIRS too: the folder gate calls the matcher unconditionally
        (an empty keyword set is the guard), so a matcher that answered True on
        an empty set would empty the folder list while leaving the files alone —
        a half-broken listing no file-only assertion can see.
        """
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        (tmp_path / "anything").mkdir()
        resp = self._call({"type": "output"})
        assert self._names(resp) == {"holiday.png", "my_nsfw_pic.png"}
        assert {d["name"] for d in resp._body["dirs"]} == {"anything"}

    def test_empty_keywords_hide_nothing_even_with_the_flag_on(self, tmp_path, monkeypatch):
        """Fails if `safe_hide` alone is ever allowed to filter. There is no
        implicit default keyword on this side — the frontend owns the default
        and sends it explicitly, so a request that forgot the list must not
        silently hide a user's files."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "", "safe_hide": "1"})
        assert self._names(resp) == {"holiday.png", "my_nsfw_pic.png"}

    def test_keywords_without_the_flag_hide_nothing(self, tmp_path, monkeypatch):
        """Blur-only is the default mode: the keywords are sent for matching in
        the browser, and hiding is the separate opt-in."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "nsfw"})
        assert self._names(resp) == {"holiday.png", "my_nsfw_pic.png"}

    def test_unrecognised_flag_value_hides_nothing(self, tmp_path, monkeypatch):
        """Answerable, so it answers — same leniency as `kind` and `recursive`."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "maybe"})
        assert self._names(resp) == {"holiday.png", "my_nsfw_pic.png"}

    def test_a_short_keyword_does_not_hide_a_longer_word(self, tmp_path, monkeypatch):
        """CONTROL, end to end: `ass` must not hide `assets/classic.png`.

        The matcher's own control test covers the predicate; this one proves the
        endpoint calls it with whole-token semantics rather than doing its own
        `in` check on the way past.

        ONE assertion, both directions. `assets/` holds a file that must survive
        and a file that must be hidden, and the request carries a keyword for
        each. A substring matcher hides both (`ass` in `assets`) and fails; a
        matcher that hides nothing returns both and fails too. Asserting only
        the survivor — with nothing in the folder to hide — passes against an
        endpoint that filters nothing at all, which is what this used to do.
        """
        self._sandbox(tmp_path, monkeypatch)
        assets = tmp_path / "assets"
        assets.mkdir()
        (assets / "classic.png").write_bytes(b"x")
        (assets / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call(
            {
                "type": "output",
                "subfolder": "assets",
                "safe_kw": "ass, nsfw",
                "safe_hide": "1",
            }
        )
        assert self._names(resp) == {"classic.png"}

    def test_matches_the_requested_subfolder_not_just_the_name(self, tmp_path, monkeypatch):
        """A blandly-named file inside a matching folder is hidden."""
        self._sandbox(tmp_path, monkeypatch)
        sub = tmp_path / "nsfw"
        sub.mkdir()
        (sub / "plain.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "subfolder": "nsfw", "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == set()

    def test_matches_a_nested_subpath_in_the_recursive_walk(self, tmp_path, monkeypatch):
        """Flat view hides too. Fails if the filter is applied only in the
        non-recursive branch — the same shape of miss `kind` guards against."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "top.png").write_bytes(b"x")
        deep = tmp_path / "nsfw" / "2026-08-04"
        deep.mkdir(parents=True)
        (deep / "plain.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "recursive": "1", "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == {"top.png"}

    def test_hides_matching_directory_cards(self, tmp_path, monkeypatch):
        """A matching folder goes too — otherwise the listing keeps a visible
        (and now empty) doorway labelled with the very word the user asked not
        to see. Name-only, which is the kit's documented folder rule."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "nsfw").mkdir()
        (tmp_path / "holiday").mkdir()
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert {d["name"] for d in resp._body["dirs"]} == {"holiday"}

    def test_applies_on_the_path_tab(self, tmp_path, monkeypatch):
        """browse…/type=path filters like any other tab — and this is the one
        case where the logical path IS the OS path, so both sides see the same
        segments."""
        self._mixed(tmp_path)
        resp = self._call(
            {"type": "path", "path": str(tmp_path), "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == {"holiday.png"}

    def test_matches_the_root_segment(self, tmp_path, monkeypatch):
        """The root is IN the haystack, end to end.

        Pins the caller, not just the predicate: `hide_prefix` is built as
        `f"{type_name}/{subfolder}"`, and the obvious simplification to a bare
        `subfolder` passes every other test here — the frontend's `fileSub()`
        returns exactly that bare subfolder, which is what makes this the drift
        most likely to happen on both sides at once.
        """
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "output", "safe_hide": "1"})
        assert self._names(resp) == set()

    def test_the_os_path_is_not_part_of_the_haystack_for_a_sandboxed_root(
        self, tmp_path, monkeypatch
    ):
        """THE LEAK THIS GUARDS: matching the RESOLVED path would put every
        segment of `/home/<user>/ComfyUI/output` into the haystack, so a keyword
        naming any of them would hide the entire library — while the frontend,
        which never sees those segments, kept showing the files unblurred.

        The sandbox root is given a name of our own choosing so the keyword is a
        real TOKEN of the on-disk path. An earlier version of this test used
        `os.path.basename(tmp_path)`, which pytest names `test_..._0` — the
        keyword parser strips its underscores, so it could never equal any token
        and the test passed against the mutation. `just mutation-check` is what
        caught that; do not weaken the keyword back to a generated name.
        """
        root = tmp_path / "secretdirname"
        root.mkdir()
        self._sandbox(root, monkeypatch)
        self._mixed(root)
        resp = self._call({"type": "output", "safe_kw": "secretdirname", "safe_hide": "1"})
        assert self._names(resp) == {"holiday.png", "my_nsfw_pic.png"}

    def test_hiding_is_applied_above_the_newest_n_cap(self, tmp_path, monkeypatch):
        """THE WHOLE REASON HIDING LIVES ON THE SERVER.

        A folder of mostly-sensitive files must still return a FULL PAGE of the
        rest. Here the 2 newest files are both sensitive and the 2 oldest are
        not, with the cap at 2: filtering above the cap returns both harmless
        files, while filtering the already-capped slice would return NOTHING —
        which is precisely what a client-side filter does, and why this is not a
        frontend feature.
        """
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "DIR_LIST_CAP", 2)
        for i, name in enumerate(["old_a.png", "old_b.png", "nsfw_c.png", "nsfw_d.png"]):
            f = tmp_path / name
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == {"old_a.png", "old_b.png"}
        # Nothing the caller was allowed to see was dropped, so not truncated.
        assert resp._body["truncated"] is False

    def test_hiding_is_above_the_cap_in_the_recursive_walk_too(self, tmp_path, monkeypatch):
        """Same guarantee for flat view, which uses the other cap."""
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(ib, "FLAT_LIST_CAP", 2)
        for i, name in enumerate(["old_a.png", "old_b.png", "nsfw_c.png", "nsfw_d.png"]):
            f = tmp_path / name
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))
        resp = self._call(
            {"type": "output", "recursive": "1", "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == {"old_a.png", "old_b.png"}

    def test_composes_with_the_kind_filter(self, tmp_path, monkeypatch):
        """Both narrowings apply; neither replaces the other."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "holiday.mp4").write_bytes(b"x")
        (tmp_path / "holiday.png").write_bytes(b"x")
        (tmp_path / "nsfw.mp4").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "kind": "videos", "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == {"holiday.mp4"}


class TestRmdirEndpoint:
    """Drive the real /rmdir handler against a tmp dir (folder_paths stubbed).

    conftest's json_response stub returns SimpleNamespace(status, _body), so
    the two-step contract (409 + nested counts, then recursive:true) is
    assertable without a live aiohttp server.
    """

    def _call(self, body):
        return asyncio.run(ib.image_browser_rmdir(_FakeRequest(body)))

    def _sandbox(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )

    def test_empty_dir_deletes_outright(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "empty").mkdir()
        resp = self._call({"type": "output", "subfolder": "", "name": "empty"})
        assert resp._body["ok"] is True
        assert not (tmp_path / "empty").exists()

    def test_non_empty_answers_409_with_nested_counts(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        d = tmp_path / "full"
        (d / "nested").mkdir(parents=True)
        (d / "a.png").write_bytes(b"x")
        (d / "nested" / "b.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "name": "full"})
        assert resp.status == 409
        assert resp._body["ok"] is False
        assert resp._body["files"] == 2
        assert resp._body["dirs"] == 1
        assert d.is_dir()  # nothing deleted without recursive:true

    def test_recursive_true_deletes_subtree(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        d = tmp_path / "full"
        (d / "nested").mkdir(parents=True)
        (d / "nested" / "b.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "name": "full", "recursive": True})
        assert resp._body["ok"] is True
        assert not d.exists()

    def test_rejects_symlinked_dir(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        outside = tmp_path / "real"
        outside.mkdir()
        (tmp_path / "link").symlink_to(outside, target_is_directory=True)
        resp = self._call({"type": "output", "subfolder": "", "name": "link"})
        assert resp.status == 400
        assert outside.is_dir()

    def test_missing_dir_404s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"type": "output", "subfolder": "", "name": "nope"})
        assert resp.status == 404


class TestMkdirEndpoint:
    """Drive the real /mkdir handler against a tmp dir (folder_paths stubbed).

    Shares the sandboxed-dir write perimeter with /rmdir; here we cover the
    happy path plus the collision (409) and missing-parent (404) contracts.
    """

    def _call(self, body):
        return asyncio.run(ib.image_browser_mkdir(_FakeRequest(body)))

    def _sandbox(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )

    def test_creates_folder(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"type": "output", "subfolder": "", "name": "new"})
        assert resp._body["ok"] is True
        assert resp._body["name"] == "new"
        assert (tmp_path / "new").is_dir()

    def test_creates_nested_folder_under_existing_subfolder(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "sub").mkdir()
        resp = self._call({"type": "output", "subfolder": "sub", "name": "child"})
        assert resp._body["ok"] is True
        assert (tmp_path / "sub" / "child").is_dir()

    def test_existing_target_409s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "dup").mkdir()
        resp = self._call({"type": "output", "subfolder": "", "name": "dup"})
        assert resp.status == 409
        assert resp._body["ok"] is False

    def test_collision_with_existing_file_409s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "a.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "name": "a.png"})
        assert resp.status == 409
        assert (tmp_path / "a.png").is_file()  # untouched

    def test_missing_parent_404s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"type": "output", "subfolder": "gone", "name": "child"})
        assert resp.status == 404
        assert not (tmp_path / "gone").exists()

    def test_rejects_path_type(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"type": "path", "subfolder": "", "name": "new"})
        assert resp.status == 400
        assert "input/output/temp" in resp._body["error"]

    def test_rejects_traversal_name(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"type": "output", "subfolder": "", "name": "../escape"})
        assert resp.status == 400
        assert not (tmp_path.parent / "escape").exists()

    def test_path_type_rejected(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"type": "path", "subfolder": "", "name": "x"})
        assert resp.status == 400


class TestMoveDirEndpoint:
    """Drive the real /move_dir handler against a tmp dir (folder_paths stubbed).

    All roots (input/output/temp) map to the same tmp_path here, so a move
    between "roots" is a move between subfolders of one tree — enough to cover
    the containment, self-nesting, collision and missing-dest contracts without
    a real ComfyUI folder layout.
    """

    def _call(self, body):
        return asyncio.run(ib.image_browser_move_dir(_FakeRequest(body)))

    def _sandbox(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )

    def test_moves_folder_into_subfolder(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        src = tmp_path / "album"
        (src / "nested").mkdir(parents=True)
        (src / "a.png").write_bytes(b"x")
        (tmp_path / "dest").mkdir()
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "dest",
            }
        )
        assert resp._body["ok"] is True
        assert not src.exists()
        assert (tmp_path / "dest" / "album" / "a.png").is_file()
        assert (tmp_path / "dest" / "album" / "nested").is_dir()

    def test_self_nesting_rejected(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "album" / "inner").mkdir(parents=True)
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "album/inner",
            }
        )
        assert resp.status == 400
        assert "into itself" in resp._body["error"]
        assert (tmp_path / "album").is_dir()  # untouched

    def test_same_source_and_dest_rejected(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "album").mkdir()
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "",
            }
        )
        assert resp.status == 400
        assert (tmp_path / "album").is_dir()

    def test_same_named_folder_merges(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        # Source and an existing same-named destination folder hold disjoint files
        # (plus a shared subfolder with its own disjoint files) — a clean merge.
        src = tmp_path / "album"
        (src / "sub").mkdir(parents=True)
        (src / "new.png").write_bytes(b"n")
        (src / "sub" / "deep.png").write_bytes(b"d")
        existing = tmp_path / "dest" / "album"
        (existing / "sub").mkdir(parents=True)
        (existing / "old.png").write_bytes(b"o")
        (existing / "sub" / "keep.png").write_bytes(b"k")
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "dest",
            }
        )
        assert resp._body["ok"] is True
        assert resp._body["merged"] is True
        assert resp._body["errors"] == []
        assert not src.exists()  # fully drained, so removed
        # Both sides' files now live under the one destination folder.
        assert (existing / "new.png").is_file()
        assert (existing / "old.png").is_file()
        assert (existing / "sub" / "deep.png").is_file()
        assert (existing / "sub" / "keep.png").is_file()

    def test_merge_file_collision_left_in_source(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        src = tmp_path / "album"
        src.mkdir()
        (src / "clash.png").write_bytes(b"src")
        (src / "fresh.png").write_bytes(b"src")
        existing = tmp_path / "dest" / "album"
        existing.mkdir(parents=True)
        (existing / "clash.png").write_bytes(b"dst")
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "dest",
            }
        )
        assert resp._body["ok"] is True
        assert resp._body["merged"] is True
        assert [e["name"] for e in resp._body["errors"]] == ["clash.png"]
        # Non-colliding file moved; colliding one stayed put and was NOT clobbered.
        assert (existing / "fresh.png").is_file()
        assert (existing / "clash.png").read_bytes() == b"dst"
        assert src.is_dir()  # not removed — still holds the conflict
        assert (src / "clash.png").read_bytes() == b"src"
        assert not (src / "fresh.png").exists()

    def test_same_named_file_at_dest_409s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "album").mkdir()
        # A *file* (not a folder) named "album" blocks the destination.
        (tmp_path / "dest").mkdir()
        (tmp_path / "dest" / "album").write_bytes(b"x")
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "dest",
            }
        )
        assert resp.status == 409
        assert (tmp_path / "album").is_dir()  # source untouched

    def test_missing_dest_folder_404s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "album").mkdir()
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "gone",
            }
        )
        assert resp.status == 404
        assert (tmp_path / "album").is_dir()

    def test_missing_source_404s(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "dest").mkdir()
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "nope",
                "dest_type": "output",
                "dest_subfolder": "dest",
            }
        )
        assert resp.status == 404

    def test_rejects_symlinked_source(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        outside = tmp_path / "real"
        outside.mkdir()
        (tmp_path / "link").symlink_to(outside, target_is_directory=True)
        (tmp_path / "dest").mkdir()
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "link",
                "dest_type": "output",
                "dest_subfolder": "dest",
            }
        )
        assert resp.status == 400
        assert outside.is_dir()
        assert not (tmp_path / "dest" / "link").exists()

    def test_rejects_path_type_source(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call(
            {
                "type": "path",
                "subfolder": "",
                "name": "album",
                "dest_type": "output",
                "dest_subfolder": "",
            }
        )
        assert resp.status == 400
        assert "input/output/temp" in resp._body["error"]

    def test_rejects_path_type_dest(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "album").mkdir()
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "album",
                "dest_type": "path",
                "dest_subfolder": "",
            }
        )
        assert resp.status == 400
        assert "destination" in resp._body["error"]

    def test_rejects_traversal_name(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "name": "../escape",
                "dest_type": "output",
                "dest_subfolder": "",
            }
        )
        assert resp.status == 400


class TestParseRating:
    def test_accepts_star_range(self):
        for r in range(6):
            assert ib._parse_rating(r) == r

    def test_rejects_out_of_range(self):
        assert ib._parse_rating(-1) is None
        assert ib._parse_rating(6) is None

    def test_rejects_bool_and_non_int(self):
        # bool is an int subclass — JSON true must not read as rating 1.
        assert ib._parse_rating(True) is None
        assert ib._parse_rating(False) is None
        assert ib._parse_rating("3") is None
        assert ib._parse_rating(3.0) is None
        assert ib._parse_rating(None) is None


class TestValidateBatchItems:
    """Top-level shape gate for /delete_many and /move_many bodies.

    Per-item field validation (type/path/name) is enforced downstream by
    ``_resolve_sandboxed_file`` — see TestResolveSandboxedFileRejections.
    Here we only assert the body's items-list shape 400s before disk touch.
    """

    def test_rejects_missing_items(self):
        items, err_resp = ib._validate_batch_items({})
        assert items is None
        assert err_resp is not None
        assert err_resp.status == 400

    def test_rejects_non_list_items(self):
        items, err_resp = ib._validate_batch_items({"items": "not-a-list"})
        assert items is None
        assert err_resp is not None
        assert err_resp.status == 400

    def test_rejects_empty_list(self):
        items, err_resp = ib._validate_batch_items({"items": []})
        assert items is None
        assert err_resp is not None
        assert err_resp.status == 400

    def test_rejects_non_object_items(self):
        items, err_resp = ib._validate_batch_items({"items": ["str", 5]})
        assert items is None
        assert err_resp is not None
        assert err_resp.status == 400

    def test_accepts_list_of_objects(self):
        items, err_resp = ib._validate_batch_items(
            {"items": [{"type": "output", "subfolder": "", "name": "a.png"}]}
        )
        assert err_resp is None
        assert items is not None
        assert len(items) == 1


class TestRatingsBatchRead:
    """Drive the real /ratings handler against a tmp sandbox.

    The contract the sidebar injector depends on is positional: ratings[i]
    belongs to items[i], and an unreadable entry is ``None`` rather than 0.
    Collapsing those two would make the injector paint a confident zero-star
    row over a file it never read.
    """

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def _call(self, body):
        return asyncio.run(ib.image_browser_ratings(_FakeRequest(body)))

    def test_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(r.method == "POST" and r.path == "/image_browser/ratings" for r in registered)

    def test_returns_one_entry_per_item_in_order(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        for name in ("a.png", "b.png", "c.png"):
            (tmp_path / name).write_bytes(b"\x89PNG\r\n\x1a\n")
        resp = self._call(
            {
                "items": [
                    {"type": "output", "subfolder": "", "name": n}
                    for n in ("a.png", "b.png", "c.png")
                ]
            }
        )
        assert resp.status == 200
        data = resp._body
        assert data["ok"] is True
        assert len(data["ratings"]) == 3

    def test_unreadable_entry_is_none_not_zero(self, tmp_path, monkeypatch):
        # "unrated" (0) and "could not read" (None) are different facts, and the
        # frontend retries the latter instead of painting it.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "real.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        resp = self._call(
            {
                "items": [
                    {"type": "output", "subfolder": "", "name": "real.png"},
                    {"type": "output", "subfolder": "", "name": "missing.png"},
                ]
            }
        )
        data = resp._body
        assert data["ratings"][0] == 0
        assert data["ratings"][1] is None

    def test_rejects_path_type_like_the_rating_write(self, tmp_path, monkeypatch):
        # Ratings are a sandboxed-roots concept: type=path is refused here for
        # the same reason the /rating WRITE refuses it (ADR-0002).
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"items": [{"type": "path", "subfolder": "", "name": "a.png"}]})
        assert resp._body["ratings"] == [None]

    def test_rejects_traversal(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call(
            {"items": [{"type": "output", "subfolder": "", "name": "../escape.png"}]}
        )
        assert resp._body["ratings"] == [None]

    def test_rejects_oversized_batch(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        items = [
            {"type": "output", "subfolder": "", "name": f"{i}.png"}
            for i in range(ib.MAX_RATING_BATCH + 1)
        ]
        resp = self._call({"items": items})
        assert resp.status == 400

    def test_rejects_empty_batch(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"items": []})
        assert resp.status == 400


class TestBatchEndpointsRegistered:
    """Sanity: the batch routes are wired on the PromptServer routes table.

    conftest's _NoopRoutes records (method, path) pairs at import time when
    the @decorator runs, so we can assert a route is registered without
    invoking the handler against a real aiohttp Request. Catches a future
    refactor that drops the route by mistake.
    """

    def test_delete_many_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(
            r.method == "POST" and r.path == "/image_browser/delete_many" for r in registered
        )

    def test_move_many_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(r.method == "POST" and r.path == "/image_browser/move_many" for r in registered)

    def test_move_dir_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(r.method == "POST" and r.path == "/image_browser/move_dir" for r in registered)

    def test_rmdir_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(r.method == "POST" and r.path == "/image_browser/rmdir" for r in registered)

    def test_mkdir_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(r.method == "POST" and r.path == "/image_browser/mkdir" for r in registered)


# ---------------------------------------------------------------------------
# Safe View — the opt-in prompt-metadata tier
# ---------------------------------------------------------------------------
#
# Fixtures are REAL containers with REAL embedded metadata, synthesized in
# process (conftest stubs PIL, so nothing here may depend on an encoder). The
# builder below is the same spec shape tests/test_metadata.py uses — real CRCs,
# a real ComfyUI API graph — and the suite opens with a CONTROL asserting the
# parser actually reads it. A fixture the parser could not read would make every
# "does not match" assertion below pass while testing nothing.


def _png_chunk(ctype: bytes, data: bytes) -> bytes:
    body = ctype + data
    return len(data).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")


def _png_with_prompt(positive: str, model: str = "sd_xl_base_1.0.safetensors") -> bytes:
    """A PNG carrying one `prompt` tEXt chunk holding a ComfyUI API graph."""
    graph = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["4", 1]}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 1,
                "steps": 20,
                "cfg": 8.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
            },
        },
    }
    payload = b"prompt\x00" + json.dumps(graph).encode()
    return image_meta.PNG_SIG + b"".join(
        [
            _png_chunk(b"IHDR", b"\x00" * 13),
            _png_chunk(b"tEXt", payload),
            _png_chunk(b"IEND", b""),
        ]
    )


class TestSafeViewStore:
    """The sqlite text cache in safeview_store.py."""

    def test_CONTROL_the_fixture_really_carries_a_readable_prompt(self, tmp_path):
        """Every assertion in this file rests on this, and the dependency is
        invisible from the assertions themselves: if the builder produced a PNG
        image_meta could not read, extract_text would return "" and every
        "does not match" test below would pass having proved nothing."""
        f = tmp_path / "a.png"
        f.write_bytes(_png_with_prompt("a cat in a hat"))
        text = safeview_store.extract_text(str(f))
        assert "cat" in text
        assert "sd_xl_base_1.0.safetensors" in text

    def test_key_shape_matches_thumb_cache(self, tmp_path):
        """Same key as the thumbnail cache — path + mtime_ns + size. One
        invalidation model to reason about, not two."""
        import thumb_cache

        f = tmp_path / "a.png"
        f.write_bytes(b"x")
        st = os.stat(f)
        assert safeview_store.cache_key(str(f), st) == thumb_cache.cache_key(str(f), st)

    def test_an_edited_file_keys_a_fresh_entry(self, tmp_path):
        f = tmp_path / "a.png"
        f.write_bytes(b"x")
        first = safeview_store.cache_key(str(f), os.stat(f))
        f.write_bytes(b"xy")
        assert safeview_store.cache_key(str(f), os.stat(f)) != first

    def test_round_trip_and_a_missing_key_is_ABSENT(self, tmp_path):
        """Absent, never empty-string. "not scanned yet" and "scanned, carries
        no prompt" are different facts, and the endpoint turns exactly that
        difference into `"unscanned"` versus `false`."""
        db = str(tmp_path / "c.sqlite")
        assert safeview_store.store_texts(db, [("k1", "a cat")]) == 1
        assert safeview_store.read_cached(db, ["k1", "k2"]) == {"k1": "a cat"}

    def test_a_file_with_no_metadata_is_still_CACHED_as_empty(self, tmp_path):
        """Otherwise every screenshot in the library is re-parsed forever and
        stays "unscanned" — and therefore blurred — however often the sweep
        runs."""
        db = str(tmp_path / "c.sqlite")
        f = tmp_path / "plain.png"
        f.write_bytes(image_meta.PNG_SIG + _png_chunk(b"IEND", b""))
        safeview_store.scan_paths(db, [str(f)])
        key = safeview_store.cache_key(str(f), os.stat(f))
        assert safeview_store.read_cached(db, [key]) == {key: ""}

    def test_a_READ_creates_nothing_on_disk(self, tmp_path):
        """A read must have no side effects. With the cache opened for creation
        on the read path, a listing against a mis-resolved user directory
        silently mkdir's it — observed leaving a literal `<MagicMock ...>/`
        directory in the repo root during a mutation run, which is the shape a
        real folder_paths misconfiguration takes on someone's disk.

        Two-sided: the WRITE must still create what it needs, or "nothing was
        created" passes against a store that never works at all.
        """
        nested = tmp_path / "does" / "not" / "exist"
        db = str(nested / "c.sqlite")
        assert safeview_store.read_cached(db, ["k"]) == {}
        assert not nested.exists()
        assert safeview_store.store_texts(db, [("k", "v")]) == 1
        assert nested.is_dir()

    def test_scan_paths_skips_a_file_that_vanished(self, tmp_path):
        """A sweep racing a delete is normal, not an error."""
        db = str(tmp_path / "c.sqlite")
        present = tmp_path / "here.png"
        present.write_bytes(_png_with_prompt("a cat in a hat"))
        # Both in one batch: `0` on its own passes against a scanner that never
        # scans anything, so the surviving file has to be counted.
        assert safeview_store.scan_paths(db, [str(tmp_path / "gone.png"), str(present)]) == 1

    def test_an_already_cached_file_is_not_re_parsed(self, tmp_path):
        db = str(tmp_path / "c.sqlite")
        f = tmp_path / "a.png"
        f.write_bytes(_png_with_prompt("a cat in a hat"))
        assert safeview_store.scan_paths(db, [str(f)]) == 1
        assert safeview_store.scan_paths(db, [str(f)]) == 0

    def test_the_text_is_capped(self, tmp_path):
        f = tmp_path / "a.png"
        f.write_bytes(_png_with_prompt("cat " * 4000))
        assert len(safeview_store.extract_text(str(f))) <= safeview_store.MAX_TEXT_BYTES

    def test_an_unwritable_cache_degrades_instead_of_raising(self, tmp_path):
        """A cache is an optimisation. A listing must still answer when the user
        dir is read-only or the disk is full."""
        blocker = tmp_path / "not-a-dir"
        blocker.write_bytes(b"x")
        db = str(blocker / "c.sqlite")
        assert safeview_store.store_texts(db, [("k", "v")]) == 0
        assert safeview_store.read_cached(db, ["k"]) == {}
        # Paired positive: a store that never worked would satisfy the two
        # assertions above without degrading gracefully at all.
        good = str(tmp_path / "good.sqlite")
        assert safeview_store.store_texts(good, [("k", "v")]) == 1
        assert safeview_store.read_cached(good, ["k"]) == {"k": "v"}

    def test_walk_candidates_filters_by_extension_and_skips_hidden(self, tmp_path):
        (tmp_path / "keep.png").write_bytes(b"x")
        (tmp_path / "skip.avi").write_bytes(b"x")
        (tmp_path / ".hidden.png").write_bytes(b"x")
        sub = tmp_path / "clipspace"
        sub.mkdir()
        (sub / "deep.png").write_bytes(b"x")
        found = safeview_store.walk_candidates([str(tmp_path)], {".png"})
        assert [os.path.basename(p) for p in found] == ["keep.png"]

    def test_walk_candidates_does_not_follow_a_symlinked_dir(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.png").write_bytes(b"x")
        inner = tmp_path / "inner"
        inner.mkdir()
        (inner / "real.png").write_bytes(b"x")
        (inner / "link").symlink_to(outside, target_is_directory=True)
        # `real.png` must be found, so an empty result cannot pass here: a walk
        # that returns nothing at all fails this exactly as a walk that followed
        # the link does.
        found = safeview_store.walk_candidates([str(inner)], {".png"})
        assert [os.path.basename(p) for p in found] == ["real.png"]


class TestListSafePromptTier:
    """`safe_prompt` on /list — the four verdict states and the request gate.

    DISCRETION, NOT ACCESS CONTROL, like the rest of Safe View. These pin
    behaviour, not a security boundary.
    """

    def _call(self, query):
        return asyncio.run(ib.image_browser_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(base / "_user"), raising=False
        )
        (base / "_user").mkdir(exist_ok=True)
        # The lazy sweep is asserted on its own below. Stubbed here so the
        # endpoint tests neither leave a pending asyncio task behind every
        # asyncio.run() nor walk a tree in the background.
        monkeypatch.setattr(ib, "_maybe_start_sweep", lambda: None)

    def _by_name(self, resp):
        return {f["name"]: f for f in resp._body["files"]}

    def _mixed(self, base):
        (base / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        (base / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))

    def _warm(self, base, *names):
        db = safeview_store.db_path(str(base / "_user"))
        return safeview_store.scan_paths(db, [str(base / n) for n in names])

    def test_a_cold_cache_answers_UNSCANNED_and_counts_it(self, tmp_path, monkeypatch):
        """The fail-safe state. The kit reads `"unscanned"` as sensitive, so a
        never-scanned sensitive render is blurred rather than shown in the clear
        while the sweep catches up.

        BOTH DIRECTIONS, in the same listing. Asserting only that an uncached
        file reads `"unscanned"` passes against a verdict path that answers
        `"unscanned"` for EVERYTHING — which is exactly the failure that would
        blur a user's whole library. One file is warmed first and must come back
        with a real verdict; the other must not.
        """
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert self._warm(tmp_path, "cat.png") == 1
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        files = self._by_name(resp)
        assert files["cat.png"]["prompt_match"] is False
        assert files["leather.png"]["prompt_match"] == "unscanned"
        assert resp._body["safe_unscanned"] == 1

    def test_a_warm_cache_answers_the_verdict(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert self._warm(tmp_path, "cat.png", "leather.png") == 2
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        files = self._by_name(resp)
        assert files["leather.png"]["prompt_match"] is True
        assert files["cat.png"]["prompt_match"] is False
        assert resp._body["safe_unscanned"] == 0

    def test_CONTROL_the_prompt_is_matched_as_WHOLE_TOKENS(self, tmp_path, monkeypatch):
        """`ass` must not match a prompt reading "a bag of assets". A substring
        implementation passes every positive test above and fails only this."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "bag.png").write_bytes(_png_with_prompt("a bag of assets"))
        (tmp_path / "hit.png").write_bytes(_png_with_prompt("one ass and a hat"))
        self._warm(tmp_path, "bag.png", "hit.png")
        resp = self._call({"type": "output", "safe_kw": "ass", "safe_prompt": "1"})
        files = self._by_name(resp)
        assert files["bag.png"]["prompt_match"] is False
        # Paired positive in the same listing: a tier that matched nothing at all
        # would satisfy the negative on its own.
        assert files["hit.png"]["prompt_match"] is True

    def test_CONTROL_a_container_with_no_reader_carries_NO_verdict_key(
        self, tmp_path, monkeypatch
    ):
        """The fourth state, and the one easiest to collapse. An `.avi` is listed
        (it is in VIDEO_EXTS) but has no metadata reader, so it does not
        participate — the key must be ABSENT, not `"unscanned"`, or every
        unreadable file in the library blurs the moment the tier comes on."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "clip.avi").write_bytes(b"x")
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        files = self._by_name(resp)
        assert "prompt_match" not in files["clip.avi"]
        # Paired positive: the readable file in the SAME listing must still carry
        # one, so "the tier never ran" cannot satisfy this.
        assert files["cat.png"]["prompt_match"] == "unscanned"
        # And the unreadable one is not counted as work the sweep will ever do.
        assert resp._body["safe_unscanned"] == 1

    def test_the_default_listing_is_unchanged(self, tmp_path, monkeypatch):
        """No flag, no verdict keys, no count — byte-identical to what /list
        answered before this tier existed."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output"})
        assert "safe_unscanned" not in resp._body
        assert all("prompt_match" not in f for f in resp._body["files"])
        # Paired positive, same tree, same test: absence alone passes against a
        # tier that never runs at all, which is indistinguishable from a tier
        # that is correctly off.
        on = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert on._body["safe_unscanned"] == 2

    def test_the_flag_without_keywords_does_nothing(self, tmp_path, monkeypatch):
        """Same rule as `safe_hide`: a request that forgot the list must not blur
        a user's whole grid on verdicts nobody asked for."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "", "safe_prompt": "1"})
        assert "safe_unscanned" not in resp._body
        assert all("prompt_match" not in f for f in resp._body["files"])
        # Same flag, same tree, keywords supplied — must run.
        on = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert on._body["safe_unscanned"] == 2

    def test_an_unrecognised_flag_value_does_nothing(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "maybe"})
        assert all("prompt_match" not in f for f in resp._body["files"])
        # And a recognised one on the same tree must run, so this cannot pass
        # against a tier that ignores the flag entirely.
        on = self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert all("prompt_match" in f for f in on._body["files"])

    def test_the_prompt_is_consulted_ONLY_through_this_flag(self, tmp_path, monkeypatch):
        """The tier is opt-in end to end: hiding on its own keeps matching names
        and paths, and a matching PROMPT is simply not consulted."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        # A third file matching on its NAME, so ONE assertion carries both
        # directions: hiding must still drop the name match (proving the request
        # was filtered at all) while keeping the file whose only match is its
        # prompt. Without it, "both survive" passes against an endpoint that
        # hides nothing.
        (tmp_path / "my_nsfw_pic.png").write_bytes(_png_with_prompt("a cat in a hat"))
        self._warm(tmp_path, "cat.png", "leather.png", "my_nsfw_pic.png")
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert set(self._by_name(resp)) == {"cat.png", "leather.png"}

    def test_hiding_DROPS_a_prompt_match(self, tmp_path, monkeypatch):
        """With hiding on the two flags compose: a file whose prompt matched is
        removed from the listing, exactly as a matching NAME already is."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        self._warm(tmp_path, "cat.png", "leather.png")
        resp = self._call(
            {"type": "output", "safe_kw": "nsfw", "safe_hide": "1", "safe_prompt": "1"}
        )
        assert set(self._by_name(resp)) == {"cat.png"}

    def test_hiding_also_drops_an_UNSCANNED_file_and_reports_it(self, tmp_path, monkeypatch):
        """Mirrors the kit's isSensitive, which reads `"unscanned"` as sensitive.
        Keeping it would show a not-yet-judged sensitive render in the clear —
        and hiding mode has no blur to fall back on. The count is what lets the
        toolbar explain the missing files rather than leaving the user with a
        grid that looks emptied for no reason."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        # `cat.png` is warmed and clean, so it MUST survive. An empty survivor
        # set alone passes against an endpoint that drops everything — the very
        # failure this direction is most likely to produce.
        assert self._warm(tmp_path, "cat.png") == 1
        resp = self._call(
            {"type": "output", "safe_kw": "nsfw", "safe_hide": "1", "safe_prompt": "1"}
        )
        assert set(self._by_name(resp)) == {"cat.png"}
        assert resp._body["safe_unscanned"] == 1

    def test_the_tier_reaches_the_recursive_walk(self, tmp_path, monkeypatch):
        """Flat view is a separate call site; a tier wired only into the
        non-recursive lister would silently stop applying there."""
        self._sandbox(tmp_path, monkeypatch)
        deep = tmp_path / "sub"
        deep.mkdir()
        (deep / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))
        self._warm(tmp_path, "sub/leather.png")
        resp = self._call(
            {"type": "output", "recursive": "1", "safe_kw": "nsfw", "safe_prompt": "1"}
        )
        assert self._by_name(resp)["leather.png"]["prompt_match"] is True

    def test_the_tier_applies_on_the_path_tab_too(self, tmp_path, monkeypatch):
        """/metadata accepts type=path, so the tier can answer there — and the
        browse… tab is exactly where an unexpected folder gets opened."""
        self._sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        self._warm(tmp_path, "leather.png")
        resp = self._call(
            {"type": "path", "path": str(tmp_path), "safe_kw": "nsfw", "safe_prompt": "1"}
        )
        assert self._by_name(resp)["leather.png"]["prompt_match"] is True


class TestSafeViewSweepTrigger:
    """When the lazy background sweep is started."""

    def _sandbox(self, base, monkeypatch, calls):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(base / "_user"), raising=False
        )
        (base / "_user").mkdir(exist_ok=True)
        monkeypatch.setattr(ib, "_maybe_start_sweep", lambda: calls.append(1))

    def _call(self, query):
        return asyncio.run(ib.image_browser_list(_FakeGetRequest(query)))

    def test_a_listing_with_unscanned_files_starts_the_sweep(self, tmp_path, monkeypatch):
        calls = []
        self._sandbox(tmp_path, monkeypatch, calls)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == [1]

    def test_a_fully_cached_listing_does_NOT_start_one(self, tmp_path, monkeypatch):
        """A warm library must not re-walk the output tree on every request."""
        calls = []
        self._sandbox(tmp_path, monkeypatch, calls)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        safeview_store.scan_paths(
            safeview_store.db_path(str(tmp_path / "_user")), [str(tmp_path / "cat.png")]
        )
        self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == []
        # Paired positive, same test: an empty call list alone passes against a
        # trigger that never fires under any condition. Adding one uncached file
        # must start it.
        (tmp_path / "new.png").write_bytes(_png_with_prompt("a dog in a hat"))
        self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == [1]

    def test_a_listing_without_the_flag_never_starts_one(self, tmp_path, monkeypatch):
        """The whole point of starting lazily: a user who never enables the tier
        never pays for a walk of their output tree."""
        calls = []
        self._sandbox(tmp_path, monkeypatch, calls)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        self._call({"type": "output"})
        assert calls == []
        # Paired positive on the SAME uncached tree: with the flag, it fires.
        self._call({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == [1]


class TestSafeViewWarmEndpoint:
    """POST /safeview_warm — the `executed` fast warmer's landing point."""

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(base / "_user"), raising=False
        )
        (base / "_user").mkdir(exist_ok=True)

    def _call(self, body):
        return asyncio.run(ib.image_browser_safeview_warm(_FakeRequest(body)))

    def test_scans_and_caches_a_freshly_rendered_file(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))
        resp = self._call({"items": [{"type": "output", "subfolder": "", "name": "leather.png"}]})
        assert resp._body == {"ok": True, "scanned": 1}
        key = safeview_store.cache_key(
            str(tmp_path / "leather.png"), os.stat(tmp_path / "leather.png")
        )
        cached = safeview_store.read_cached(safeview_store.db_path(str(tmp_path / "_user")), [key])
        assert "nsfw" in cached[key]

    def test_rejects_type_path(self, tmp_path, monkeypatch):
        """Same perimeter as every write and the batch rating read. ComfyUI's own
        output addresses are always sandboxed, so this costs nothing."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        # A valid sandboxed sibling in the SAME batch: `scanned: 0` on its own
        # passes against an endpoint that scans nothing at all, which cannot
        # tell a rejected address from a broken scanner.
        resp = self._call(
            {
                "items": [
                    {"type": "path", "subfolder": str(tmp_path), "name": "leather.png"},
                    {"type": "output", "subfolder": "", "name": "cat.png"},
                ]
            }
        )
        assert resp._body == {"ok": True, "scanned": 1}
        db = safeview_store.db_path(str(tmp_path / "_user"))
        leather_key = safeview_store.cache_key(
            str(tmp_path / "leather.png"), os.stat(tmp_path / "leather.png")
        )
        cat_key = safeview_store.cache_key(
            str(tmp_path / "cat.png"), os.stat(tmp_path / "cat.png")
        )
        cached = safeview_store.read_cached(db, [leather_key, cat_key])
        assert cat_key in cached
        assert leather_key not in cached

    def test_SKIPS_an_unreadable_container_rather_than_failing_the_batch(
        self, tmp_path, monkeypatch
    ):
        """The frontend posts every output of one execution. A mixed batch must
        not lose its images because one entry was an .avi."""
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "clip.avi").write_bytes(b"x")
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = self._call(
            {
                "items": [
                    {"type": "output", "subfolder": "", "name": "clip.avi"},
                    {"type": "output", "subfolder": "", "name": "cat.png"},
                ]
            }
        )
        assert resp._body == {"ok": True, "scanned": 1}

    def test_caps_the_batch(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        items = [
            {"type": "output", "subfolder": "", "name": f"a{i}.png"}
            for i in range(ib.MAX_WARM_BATCH + 1)
        ]
        resp = self._call({"items": items})
        assert resp.status == 400
        assert "max" in resp._body["error"]

    def test_rejects_an_empty_body(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._call({"items": []})
        assert resp.status == 400

    def test_route_is_registered(self):
        registered = PromptServer.instance.routes.registered
        assert any(
            r.method == "POST" and r.path == "/image_browser/safeview_warm" for r in registered
        )


# Imported at the bottom so the class above can reference the stubbed server
# without leaking the import into the pure-helper tests above.
from server import PromptServer  # noqa: E402
