"""Absolute-path reads stop at ComfyUI's directories, setting or no setting (#113).

PR #109 put every absolute-path read behind the default-off setting
``ImageBrowser.AllowAbsolutePathReads``, and the registry still flagged 0.1.32
and 0.1.33 as ``arbitrary-file-read``. The setting is not a boundary against
the caller it is meant to stop: ComfyUI core's ``POST /settings/{id}``
(app/app_settings.py) writes ``comfy.settings.json`` for any caller, with no
authentication, and ``_user_settings`` reads the opt-in back from that same
file. One request switches it on, and with it on the four routes read any
media file on the host.

The setting now chooses whether the browse… tab works at all. Where it can
reach is ComfyUI's own directories: base_path, input/output/temp/user, and
every ``folder_paths`` folder, which includes models, custom_nodes and
``extra_model_paths.yaml`` entries. Widening that needs the server's
filesystem, not an HTTP request. Every test here runs with the setting ON,
because the point is that the reach holds when the setting has been
switched on.
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import folder_paths
import pytest

import image_browser as ib
import thumb_cache

ON = {ib.SETTING_ALLOW_PATH_READS: True}
HINT = "extra_model_paths.yaml"
HEADERS = {"Host": "127.0.0.1:8188", "Sec-Fetch-Site": "same-origin"}


def _req(query):
    return SimpleNamespace(
        rel_url=SimpleNamespace(query=query), headers=dict(HEADERS), comfy_settings=dict(ON)
    )


@pytest.fixture
def layout(tmp_path, monkeypatch):
    """A ComfyUI tree, a model folder registered elsewhere, and a 'home' outside both."""
    comfy = tmp_path / "comfy"
    models = tmp_path / "models-elsewhere" / "checkpoints"
    home = tmp_path / "home" / "Pictures"
    for d in (comfy / "input", models, home):
        d.mkdir(parents=True)
        (d / "photo.png").write_bytes(b"\x89PNG fake")
        (d / "clip.mp4").write_bytes(b"fake")
    monkeypatch.setattr(folder_paths, "base_path", str(comfy), raising=False)
    monkeypatch.setattr(
        folder_paths,
        "folder_names_and_paths",
        {"checkpoints": ([str(models)], {".safetensors"})},
        raising=False,
    )
    encoded: list[str] = []

    def fake_encode(path, *a, **k):
        encoded.append(str(path))
        return b"RIFF-webp"

    monkeypatch.setattr(thumb_cache, "encode_thumb", fake_encode, raising=False)
    # The stubbed get_user_directory() is a MagicMock; keep the cache in tmp.
    monkeypatch.setattr(ib, "_thumb_cache_dir", lambda: str(tmp_path / "thumbs"))
    ib.web.FileResponse.reset_mock()
    return {"comfy": comfy, "models": models, "home": home, "tmp": tmp_path, "encoded": encoded}


# ---------------------------------------------------------------------------
# The reach predicate
# ---------------------------------------------------------------------------


def test_comfy_dirs_and_registered_folders_are_inside(layout):
    assert ib._within_read_roots(str(layout["comfy"] / "custom_nodes" / "x.png"))
    assert ib._within_read_roots(str(layout["models"] / "photo.png"))


def test_outside_every_root_is_outside(layout):
    assert not ib._within_read_roots(str(layout["home"] / "photo.png"))
    assert not ib._within_read_roots("/etc/hosts")


def test_a_lexical_escape_is_outside(layout):
    escape = os.path.join(str(layout["comfy"]), "input", "..", "..", "home", "Pictures", "x.png")
    assert not ib._within_read_roots(escape)


def test_a_name_prefix_sibling_is_outside(layout):
    sibling = layout["tmp"] / "comfy-private"
    sibling.mkdir()
    assert not ib._within_read_roots(str(sibling / "photo.png"))


def test_an_operator_symlink_inside_the_tree_is_followed(layout):
    link = layout["comfy"] / "input" / "photos"
    link.symlink_to(layout["home"], target_is_directory=True)
    assert ib._within_read_roots(str(link / "photo.png"))


@pytest.mark.parametrize("bad", [None, "", ".", "relative/dir", 42])
def test_unusable_folder_paths_entries_admit_nothing(layout, monkeypatch, bad):
    monkeypatch.chdir(layout["home"])
    monkeypatch.setattr(
        folder_paths, "folder_names_and_paths", {"odd": ([bad], set())}, raising=False
    )
    assert not ib._within_read_roots(str(layout["home"] / "photo.png"))


# ---------------------------------------------------------------------------
# The four routes, with the setting ON
# ---------------------------------------------------------------------------


def test_list_refuses_outside_even_with_the_setting_on(layout):
    resp = asyncio.run(ib.image_browser_list(_req({"type": "path", "path": str(layout["home"])})))
    assert resp.status == 403
    assert HINT in resp._body["error"]


def test_list_serves_inside_with_the_setting_on(layout):
    resp = asyncio.run(
        ib.image_browser_list(_req({"type": "path", "path": str(layout["comfy"] / "input")}))
    )
    assert resp.status == 200
    assert "photo.png" in [f["name"] for f in resp._body["files"]]


def test_file_refuses_outside_and_is_no_existence_oracle(layout):
    present = asyncio.run(ib.image_browser_file(_req({"path": str(layout["home"] / "clip.mp4")})))
    absent = asyncio.run(ib.image_browser_file(_req({"path": str(layout["home"] / "gone.mp4")})))
    assert present.status == 403
    assert absent.status == 403
    ib.web.FileResponse.assert_not_called()


def test_file_serves_inside(layout):
    asyncio.run(ib.image_browser_file(_req({"path": str(layout["models"] / "clip.mp4")})))
    ib.web.FileResponse.assert_called_once()


def test_thumb_refuses_outside_and_serves_inside(layout):
    outside = asyncio.run(
        ib.image_browser_thumb(_req({"path": str(layout["home"] / "photo.png")}))
    )
    asyncio.run(
        ib.image_browser_thumb(_req({"path": str(layout["comfy"] / "input" / "photo.png")}))
    )
    assert outside.status == 403
    assert HINT in outside._body["error"]
    # A served thumb is a bare web.Response (a MagicMock under this conftest),
    # so the proof it got through every gate is that the encoder saw the file.
    assert layout["encoded"] == [str(layout["comfy"] / "input" / "photo.png")]


def test_metadata_refuses_outside_and_serves_inside(layout):
    outside = asyncio.run(
        ib.image_browser_metadata(_req({"path": str(layout["home"] / "photo.png")}))
    )
    inside = asyncio.run(
        ib.image_browser_metadata(_req({"path": str(layout["comfy"] / "input" / "photo.png")}))
    )
    assert outside.status == 403
    assert inside.status == 200


def test_a_registered_folder_opens_the_routes(layout, monkeypatch):
    # What an extra_model_paths.yaml entry becomes at runtime.
    monkeypatch.setattr(
        folder_paths,
        "folder_names_and_paths",
        {"photos": ([str(layout["home"])], set())},
        raising=False,
    )
    asyncio.run(ib.image_browser_file(_req({"path": str(layout["home"] / "clip.mp4")})))
    ib.web.FileResponse.assert_called_once()


def test_the_setting_still_gates_inside_the_reach(layout):
    # The reach narrows the setting; it does not replace it.
    req = _req({"path": str(layout["comfy"] / "input" / "clip.mp4")})
    req.comfy_settings = {}
    resp = asyncio.run(ib.image_browser_file(req))
    assert resp.status == 403
    assert resp._body["error"] == ib.PATH_READS_DISABLED_MSG
