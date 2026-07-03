"""Unit tests for the pure/validation helpers in image_browser.

Focus on the security perimeter of the write endpoints: the resolver must reject
arbitrary-path writes, traversal in names, and non-media extensions BEFORE it
touches the (stubbed) folder_paths. Happy-path containment needs a real
folder_paths and is covered by the live smoke matrix.
"""

from __future__ import annotations

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
            r.method == "POST" and r.path == "/image_browser/delete_many"
            for r in registered
        )

    def test_move_many_route_present(self):
        registered = PromptServer.instance.routes.registered
        assert any(
            r.method == "POST" and r.path == "/image_browser/move_many"
            for r in registered
        )


# Imported at the bottom so the class above can reference the stubbed server
# without leaking the import into the pure-helper tests above.
from server import PromptServer  # noqa: E402
