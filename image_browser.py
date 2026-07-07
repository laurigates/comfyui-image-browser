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
    GET  /thumb?path= | ?type=&subfolder=&name=   cached WebP thumbnail
    GET  /file?path=                        stream a file at an absolute path
    POST /delete       {type, subfolder, name}                      delete a file
    POST /delete_many  {items:[{type,subfolder,name}, …]}           batch delete
    POST /rename       {type, subfolder, name, new_name}            rename in place
    POST /move         {type, subfolder, name, dest_type, dest_subfolder}   move
    POST /move_many    {items:[{type,subfolder,name}, …], dest_type, dest_subfolder} batch move
    POST /rmdir        {type, subfolder, name, recursive}           delete a folder
    POST /mkdir        {type, subfolder, name}                       create a folder
    POST /rating       {type, subfolder, name, rating}              0..5 star rating

Security posture:

  * Reads (list/thumb/file) accept the sandboxed types (input/output/temp) AND
    arbitrary absolute paths (``type=path``) — the same reach as gallery-loader.
    Arbitrary-path reads are gated on the extension whitelist below.
  * Writes (delete/rename/move/rating) are restricted to the **sandboxed**
    roots (input/output/temp) only — ``type=path`` is rejected. Every write also
    re-asserts a bare (traversal-free) filename, the extension whitelist, and
    containment within the resolved root. Arbitrary-path mutation is out of
    scope for v1 by design.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import shutil
from email.utils import formatdate
from typing import Any

import folder_paths
from aiohttp import web
from PIL import Image
from server import PromptServer

try:
    # ComfyUI imports custom_nodes as packages, so the sibling module must
    # be pulled in relatively — a bare ``import xmp_meta`` raises
    # ModuleNotFoundError at load time because the pack dir isn't on sys.path.
    from . import thumb_cache, xmp_meta
except ImportError:
    # Pytest imports this module flat (pack root on sys.path via pyproject's
    # ``pythonpath = ["."]``); fall back to the absolute import.
    import thumb_cache
    import xmp_meta

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


def _resolve_sandboxed_dir(type_name: str, subfolder: str, name: str) -> tuple[str | None, str]:
    """Resolve a directory mutation target inside a sandboxed root.

    Same perimeter as ``_resolve_sandboxed_file`` (sandboxed type only, bare
    name, containment) minus the media-extension gate — directories have no
    extension. The bare-name check guarantees the target is strictly below the
    root, so the root itself can never be the target.
    """
    if type_name not in SANDBOXED_TYPES:
        return None, "writes are only allowed in input/output/temp"
    if not _is_bare_name(name):
        return None, "invalid name"
    base, err = _resolve_listing_base(type_name, subfolder, "")
    if err:
        return None, err
    assert base is not None
    target = os.path.abspath(os.path.join(base, name))
    if os.path.commonpath([target, base]) != base:
        return None, "name escapes root"
    return target, ""


def _count_dir_contents(target: str) -> tuple[int, int]:
    """Return (files, dirs) nested anywhere under ``target`` (target excluded).

    Symlinks are not followed, so a link inside the tree counts as one file
    and its destination is never traversed.
    """
    n_files = 0
    n_dirs = 0
    for _root, dirnames, filenames in os.walk(target, followlinks=False):
        n_dirs += len(dirnames)
        n_files += len(filenames)
    return n_files, n_dirs


def _err(message: str, status: int) -> web.Response:
    """Uniform JSON error response: ``{"ok": false, "error": <message>}``.

    Every endpoint (reads and writes) returns errors through this shape so a
    client gets a machine-readable reason on any status, never a bodyless
    ``web.Response(status=...)``.
    """
    return web.json_response({"ok": False, "error": message}, status=status)


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
                            except Exception as exc:
                                # Corrupt/unreadable image header — omit
                                # dimensions but keep listing the file.
                                log.debug("size probe failed for %s: %s", entry.path, exc)
                        try:
                            rating = xmp_meta.read_rating_cached(entry.path, st)
                        except Exception as exc:
                            # Bad/absent XMP packet — treat as unrated (0) but
                            # record why the probe failed.
                            log.debug("rating probe failed for %s: %s", entry.path, exc)
                            rating = 0
                        files.append(
                            {
                                "name": entry.name,
                                "mtime": st.st_mtime,
                                "size": st.st_size,
                                "width": width,
                                "height": height,
                                "ext": ext,
                                "rating": rating,
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
        return _err("missing path", 400)
    path = os.path.abspath(os.path.expanduser(abs_path))
    if not os.path.isfile(path):
        return _err("file not found", 404)
    if os.path.splitext(path)[1].lower() not in STREAMABLE_EXTS:
        return _err("unsupported file type", 403)
    mime, _ = mimetypes.guess_type(path)
    return web.FileResponse(
        path,
        headers={
            "Content-Type": mime or "application/octet-stream",
            "Cache-Control": "private, max-age=300",
        },
    )


def _resolve_thumb_target(q: Any) -> tuple[str | None, str]:
    """Resolve /thumb query params to an absolute file path.

    Two addressing modes, mirroring /list:
      ?type=input|output|temp&subfolder=&name=   (sandboxed roots)
      ?path=/abs/file.png                        (arbitrary read, image-gated)
    """
    type_name = q.get("type", "path")
    if type_name in SANDBOXED_TYPES:
        name = q.get("name", "")
        if not _is_bare_name(name):
            return None, "invalid name"
        base, err = _resolve_listing_base(type_name, q.get("subfolder", ""), "")
        if err:
            return None, err
        assert base is not None
        target = os.path.abspath(os.path.join(base, name))
        if os.path.commonpath([target, base]) != base:
            return None, "name escapes root"
        return target, ""
    abs_path = q.get("path", "")
    if not abs_path:
        return None, "missing path"
    return os.path.abspath(os.path.expanduser(abs_path)), ""


def _thumb_cache_dir() -> str:
    # Resolved lazily (not at import) so test stubs of folder_paths don't
    # break module load. The same <user_dir>/comfy-thumb-cache is used by
    # comfyui-gallery-loader — the packs share encoded thumbnails.
    return os.path.join(str(folder_paths.get_user_directory()), thumb_cache.CACHE_DIR_NAME)


@PromptServer.instance.routes.get("/image_browser/thumb")
async def image_browser_thumb(request: web.Request) -> web.Response:
    """WebP thumbnail for any listed image — sandboxed roots AND type=path.

    Core /api/view re-encodes previews on every request with no cache
    headers, so sandboxed thumbnails are served here instead: through the
    shared on-disk cache (thumb_cache.py) with an ETag and a long max-age.
    The frontend embeds ?v=<mtime>-<size> in the URL, so a changed file
    keys a new URL and a stale cached copy can never be shown.
    """
    path, err = _resolve_thumb_target(request.rel_url.query)
    if err:
        return _err(err, 400)
    assert path is not None
    if not os.path.isfile(path) or not _is_image_file(path):
        return _err("not found", 404)

    try:
        st = os.stat(path)
    except OSError as exc:
        log.warning("thumb stat failed for %s: %s", path, exc)
        return _err("not found", 404)
    etag = thumb_cache.etag_for(path, st)
    cache_headers = {
        "ETag": etag,
        "Last-Modified": formatdate(st.st_mtime, usegmt=True),
        "Cache-Control": "private, max-age=604800, immutable",
    }
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=cache_headers)

    data = thumb_cache.get_thumb(path, st, _thumb_cache_dir())
    if data is None:
        log.warning("thumbnail encode failed for %s", path)
        return _err("thumbnail encode failed", 500)
    return web.Response(body=data, content_type="image/webp", headers=cache_headers)


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
        log.exception("delete failed for %s", target)
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
        log.exception("rename failed for %s -> %s", src, dst)
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
        log.exception("move failed for %s -> %s", src, dst)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True})


def _validate_batch_items(
    body: dict[str, Any],
) -> tuple[list[dict[str, Any]] | None, web.Response | None]:
    """Validate the ``items`` list of a batch body. Returns (items, None) or (None, resp).

    Each item's per-field shape (type/subfolder/name) is enforced downstream
    by ``_resolve_sandboxed_file`` — here we only assert the body is a
    non-empty list of objects, so a malformed top-level request 400s before
    any disk touch.
    """
    items = body.get("items")
    if not isinstance(items, list) or not items:
        return None, web.json_response(
            {"ok": False, "error": "items must be a non-empty list"}, status=400
        )
    for item in items:
        if not isinstance(item, dict):
            return None, web.json_response(
                {"ok": False, "error": "items must be objects"}, status=400
            )
    return items, None


@PromptServer.instance.routes.post("/image_browser/delete_many")
async def image_browser_delete_many(request: web.Request) -> web.Response:
    """Delete multiple files in one request (batch delete).

    Body: ``{items: [{type, subfolder, name}, ...]}``. Each item goes through
    ``_resolve_sandboxed_file`` (rejects ``type=path``, traversal, non-media),
    so the security perimeter is identical to single delete. Per-item errors
    are collected so partial successes surface to the caller instead of
    short-circuiting the whole batch.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None
    items, err_resp = _validate_batch_items(body)
    if err_resp:
        return err_resp
    assert items is not None

    deleted = 0
    errors: list[dict[str, str]] = []
    for item in items:
        name = item.get("name", "")
        target, err = _resolve_sandboxed_file(
            item.get("type", ""), item.get("subfolder") or "", name
        )
        if err:
            errors.append({"name": name, "error": err})
            continue
        assert target is not None
        if not os.path.isfile(target):
            errors.append({"name": name, "error": "file not found"})
            continue
        try:
            os.remove(target)
            deleted += 1
        except OSError as exc:
            log.exception("batch delete failed for %s", target)
            errors.append({"name": name, "error": str(exc)})
    return web.json_response({"ok": True, "deleted": deleted, "errors": errors})


@PromptServer.instance.routes.post("/image_browser/move_many")
async def image_browser_move_many(request: web.Request) -> web.Response:
    """Move multiple files into one destination folder in one request.

    Body: ``{items: [{type, subfolder, name}, ...], dest_type, dest_subfolder}``.
    Each item's source AND destination go through ``_resolve_sandboxed_file``
    (rejects ``type=path``, traversal, non-media). Basename is kept; the
    destination folder is resolved per item so a bad dest surfaces per-file.
    Per-item errors are collected so partial successes surface to the caller.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None
    items, err_resp = _validate_batch_items(body)
    if err_resp:
        return err_resp
    assert items is not None

    dest_type = body.get("dest_type", "")
    dest_subfolder = body.get("dest_subfolder") or ""

    moved = 0
    errors: list[dict[str, str]] = []
    for item in items:
        name = item.get("name", "")
        src, err = _resolve_sandboxed_file(item.get("type", ""), item.get("subfolder") or "", name)
        if err:
            errors.append({"name": name, "error": err})
            continue
        assert src is not None
        dst, err = _resolve_sandboxed_file(dest_type, dest_subfolder, name)
        if err:
            errors.append({"name": name, "error": f"destination: {err}"})
            continue
        assert dst is not None
        if not os.path.isfile(src):
            errors.append({"name": name, "error": "file not found"})
            continue
        if os.path.abspath(src) == os.path.abspath(dst):
            errors.append({"name": name, "error": "source and destination are the same"})
            continue
        if os.path.exists(dst):
            errors.append(
                {"name": name, "error": "a file with that name already exists at the destination"}
            )
            continue
        dst_dir = os.path.dirname(dst)
        if not os.path.isdir(dst_dir):
            errors.append({"name": name, "error": "destination folder does not exist"})
            continue
        try:
            shutil.move(src, dst)
            moved += 1
        except OSError as exc:
            log.exception("batch move failed for %s -> %s", src, dst)
            errors.append({"name": name, "error": str(exc)})
    return web.json_response({"ok": True, "moved": moved, "errors": errors})


@PromptServer.instance.routes.post("/image_browser/rmdir")
async def image_browser_rmdir(request: web.Request) -> web.Response:
    """Delete a folder inside a sandboxed root.

    Body: ``{type, subfolder, name, recursive?}``. An empty folder is removed
    outright. A non-empty folder without ``recursive: true`` returns 409 with
    the nested ``files``/``dirs`` counts so the client can surface a confirm
    ("contains N files") and re-post with ``recursive: true``, which rmtree-s
    the whole subtree. Same write perimeter as the file mutations: sandboxed
    types only, bare traversal-free name, containment (ADR-0002). Symlinked
    directories are rejected — deleting through a link could reach outside
    the sandbox.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    target, err = _resolve_sandboxed_dir(
        body.get("type", ""), body.get("subfolder") or "", body.get("name", "")
    )
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert target is not None
    if os.path.islink(target):
        return web.json_response(
            {"ok": False, "error": "refusing to delete a symlink"}, status=400
        )
    if not os.path.isdir(target):
        return web.json_response({"ok": False, "error": "folder not found"}, status=404)

    n_files, n_dirs = _count_dir_contents(target)
    recursive = body.get("recursive") is True
    if (n_files or n_dirs) and not recursive:
        return web.json_response(
            {"ok": False, "error": "folder is not empty", "files": n_files, "dirs": n_dirs},
            status=409,
        )
    try:
        if n_files or n_dirs:
            shutil.rmtree(target)
        else:
            os.rmdir(target)
    except OSError as exc:
        log.exception("rmdir failed for %s", target)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True, "files": n_files, "dirs": n_dirs})


@PromptServer.instance.routes.post("/image_browser/mkdir")
async def image_browser_mkdir(request: web.Request) -> web.Response:
    """Create a folder inside a sandboxed root.

    Body: ``{type, subfolder, name}``. Same write perimeter as the file/folder
    mutations: sandboxed types only (``type=path`` rejected), a bare
    traversal-free name, and containment (ADR-0002). The new folder is created
    directly under the current ``subfolder``, so its parent must already exist —
    a missing parent answers 404. An existing target answers 409 so the client
    can surface a name collision rather than silently succeeding.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    target, err = _resolve_sandboxed_dir(
        body.get("type", ""), body.get("subfolder") or "", body.get("name", "")
    )
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert target is not None
    if not os.path.isdir(os.path.dirname(target)):
        return web.json_response(
            {"ok": False, "error": "parent folder does not exist"}, status=404
        )
    if os.path.exists(target):
        return web.json_response(
            {"ok": False, "error": "a file or folder with that name already exists"},
            status=409,
        )
    try:
        os.mkdir(target)
    except OSError as exc:
        log.exception("mkdir failed for %s", target)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return web.json_response({"ok": True, "name": os.path.basename(target)})


def _parse_rating(value: Any) -> int | None:
    """Return the rating as an int 0..5, or None when invalid.

    Rejects bool (a JSON ``true`` is an ``int`` subclass in Python) and
    anything outside the star range — the endpoint 400s rather than clamps,
    so a buggy client is surfaced instead of silently rounded.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if not (0 <= value <= 5):
        return None
    return value


@PromptServer.instance.routes.post("/image_browser/rating")
async def image_browser_rating(request: web.Request) -> web.Response:
    """Persist a 0..5 star rating into a file's XMP (or a sidecar).

    Body: ``{type, subfolder, name, rating}``. Rating writes mutate the file,
    so they go through the same sandbox gate as delete/rename/move —
    ``type=path`` is rejected (ADR-0002: writes only in input/output/temp).
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    rating = _parse_rating(body.get("rating"))
    if rating is None:
        return web.json_response(
            {"ok": False, "error": "rating must be an integer 0..5"}, status=400
        )

    target, err = _resolve_sandboxed_file(
        body.get("type", ""), body.get("subfolder") or "", body.get("name", "")
    )
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert target is not None
    if not os.path.isfile(target):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)

    ok, backend = xmp_meta.write_rating(target, rating)
    if not ok:
        log.error("rating write failed for %s: %s", target, backend)
        return web.json_response({"ok": False, "error": backend}, status=500)
    return web.json_response({"ok": True, "rating": rating, "backend": backend})


# No custom node — this pack is a pure frontend view. Keeping the mappings empty
# (but present) satisfies ComfyUI's loader and the pack's __init__ contract.
NODE_CLASS_MAPPINGS: dict[str, Any] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}
