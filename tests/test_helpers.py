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
