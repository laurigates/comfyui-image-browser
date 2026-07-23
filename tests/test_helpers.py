"""Unit tests for the pure/validation helpers in image_browser.

Focus on the security perimeter of the write endpoints: the resolver must reject
arbitrary-path writes, traversal in names, and non-media extensions BEFORE it
touches the (stubbed) folder_paths. Happy-path containment needs a real
folder_paths and is covered by the live smoke matrix.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import image_browser as ib


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


# Imported at the bottom so the class above can reference the stubbed server
# without leaking the import into the pure-helper tests above.
from server import PromptServer  # noqa: E402
