"""Image Browser — backend HTTP endpoints for a full-canvas file explorer.

Uses ComfyUI-bundled libraries ONLY (aiohttp, PIL, plus folder_paths / server
from ComfyUI core) and the Python stdlib (os, shutil, hashlib, ...). Do not add
a Python dependency that ComfyUI does not already ship; if a feature needs one,
make it a separate companion pack.

The pack ships **no node** — it is a pure frontend view (an action-bar button
opens a full-canvas gallery). NODE_CLASS_MAPPINGS is intentionally empty; the
value the pack provides lives entirely in these endpoints + the served bundle.

Endpoint surface (all under /image_browser/):

    GET  /base                              well-known dirs (input/output/temp/base)
    GET  /list?type=&subfolder=&path=&…     directory listing (dirs + files)
    GET  /thumb?path=                       WebP thumbnail for an absolute path
    GET  /file?path=                        stream a file at an absolute path
    POST /delete   {type, subfolder, name}                      delete a file
    POST /rename   {type, subfolder, name, new_name}            rename in place
    POST /move     {type, subfolder, name, dest_type, dest_subfolder}   move

Security posture:

  * Reads (list/thumb/file) accept the sandboxed types (input/output/temp) AND
    arbitrary absolute paths (``type=path``) — the same reach as gallery-loader.
    Arbitrary-path reads are gated on the extension whitelist below.
  * Writes (delete/rename/move) are restricted to the **sandboxed** roots
    (input/output/temp) only — ``type=path`` is rejected. Every write also
    re-asserts a bare (traversal-free) filename, the extension whitelist, and
    containment within the resolved root. Arbitrary-path mutation is out of
    scope for v1 by design.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import shutil
from email.utils import formatdate
from io import BytesIO
from typing import Any

import folder_paths
from aiohttp import web
from PIL import Image
from server import PromptServer

log = logging.getLogger("comfyui-image-browser")

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
# Extensions the /file endpoint streams raw and that /thumb/writes accept. Keep
# narrow — the arbitrary-path read endpoints are the security perimeter.
STREAMABLE_EXTS = IMG_EXTS | VIDEO_EXTS

SANDBOXED_TYPES = ("input", "output", "temp")

# Cover the common cases mimetypes.guess_type misses on some distros.
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")


def _is_image_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMG_EXTS


def _parse_extensions(raw: str) -> set[str]:
    """Parse a CSV extension list ('mp4,webm' or '.png,.jpg') to a normalized set.

    Returns IMG_EXTS | VIDEO_EXTS (all media) when raw is empty — the browser
    lists both images and videos by default.
    """
    if not raw:
        return IMG_EXTS | VIDEO_EXTS
    out: set[str] = set()
    for part in raw.split(","):
        ext = part.strip().lower()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = "." + ext
        out.add(ext)
    return out or (IMG_EXTS | VIDEO_EXTS)


def _resolve_listing_base(type_name: str, subfolder: str, abs_path: str) -> tuple[str | None, str]:
    """Return (base_dir, error_msg). On success error_msg == ''.

    Sandboxed types are constrained to their root; ``path`` accepts any absolute
    directory (read-only reach).
    """
    if type_name in SANDBOXED_TYPES:
        root = folder_paths.get_directory_by_type(type_name)
        if not root:
            return None, f"unknown type: {type_name}"
        target = os.path.abspath(os.path.join(root, subfolder or ""))
        if os.path.commonpath([target, os.path.abspath(root)]) != os.path.abspath(root):
            return None, "subfolder escapes root"
        return target, ""
    if type_name == "path":
        if not abs_path:
            return None, "missing path"
        return os.path.abspath(os.path.expanduser(abs_path)), ""
    return None, f"unknown type: {type_name}"


def _is_bare_name(name: Any) -> bool:
    """True if ``name`` is a single path component with no traversal."""
    return (
        isinstance(name, str)
        and bool(name)
        and os.path.basename(name) == name
        and name not in (".", "..")
    )


def _resolve_sandboxed_file(type_name: str, subfolder: str, name: str) -> tuple[str | None, str]:
    """Resolve a mutation target to an absolute path inside a sandboxed root.

    Enforces: sandboxed type only, bare filename, media extension, and
    containment. Returns (abs_path, '') on success or (None, error).
    """
    if type_name not in SANDBOXED_TYPES:
        return None, "writes are only allowed in input/output/temp"
    if not _is_bare_name(name):
        return None, "invalid name"
    if os.path.splitext(name)[1].lower() not in STREAMABLE_EXTS:
        return None, "unsupported file type"
    base, err = _resolve_listing_base(type_name, subfolder, "")
    if err:
        return None, err
    assert base is not None
    target = os.path.abspath(os.path.join(base, name))
    if os.path.commonpath([target, base]) != base:
        return None, "name escapes root"
    return target, ""


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------


@PromptServer.instance.routes.get("/image_browser/base")
async def image_browser_base(request: web.Request) -> web.Response:
    """Expose ComfyUI's well-known directories so the frontend hard-codes none."""
    return web.json_response(
        {
            "ok": True,
            "base_path": folder_paths.base_path,
            "input_dir": folder_paths.get_input_directory(),
            "output_dir": folder_paths.get_output_directory(),
            "temp_dir": folder_paths.get_temp_directory(),
            "user_dir": folder_paths.get_user_directory(),
        }
    )


@PromptServer.instance.routes.get("/image_browser/list")
async def image_browser_list(request: web.Request) -> web.Response:
    q = request.rel_url.query
    type_name = q.get("type", "output")
    subfolder = q.get("subfolder", "")
    abs_path = q.get("path", "")
    exts = _parse_extensions(q.get("extensions", ""))
    image_subset = exts & IMG_EXTS

    base, err = _resolve_listing_base(type_name, subfolder, abs_path)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert base is not None

    if not os.path.isdir(base):
        return web.json_response(
            {
                "ok": True,
                "type": type_name,
                "subfolder": subfolder,
                "path": base,
                "dirs": [],
                "files": [],
                "exists": False,
            }
        )

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    try:
        with os.scandir(base) as it:
            for entry in it:
                try:
                    if entry.name.startswith("."):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name in ("clipspace", "__pycache__"):
                            continue
                        st = entry.stat(follow_symlinks=False)
                        dirs.append({"name": entry.name, "mtime": st.st_mtime})
                    elif entry.is_file(follow_symlinks=False):
                        ext = os.path.splitext(entry.name)[1].lower()
                        if ext not in exts:
                            continue
                        st = entry.stat(follow_symlinks=False)
                        width: int | None = None
                        height: int | None = None
                        if ext in image_subset:
                            try:
                                # PIL.Image.open is lazy — only the header is read
                                # until pixel access, so .size is cheap.
                                with Image.open(entry.path) as im:
                                    width, height = im.size
                            except Exception:
                                pass
                        files.append(
                            {
                                "name": entry.name,
                                "mtime": st.st_mtime,
                                "size": st.st_size,
                                "width": width,
                                "height": height,
                                "ext": ext,
                            }
                        )
                except OSError:
                    continue
    except PermissionError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=403)
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    dirs.sort(key=lambda d: d["name"].lower())
    files.sort(key=lambda f: f["mtime"], reverse=True)

    return web.json_response(
        {
            "ok": True,
            "type": type_name,
            "subfolder": subfolder,
            "path": base,
            "dirs": dirs,
            "files": files,
            "exists": True,
        }
    )


@PromptServer.instance.routes.get("/image_browser/file")
async def image_browser_file(request: web.Request) -> web.Response:
    """Stream a file at an absolute path (whitelisted extensions only).

    Used to preview videos in type=path listings — core /api/view only serves
    files under input/output/temp.
    """
    q = request.rel_url.query
    abs_path = q.get("path", "")
    if not abs_path:
        return web.Response(status=400)
    path = os.path.abspath(os.path.expanduser(abs_path))
    if not os.path.isfile(path):
        return web.Response(status=404)
    if os.path.splitext(path)[1].lower() not in STREAMABLE_EXTS:
        return web.Response(status=403)
    mime, _ = mimetypes.guess_type(path)
    return web.FileResponse(
        path,
        headers={
            "Content-Type": mime or "application/octet-stream",
            "Cache-Control": "private, max-age=300",
        },
    )


@PromptServer.instance.routes.get("/image_browser/thumb")
async def image_browser_thumb(request: web.Request) -> web.Response:
    """WebP thumbnail for type=path (absolute) image listings.

    For input/output/temp the frontend uses core /api/view (subfolder + preview
    scaling built in). Arbitrary absolute paths are served here — small,
    image-only, with cache validators so re-scrolls reuse the cached copy.
    """
    q = request.rel_url.query
    abs_path = q.get("path", "")
    if not abs_path:
        return web.Response(status=400)
    path = os.path.abspath(os.path.expanduser(abs_path))
    if not os.path.isfile(path) or not _is_image_file(path):
        return web.Response(status=404)

    try:
        st = os.stat(path)
    except OSError as exc:
        log.warning("thumb stat failed for %s: %s", path, exc)
        return web.Response(status=404)
    etag = '"{}"'.format(
        hashlib.sha1(f"{path}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()
    )
    cache_headers = {
        "ETag": etag,
        "Last-Modified": formatdate(st.st_mtime, usegmt=True),
        "Cache-Control": "private, max-age=300",
    }
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=cache_headers)

    try:
        with Image.open(path) as im:
            im.thumbnail((512, 512))
            im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
            buf = BytesIO()
            im.save(buf, format="webp", quality=80)
            buf.seek(0)
            return web.Response(body=buf.read(), content_type="image/webp", headers=cache_headers)
    except Exception as exc:
        log.warning("thumb failed for %s: %s", path, exc)
        return web.Response(status=500)


# ---------------------------------------------------------------------------
# Write endpoints — sandboxed roots only (input/output/temp)
# ---------------------------------------------------------------------------


async def _read_json(request: web.Request) -> tuple[dict[str, Any] | None, web.Response | None]:
    try:
        body = await request.json()
    except Exception:
        return None, web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return None, web.json_response({"ok": False, "error": "invalid body"}, status=400)
    return body, None


@PromptServer.instance.routes.post("/image_browser/delete")
async def image_browser_delete(request: web.Request) -> web.Response:
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    target, err = _resolve_sandboxed_file(
        body.get("type", ""), body.get("subfolder") or "", body.get("name", "")
    )
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert target is not None
    if not os.path.isfile(target):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)
    try:
        os.remove(target)
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/image_browser/rename")
async def image_browser_rename(request: web.Request) -> web.Response:
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    type_name = body.get("type", "")
    subfolder = body.get("subfolder") or ""
    src, err = _resolve_sandboxed_file(type_name, subfolder, body.get("name", ""))
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert src is not None
    dst, err = _resolve_sandboxed_file(type_name, subfolder, body.get("new_name", ""))
    if err:
        return web.json_response({"ok": False, "error": f"new_name: {err}"}, status=400)
    assert dst is not None

    if not os.path.isfile(src):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)
    if os.path.exists(dst):
        return web.json_response({"ok": False, "error": "target name already exists"}, status=409)
    try:
        os.rename(src, dst)
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True, "name": os.path.basename(dst)})


@PromptServer.instance.routes.post("/image_browser/move")
async def image_browser_move(request: web.Request) -> web.Response:
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    name = body.get("name", "")
    src, err = _resolve_sandboxed_file(body.get("type", ""), body.get("subfolder") or "", name)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert src is not None

    # Destination keeps the same filename; only the folder changes.
    dst, err = _resolve_sandboxed_file(
        body.get("dest_type", ""), body.get("dest_subfolder") or "", name
    )
    if err:
        return web.json_response({"ok": False, "error": f"destination: {err}"}, status=400)
    assert dst is not None

    if not os.path.isfile(src):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)
    if os.path.abspath(src) == os.path.abspath(dst):
        return web.json_response(
            {"ok": False, "error": "source and destination are the same"}, status=400
        )
    if os.path.exists(dst):
        return web.json_response(
            {"ok": False, "error": "a file with that name already exists at the destination"},
            status=409,
        )
    dst_dir = os.path.dirname(dst)
    if not os.path.isdir(dst_dir):
        return web.json_response(
            {"ok": False, "error": "destination folder does not exist"}, status=404
        )
    try:
        shutil.move(src, dst)
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True})


# No custom node — this pack is a pure frontend view. Keeping the mappings empty
# (but present) satisfies ComfyUI's loader and the pack's __init__ contract.
NODE_CLASS_MAPPINGS: dict[str, Any] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}
