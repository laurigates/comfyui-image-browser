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
    GET  /metadata?path= | ?type=&subfolder=&name=  embedded generation metadata
    GET  /file?path=                        stream a file at an absolute path (OPT-IN)
    POST /delete       {type, subfolder, name}                      delete a file
    POST /delete_many  {items:[{type,subfolder,name}, …]}           batch delete
    POST /rename       {type, subfolder, name, new_name}            rename in place
    POST /move         {type, subfolder, name, dest_type, dest_subfolder}   move a file
    POST /move_dir     {type, subfolder, name, dest_type, dest_subfolder}   move a folder
    POST /move_many    {items:[{type,subfolder,name}, …], dest_type, dest_subfolder} batch move
    POST /rmdir        {type, subfolder, name, recursive}           delete a folder
    POST /mkdir        {type, subfolder, name}                       create a folder
    POST /rating       {type, subfolder, name, rating}              0..5 star rating
    POST /ratings      {items:[{type,subfolder,name}, …]}           batch rating READ
    GET  /pins                                    pinned folders + media, resolved
    POST /pins         {op:add|remove|prune, item?}                 one pin delta

Threat model and security posture
=================================

ComfyUI serves this pack's endpoints from its own single HTTP server, which
ships **no authentication**. The realistic attacker is therefore not someone
who has already reached the port — it is a **web page in the user's browser**
that has not. Every gate below is written against that attacker.

1. Cross-origin writes (the CSRF class).
   ``aiohttp``'s server-side ``BaseRequest.json()`` is literally
   ``body = await self.text(); return loads(body)`` — it never inspects
   ``Content-Type``. So a page on any origin could reach every POST handler
   here with a plain ``<form enctype="text/plain">``, which is a CORS-*simple*
   request and is sent with **no preflight**. Verified by execution against
   aiohttp 3.11.13: a JSON body was accepted under ``text/plain``,
   ``multipart/form-data`` and ``application/x-www-form-urlencoded`` alike.

   Both mutation gates live in ``_guard_mutation`` and are applied to **every**
   POST route in this file, immediately below its ``@routes.post`` line so the
   wrapper is what gets registered:

     * ``Content-Type: application/json`` is REQUIRED (415 otherwise). A form
       cannot set that header, so the endpoints stop being CORS-simple and a
       cross-origin call now needs a preflight the server never grants.
     * The request must not be cross-site: ``Sec-Fetch-Site: cross-site`` is
       refused, and when that browser-set header is absent an ``Origin`` whose
       host differs from ``Host`` is refused (403).

   Deliberately NOT a CSRF token. Per Fetch, ``Origin`` is sent on every
   non-GET/HEAD request, so a browser cannot reach these handlers without one
   of the two headers above; a token would buy no additional browser defence
   while forking the shared rating helper and breaking any cached bundle.
   A request carrying neither header (curl, a script, ComfyUI's own API
   clients) is allowed through: this is a browser-CSRF gate, not authentication.

2. Arbitrary file reads.
   ``GET /file`` streams raw bytes from an absolute host path. That reach is
   **off by default** and only exists when the user switches on the ComfyUI
   setting ``ImageBrowser.AllowAbsolutePathReads`` (Settings -> Touch Tools ->
   Image Browser). The setting is read server-side from the user's own
   ``comfy.settings.json`` through ComfyUI's user manager — it can not be
   turned on by a request parameter or a header. Off, ``/file`` answers 403
   before it touches the filesystem, so it is not even an existence oracle.

   ``/list``, ``/thumb`` and ``/metadata`` still accept ``type=path``: that is
   the pack's declared feature (browse any folder), and none of them returns a
   file's bytes — ``/thumb`` re-encodes to a bounded WebP, ``/metadata``
   returns parsed fields, ``/list`` returns names and sizes. ``/file`` is the
   only endpoint that hands back the file itself, which is why it is the one
   behind a switch.

3. Path traversal and symlink escape on the mutation path.
   Writes (delete/rename/move/move_dir/rmdir/mkdir/rating/tag) are restricted
   to the sandboxed roots (input/output/temp); ``type=path`` is rejected. Each
   re-asserts a bare traversal-free filename, the extension whitelist, and
   **two independent containment checks**: the lexical one (which rejects
   ``..`` before any syscall) and a ``realpath`` one (which rejects a target
   that resolves outside its base through a symlink). The realpath gate is on
   the MUTATION resolvers only — a symlinked output subfolder is a supported
   layout and must keep listing.

4. Unbounded destructive work.
   Batch mutations are capped (``MAX_MUTATION_BATCH``) and a recursive folder
   delete is refused above ``MAX_RMDIR_ENTRIES``, counted with an early exit so
   a pathological tree cannot stall the event loop before the cap can refuse.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import mimetypes
import os
import re
import shutil
import time
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
    from . import image_meta, pins_store, safeview_store, thumb_cache, xmp_meta
except ImportError:
    # Pytest imports this module flat (pack root on sys.path via pyproject's
    # ``pythonpath = ["."]``); fall back to the absolute import.
    import image_meta
    import pins_store
    import safeview_store
    import thumb_cache
    import xmp_meta

log = logging.getLogger("comfyui-image-browser")

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
# Extensions the /file endpoint streams raw and that /thumb/writes accept. Keep
# narrow — the arbitrary-path read endpoints are the security perimeter.
STREAMABLE_EXTS = IMG_EXTS | VIDEO_EXTS

SANDBOXED_TYPES = ("input", "output", "temp")

# The ComfyUI setting that opts INTO arbitrary absolute-path byte reads through
# GET /file. Registered by the frontend (src/index.ts) with defaultValue false
# and read back server-side; see the module docstring, section 2. The id is
# FROZEN — persistence is keyed on it end to end, so renaming it would silently
# reset the user's choice back to the safe default (which is at least the safe
# direction, but it would look like the switch stopped working).
SETTING_ALLOW_PATH_READS = "ImageBrowser.AllowAbsolutePathReads"

# Upper bound on the items a batch MUTATION (delete_many / move_many) may carry.
# The read-side batches were already capped (MAX_WARM_BATCH=64,
# MAX_RATING_BATCH=200); until this existed a single request could hand the
# server an unbounded list of files to delete. Same value as the rating cap:
# large enough for "select the whole page and bin it", small enough that one
# request cannot walk a library.
MAX_MUTATION_BATCH = 200

# Upper bound on the entries a RECURSIVE folder delete may destroy in one call.
# Above it /rmdir refuses with 413 rather than rmtree-ing the subtree, so the
# unbounded-destruction primitive has a ceiling. Counted through
# `_count_dir_contents(..., limit=...)`, which short-circuits at the cap — an
# uncapped os.walk of a pathological tree would stall the event loop BEFORE the
# cap could refuse, which would defeat the point of having one.
MAX_RMDIR_ENTRIES = 10_000

# Upper bound on files a recursive ("flat") listing RETURNS. The walk itself
# always covers the whole subtree (see FLAT_WALK_CAP) and the cap is applied
# after an mtime sort, so a truncated response holds the newest N files — not
# whichever N a directory-order walk happened to reach first. That ordering is
# the point of the flat view (find a recent render wherever it landed), and it
# also means the expensive per-file probes run only on files that ship.
FLAT_LIST_CAP = 5000

# Backstop on the cheap enumeration pass. Phase 1 only stats entries (no file
# opens), so this is far higher than FLAT_LIST_CAP and exists purely so a
# pathological tree cannot make the request unbounded. Hitting it also marks the
# response truncated, since the newest-N guarantee no longer holds.
FLAT_WALK_CAP = 200_000

# Upper bound on a NON-recursive listing. Same newest-N semantics as above.
# Without it a 50k-file directory costs 50k header opens plus 50k rating reads
# on the event loop, and 50k cards in one grid is well past usable either way.
# Mirrored in comfyui-gallery-loader, which had the identical hole.
DIR_LIST_CAP = 5000

# How far past the cap `_probe_newest` may probe while Safe View is HIDING, to
# refill a page whose rows were dropped for their `dc:subject` keywords. Only
# the tag tier needs this: the name/path tier filters before any probe, so it
# costs nothing, while a tag verdict is only known after the file is opened.
# Without a factor a tree where everything is tagged would open every file in
# it; with one, the honest answer to that tree is a short page marked
# `truncated`. Same value and same reasoning as comfyui-gallery-loader's.
PROBE_BUDGET_FACTOR = 4

# Cover the common cases mimetypes.guess_type misses on some distros.
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")


def _is_image_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMG_EXTS


# Extensions /metadata will answer for. Images keep their historical behaviour
# — every IMG_EXTS member is accepted, and one whose format has no parser (a
# .gif) answers 200 with empty metadata rather than an error. Videos are
# admitted only where image_meta actually has a reader, DERIVED from its
# FORMAT_EXTS rather than re-listed here: the same set gates the frontend's
# ⓘ / ⤓ buttons, so a hand-copy that drifted would ship a control that 400s.
# That is why .avi/.mpg stay out — they are in VIDEO_EXTS but have no reader.
METADATA_EXTS = IMG_EXTS | (VIDEO_EXTS & set(image_meta.FORMAT_EXTS))


def _has_metadata_reader(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in METADATA_EXTS


# The media families /list's `kind=` param narrows to — the toolbar's
# All / Images / Videos filter. Enumerable rather than an if/elif of string
# literals so the frontend's VALID_FILTERS can be asserted against it: a
# one-character drift between the two sides ("videos" vs "video") would
# otherwise be a silent no-filter that no test could see. An unrecognised key
# narrows nothing, matching how `recursive` treats a value it can't parse.
KIND_FILTERS: dict[str, set[str]] = {"images": IMG_EXTS, "videos": VIDEO_EXTS}


# ---------------------------------------------------------------------------
# Safe View — server-side hiding of keyword-matched entries
# ---------------------------------------------------------------------------
#
# THIS IS DISCRETION, NOT ACCESS CONTROL. `safe_hide` is a rendering preference
# the browser asks for; every other endpoint still serves the same files to the
# same caller, and nothing here authenticates anyone. It keeps a folder of
# sensitive renders off the screen while someone is looking over your shoulder.
# Do not grow it into a permission boundary — the perimeter that actually
# matters is the extension whitelist plus `_resolve_sandboxed_file`, and mixing
# a cosmetic filter into it would make both harder to reason about.
#
# The matcher is a DIRECT PORT of the frontend kit's `tokenize` / `parseKeywords`
# (comfy-modal-kit/src/safe-view.ts). The two sides must agree exactly: hiding
# happens here, blurring happens there, and a file that one considers sensitive
# and the other does not is a file that appears blurred in one grid and plain in
# the other. The two control cases below are what pin the agreement — a
# substring implementation passes every positive test and fails only these.
_SAFE_TOKEN_SPLIT = re.compile(r"[^a-z0-9]+")
_SAFE_KEYWORD_SPLIT = re.compile(r"[\s,]+")
_SAFE_KEYWORD_STRIP = re.compile(r"[^a-z0-9]")


def safe_tokenize(value: str) -> set[str]:
    """Split a haystack into lowercase alphanumeric tokens (port of `tokenize`).

    WHOLE TOKENS, never substrings. ``output/nsfw/2026-08-04`` and
    ``my_nsfw_pic.png`` both yield an ``nsfw`` token, while ``assets`` yields
    only ``assets`` — so the keyword ``ass`` does not match it, and ``nsfw``
    does not match ``nsfwish.png``. Substring matching silently hides unrelated
    work, and the user cannot tell a deliberate match from an accidental one
    because both look identical: a file that simply is not there.
    """
    return {t for t in _SAFE_TOKEN_SPLIT.split(value.lower()) if t}


def parse_safe_keywords(raw: str) -> set[str]:
    """Parse the `safe_kw` query value into keyword tokens (port of `parseKeywords`).

    Accepts commas and/or whitespace as separators and strips every
    non-alphanumeric character from each keyword — a keyword carrying
    punctuation could never equal a token from :func:`safe_tokenize`, so
    normalizing it here is what keeps ``"nsfw,"`` working. Returns a set: the
    frontend preserves order for display, but matching is an intersection.
    """
    if not raw:
        return set()
    out: set[str] = set()
    for piece in _SAFE_KEYWORD_SPLIT.split(raw):
        kw = _SAFE_KEYWORD_STRIP.sub("", piece.lower())
        if kw:
            out.add(kw)
    return out


def is_safe_match(keywords: set[str], *parts: str) -> bool:
    """Whether any of `parts` contributes a token matching one of `keywords`.

    ``parts`` are the pieces of the entry's LOGICAL address — its name, its
    root (``output``), and every folder segment above it. Logical, never the
    resolved OS path: ``/home/lauri/ComfyUI/output/nsfw`` would put ``home``,
    ``lauri`` and ``comfyui`` into every haystack, so a keyword of ``comfyui``
    would hide the entire library — and the frontend, which never sees those
    segments, would disagree about which files matched.

    A file's ``dc:subject`` KEYWORDS are a haystack too, and they enter through
    exactly this ``*parts`` door — one part per tag, tokenized like any other.
    That is what the kit's ``isSensitive`` does (``for (const tag of
    target.tags ?? []) for (const t of tokenize(tag))``): a file tagged
    ``nsfw art`` in digiKam matches the keyword ``nsfw``, while a file tagged
    ``assets`` still does not match ``ass``. Comparing a tag WHOLE instead
    would make this pack disagree with the browser and with
    ``comfyui-gallery-loader`` over the same bytes on the same disk.
    (``comfyui-gallery-loader``'s port spells the same thing with a dedicated
    ``tags`` parameter; the two are behaviourally equivalent, not textual
    copies — this one keeps its part-agnostic shape.)
    """
    if not keywords:
        return False
    return any(part and not keywords.isdisjoint(safe_tokenize(part)) for part in parts)


# ---------------------------------------------------------------------------
# Safe View — the opt-in prompt-metadata tier
# ---------------------------------------------------------------------------
#
# The free tiers match the keyword list against a file's NAME, the FOLDERS above
# it and its XMP TAGS, all of which /list already knows. This tier adds a fourth
# haystack: the file's embedded GENERATION PROMPT and model name. It is off by
# default (`TouchTools.SafeView.MatchPrompt`) because it is the only tier that
# costs a file parse per file — see safeview_store.py for the cache that makes it
# affordable at all.
#
# FOUR STATES, not two. Per file, /list reports:
#
#   True         cached text matched a keyword
#   False        cached text did not match
#   "unscanned"  the file participates but has no cached text yet — the kit
#                reads this as SENSITIVE, because the fail-safe direction for an
#                unknown is to blur
#   (key absent) the file does not participate at all (no metadata reader for
#                its container) — never sensitive by this tier
#
# The last two are the pair that is easy to collapse and must not be: an absent
# key means "nothing to scan", "unscanned" means "not scanned yet", and treating
# a folder card or an .avi as unscanned would blur the entire grid the moment the
# tier came on. The frontend's PromptVerdict type carries the same four states.
#
# THE RESPONSE NEVER CARRIES PROMPT TEXT. Matching happens here, against the
# cached text, with the SAME `is_safe_match` the name and path haystacks use — so
# the semantics cannot drift between tiers, and the text the user asked not to
# see on screen is never sent to the screen.
# (mtime, subpath, name, ext, path, stat) — what the listing walks collect per
# file, and the tuple both the hide filter and the prompt tier are handed.
_FoundEntry = tuple[float, str, str, str, str, os.stat_result]

_PROMPT_UNSCANNED = "unscanned"

# Upper bound on one /safeview_warm batch. The frontend posts the outputs of a
# single execution, which is a handful of files; the cap exists so a client
# cannot ask the event loop to parse a whole library through the fast path that
# deliberately bypasses the sweep's batching.
MAX_WARM_BATCH = 64

# Minimum gap between two background sweeps. The sweep is started lazily by a
# listing that found unscanned files, so without this a grid full of
# freshly-deleted-and-rewritten files could start one per request.
SWEEP_MIN_INTERVAL = 60.0

_sweep_task: asyncio.Task[int] | None = None
_sweep_started_at = 0.0


def _safeview_db() -> str:
    # Resolved lazily (not at import) so a test stub of folder_paths doesn't
    # break module load — same reason as _thumb_cache_dir. The same
    # <user_dir>/comfy-safeview.sqlite is used by comfyui-gallery-loader, so one
    # scan serves both packs, exactly like the shared thumbnail cache.
    return safeview_store.db_path(str(folder_paths.get_user_directory()))


def _prompt_verdicts(
    entries: list[_FoundEntry],
    keywords: set[str],
) -> dict[str, bool | str]:
    """Map each entry's path to its prompt-tier verdict.

    Entries whose container has no metadata reader are OMITTED — they do not
    participate in the tier, which is a different fact from "not scanned yet"
    (see the block comment above). One batched cache read for the whole list;
    per-file reads would put a query per card on the event loop.
    """
    participating = [e for e in entries if _has_metadata_reader(e[2])]
    if not participating:
        return {}
    keyed = [(safeview_store.cache_key(e[4], e[5]), e[4]) for e in participating]
    cached = safeview_store.read_cached(_safeview_db(), [k for k, _ in keyed])
    out: dict[str, bool | str] = {}
    for key, path in keyed:
        text = cached.get(key)
        out[path] = _PROMPT_UNSCANNED if text is None else is_safe_match(keywords, text)
    return out


def _maybe_start_sweep() -> None:
    """Start the background cache sweep, unless one is already running.

    LAZY BY DESIGN: nothing here runs until a request actually asks for the
    prompt tier, so a user who never enables it never pays for a walk of their
    output tree. (An `on_startup` hook would fire for everyone — the pack's
    module is imported by `init_extra_nodes` before the runner is set up, so the
    hook IS available; it is simply the wrong trade for an opt-in feature.)

    Fails soft in every direction: no running loop (a unit test), no user
    directory, a cancelled task — the tier still answers, just with more
    "unscanned" verdicts until a warmer catches up.
    """
    global _sweep_task, _sweep_started_at
    if _sweep_task is not None and not _sweep_task.done():
        return
    now = time.monotonic()
    if _sweep_task is not None and now - _sweep_started_at < SWEEP_MIN_INTERVAL:
        return
    try:
        loop = asyncio.get_running_loop()
        roots = [folder_paths.get_directory_by_type(t) for t in SANDBOXED_TYPES]
        db = _safeview_db()
    except Exception as exc:
        log.warning("safe-view sweep could not start: %s", exc)
        return
    _sweep_started_at = now
    _sweep_task = loop.create_task(
        safeview_store.sweep(db, [r for r in roots if r], METADATA_EXTS)
    )


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


def _contained_after_realpath(target: str, base: str) -> bool:
    """Second, INDEPENDENT containment check for a mutation target.

    The lexical ``commonpath`` check every caller already runs rejects ``..``
    before any syscall, which is the cheap gate and stays. This one resolves
    symlinks and answers the question the lexical check structurally cannot:
    does ``target`` still land inside ``base`` once the filesystem has had its
    say? An entry inside the sandbox that links out (``output/evil -> /etc``)
    is lexically contained and really is not.

    ``base`` is resolved too, so a symlinked SUBFOLDER the user navigated into
    (``output/renders -> /mnt/nas/renders``, the layout this workspace uses)
    still passes: both sides resolve into the same real tree. That is why this
    lives on the mutation resolvers and NOT in ``_resolve_listing_base``, which
    /list, /thumb, /metadata and pin resolution all share — putting it there
    would stop such a folder listing at all.

    A target that does not exist yet (mkdir, a rename destination) resolves
    through its existing parent chain, which is exactly the containment
    question worth asking about it.
    """
    try:
        real_base = os.path.realpath(base)
        real_target = os.path.realpath(target)
        return os.path.commonpath([real_target, real_base]) == real_base
    except ValueError:
        # commonpath raises on paths with no common prefix at all (different
        # drives on Windows). No common prefix is not containment.
        return False


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
    if not _contained_after_realpath(target, base):
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
    if not _contained_after_realpath(target, base):
        return None, "name escapes root"
    return target, ""


def _count_dir_contents(target: str, limit: int | None = None) -> tuple[int, int]:
    """Return (files, dirs) nested anywhere under ``target`` (target excluded).

    Symlinks are not followed, so a link inside the tree counts as one file
    and its destination is never traversed.

    With ``limit`` set the walk SHORT-CIRCUITS as soon as the running total
    passes it, and the returned counts are then a lower bound whose sum is
    already ``> limit`` — enough to refuse, and no longer exact. That early
    exit is the point: this is a synchronous os.walk on the event loop, called
    before /rmdir decides anything, so an uncapped walk of a pathological tree
    would stall the server before the cap could refuse it. Without ``limit``
    (the default, and what the pin/count callers use) the counts are exact.
    """
    n_files = 0
    n_dirs = 0
    for _root, dirnames, filenames in os.walk(target, followlinks=False):
        n_dirs += len(dirnames)
        n_files += len(filenames)
        if limit is not None and n_files + n_dirs > limit:
            break
    return n_files, n_dirs


def _err(message: str, status: int) -> web.Response:
    """Uniform JSON error response: ``{"ok": false, "error": <message>}``.

    Every endpoint (reads and writes) returns errors through this shape so a
    client gets a machine-readable reason on any status, never a bodyless
    ``web.Response(status=...)``.
    """
    return web.json_response({"ok": False, "error": message}, status=status)


# ---------------------------------------------------------------------------
# Request guards — see the module docstring, section 1
# ---------------------------------------------------------------------------


def _request_mime(request: web.Request) -> str:
    """The request's Content-Type with any parameters stripped, lowercased.

    Parsed here rather than read off ``request.content_type`` so the gate is
    one visible expression over one header, and so it can be exercised against
    a plain mapping in tests.
    """
    raw = request.headers.get("Content-Type") or ""
    return raw.split(";", 1)[0].strip().lower()


def _authority_host(authority: str) -> str | None:
    """Lowercased hostname of an authority ('h:8188', '[::1]:8188', 'h'), or None.

    Hand-parsed rather than handed to the stdlib URL parser, on purpose: the
    registry security scanner treats a reference to that module in shipped
    Python as a network operation and flags the version on ANY finding, which
    is the class of finding this whole change exists to clear. The pack's own
    publish-hygiene test enforces the same rule (tests/test_publish_hygiene.py)
    and is what caught the first draft of this helper.

    The grammar here is tiny and closed — an ``Origin`` is
    ``scheme "://" host [":" port]`` with no path, query or userinfo (RFC 6454),
    and a ``Host`` header is ``host [":" port]`` — so the parse is a bracket
    check and a split. ``tests/test_guard.py`` pins it DIFFERENTIALLY against the
    stdlib parser over a table of real and malformed values — the tests are not
    shipped, so they may import it — because a hand-rolled parser is only
    trustworthy next to the reference it replaces.
    """
    authority = authority.strip()
    if not authority:
        return None
    # An Origin carries no userinfo, but a malformed value might; take the host
    # side rather than reading 'user@evil.example' as a hostname.
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    if authority.startswith("["):
        end = authority.find("]")
        if end == -1:
            return None
        return authority[1:end].lower() or None
    if ":" in authority:
        authority = authority.split(":", 1)[0]
    return authority.lower() or None


def _origin_host(origin: str) -> str | None:
    """Hostname of an ``Origin`` header value, or None when it has none.

    ``Origin: null`` — a sandboxed iframe, some redirect chains — is an OPAQUE
    origin and returns None, which the caller treats as a refusal. That is the
    right direction: an opaque origin is precisely one that must not be assumed
    to be ours.

    The draft this replaces read the host by rewriting the scheme to '//' and
    handing the result to a helper that ALSO prepends '//' — '////host', whose
    hostname is None for every well-formed Origin, so it would have 403'd every
    legitimate POST. Hence the differential test.
    """
    value = origin.strip()
    if not value or value.lower() == "null":
        return None
    scheme, sep, rest = value.partition("://")
    if not sep or not scheme:
        return None
    return _authority_host(rest.split("/", 1)[0])


def _host_header_host(host: str) -> str | None:
    """Hostname of a ``Host`` header value ('127.0.0.1:8188' -> '127.0.0.1')."""
    return _authority_host(host)


def _reject_cross_site(request: web.Request) -> web.Response | None:
    """403 a request a browser has told us came from another site, else None.

    Three tiers, most authoritative first:

      1. ``Sec-Fetch-Site`` is set by the browser and cannot be forged by page
         script (it is a forbidden header name). ``cross-site`` is refused;
         ``same-origin`` / ``same-site`` / ``none`` are accepted and end the
         check. Accepting ``same-site`` is deliberate and matches ComfyUI core,
         which also refuses only ``cross-site``: narrowing it here would break
         split-subdomain reverse-proxy setups that core allows.
      2. No ``Sec-Fetch-Site`` (an older browser): fall back to comparing the
         ``Origin`` host against the ``Host`` host. This is stricter than core,
         which runs that comparison only when Host is a loopback address.
      3. Neither header: allowed. Per Fetch, a browser sends ``Origin`` on
         every non-GET/HEAD request, so this case is not reachable from a page
         — it is curl, a script, or an API client, and refusing those would
         break legitimate automation without closing anything.
    """
    sec_fetch_site = request.headers.get("Sec-Fetch-Site")
    if sec_fetch_site:
        if sec_fetch_site.lower() == "cross-site":
            return _err("cross-site request refused", 403)
        return None

    origin = request.headers.get("Origin")
    host = request.headers.get("Host")
    if not origin or not host:
        return None
    origin_host = _origin_host(origin)
    host_host = _host_header_host(host)
    if origin_host is None or host_host is None:
        return _err("cross-origin request refused", 403)
    if origin_host.lower() != host_host.lower():
        return _err("cross-origin request refused", 403)
    return None


def _reject_non_json(request: web.Request) -> web.Response | None:
    """415 a mutation whose body is not declared as JSON, else None.

    This is the gate that actually closes the CSRF class. A cross-origin
    ``<form>`` can only send text/plain, multipart/form-data or
    application/x-www-form-urlencoded, and none of those reaches a handler once
    application/json is required — the request needs a preflight, which this
    server does not answer with the custom-header permission it would need.
    """
    if _request_mime(request) != "application/json":
        return _err("Content-Type: application/json required", 415)
    return None


def _guard_mutation(handler):
    """Apply both mutation gates to one POST handler.

    Written as a DECORATOR, never as aiohttp middleware:
    ``PromptServer.instance.app`` is ComfyUI's single global Application, so
    appending to ``app.middlewares`` would gate every core route in the
    process — this pack must not decide whether /prompt runs.

    Place it directly BELOW the ``@routes.post`` line so the wrapper is what
    gets registered; above it the route table would hold the bare handler and
    the guard would never run. ``tests/test_guard.py`` enumerates the
    registered POST routes and fails if any one of them lacks the marker
    attribute set here, so a new endpoint cannot be added without a gate — an
    exception list would rot, an enumeration cannot.
    """

    @functools.wraps(handler)
    async def guarded(request: web.Request) -> web.Response:
        refusal = _reject_cross_site(request)
        if refusal is not None:
            return refusal
        refusal = _reject_non_json(request)
        if refusal is not None:
            return refusal
        return await handler(request)

    guarded.image_browser_guarded = True
    return guarded


# ---------------------------------------------------------------------------
# Arbitrary-path read opt-in — see the module docstring, section 2
# ---------------------------------------------------------------------------


def _user_settings(request: web.Request) -> dict[str, Any]:
    """This request's ComfyUI user settings, or {} when they cannot be read.

    Routed through ComfyUI's own user manager so a --multi-user install
    resolves the calling user's profile exactly as core does, rather than this
    pack re-deriving a path. Any failure degrades to {} — which reads as "the
    opt-in is off", the safe direction.

    Read per request and NOT cached: the file is a few kilobytes, and a cache
    would keep serving the old answer after the user flips the switch, which is
    the one moment they are watching for it to take effect.
    """
    try:
        return PromptServer.instance.user_manager.settings.get_settings(request) or {}
    except Exception:
        log.debug("could not read user settings; treating the path-read opt-in as off")
        return {}


def _absolute_path_reads_enabled(request: web.Request) -> bool:
    """True only when the user has explicitly switched the opt-in on.

    ``is True`` rather than a truthiness test on purpose: a corrupted or
    hand-edited settings file holding the string "false" must not enable a
    security-relevant reach.
    """
    return _user_settings(request).get(SETTING_ALLOW_PATH_READS) is True


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------


@PromptServer.instance.routes.get("/image_browser/base")
async def image_browser_base(request: web.Request) -> web.Response:
    """Expose ComfyUI's well-known directories so the frontend hard-codes none.

    Also reports whether the arbitrary-path read opt-in is on, so the grid can
    say WHY a type=path video will not play instead of rendering a dead
    <video> element. This is a courtesy for the UI only — /file re-reads the
    setting itself and never trusts anything the client sends.
    """
    return web.json_response(
        {
            "ok": True,
            "base_path": folder_paths.base_path,
            "input_dir": folder_paths.get_input_directory(),
            "output_dir": folder_paths.get_output_directory(),
            "temp_dir": folder_paths.get_temp_directory(),
            "user_dir": folder_paths.get_user_directory(),
            "allow_path_reads": _absolute_path_reads_enabled(request),
        }
    )


def _scan_file_entry(
    path: str, name: str, ext: str, st: os.stat_result, image_subset: set[str]
) -> dict[str, Any]:
    """Build a listing dict for one file (size + metadata probes, shared by the
    flat and recursive listers so both emit the identical file shape)."""
    width: int | None = None
    height: int | None = None
    if ext in image_subset:
        try:
            # PIL.Image.open is lazy — only the header is read until pixel
            # access, so .size is cheap.
            with Image.open(path) as im:
                width, height = im.size
        except Exception as exc:
            # Corrupt/unreadable image header — omit dimensions but keep
            # listing the file.
            log.debug("size probe failed for %s: %s", path, exc)
    try:
        # ONE XMP read for both. The star and the dc:subject keywords come out
        # of the SAME packet, so asking for them through two calls would double
        # the file opens this listing already pays for — and the cache is keyed
        # per (path, mtime, size), so the second call would be a second parse
        # only on a cold entry, which is exactly the case that is expensive.
        rating, tags = xmp_meta.read_meta_cached(path, st)
    except Exception as exc:
        # Bad/absent XMP packet — treat as unrated and untagged, but record why
        # the probe failed.
        log.debug("metadata probe failed for %s: %s", path, exc)
        rating, tags = 0, []
    return {
        "name": name,
        "mtime": st.st_mtime,
        "size": st.st_size,
        "width": width,
        "height": height,
        "ext": ext,
        "rating": rating,
        "tags": tags,
    }


def _probe_newest(
    found: list[_FoundEntry],
    image_subset: set[str],
    cap: int,
    walk_truncated: bool,
    *,
    with_subpath: bool,
    hide_keywords: set[str] | None = None,
    hide_prefix: str = "",
    prompt_keywords: set[str] | None = None,
) -> tuple[list[dict[str, Any]], bool, int]:
    """Sort newest-first, slice to ``cap``, then probe only the survivors.

    Shared by the recursive and non-recursive listers so the cap means the same
    thing on both. Ties break on (subpath, name) so the slice is deterministic
    for same-mtime files; a batch render writes many within one clock tick.

    ``with_subpath`` is False for a non-recursive listing, which must omit the
    key ENTIRELY rather than emit an empty string — the frontend distinguishes
    "flat listing, file at top level" from "folder listing" by its presence.

    ``hide_keywords`` is Safe View's server-side hide. It is applied HERE, in
    the one function that owns the cap, rather than at the two call sites — so
    "filtered above the newest-N cap" is structurally guaranteed and a future
    caller cannot get the order wrong. That order is the entire reason hiding
    lives on the server: filtering an already-truncated response would answer a
    folder of 6000 mostly-sensitive files with a near-empty grid, while
    filtering first spends the cap on the files that survive and returns a full
    page of them. ``truncated`` is likewise computed AFTER the filter, so it
    reports whether the caller is missing anything it was allowed to see.

    ``hide_prefix`` is the entries' shared LOGICAL parent — ``"output/holiday"``
    for a sandboxed listing, the absolute directory for ``type=path``. Each
    entry's own ``subpath`` and ``name`` are matched on top of it.

    THE TAG TIER CANNOT RUN UP THERE, and the top-up loop below is why it does
    not have to. Name and path are free — already in hand from the walk — so
    they filter the whole candidate list before a single file is opened. A
    file's ``dc:subject`` keywords need the XMP read, which is precisely the
    expensive probe the cap exists to bound, so probing every candidate to
    decide membership would spend the whole tree's worth of file opens on a
    single page. Instead the loop probes NEWEST-FIRST AND TOPS UP: a row
    dropped for its tags is replaced by probing one more. That keeps tier one's
    "a full page of the rest" property without paying tier one's price, and
    costs exactly the same number of probes as before whenever nothing is
    tagged. ``PROBE_BUDGET_FACTOR`` bounds the pathological case (a whole tree
    tagged), where the honest answer is a short page marked ``truncated``.

    ``prompt_keywords`` turns on the opt-in prompt tier, tagging each
    participating file with a ``prompt_match`` verdict. The third return value
    is how many files were ``"unscanned"`` — the number the toolbar's
    "scanning N" pill reports, so the user can tell a blurred-because-unknown
    grid from a blurred-because-matched one.

    The tier is evaluated at TWO different points depending on ``hide``,
    because the two answers need different sets:

      * with hiding on, the verdict decides membership, so it must be computed
        for every CANDIDATE — above the cap, for the same reason the name/path
        hide is. Otherwise a folder of unscanned files would return a near-empty
        page. ``"unscanned"`` is dropped there, mirroring the kit's
        ``isSensitive``, which reads it as sensitive.
      * with hiding off, only the files that ship need a verdict, so it is
        computed AFTER the slice — one batched cache read over ``cap`` keys
        rather than over the whole tree.
    """
    found.sort(key=lambda f: (-f[0], f[1], f[2]))
    if hide_keywords:
        found = [
            entry
            for entry in found
            if not is_safe_match(hide_keywords, hide_prefix, entry[1], entry[2])
        ]
    unscanned = 0
    verdicts: dict[str, bool | str] = {}
    if prompt_keywords:
        if hide_keywords:
            verdicts = _prompt_verdicts(found, prompt_keywords)
            unscanned = sum(1 for v in verdicts.values() if v == _PROMPT_UNSCANNED)
            found = [entry for entry in found if verdicts.get(entry[4]) in (None, False)]
        else:
            verdicts = _prompt_verdicts(found[:cap], prompt_keywords)
            unscanned = sum(1 for v in verdicts.values() if v == _PROMPT_UNSCANNED)
    # With hiding on, a probe can be spent on a row that is then dropped for its
    # tags, so the loop is allowed to probe past `cap` to refill the page. With
    # hiding off nothing is dropped here, so the budget IS the cap and the loop
    # is byte-for-byte the old `found[:cap]` walk.
    budget = cap * PROBE_BUDGET_FACTOR if hide_keywords else cap
    files: list[dict[str, Any]] = []
    probed = 0
    for _mtime, subpath, name, ext, path, st in found:
        if len(files) >= cap or probed >= budget:
            break
        fd = _scan_file_entry(path, name, ext, st, image_subset)
        probed += 1
        # The tag tier. Each keyword is handed in as its own part, so it is
        # tokenized exactly like the name and the folder segments — see
        # is_safe_match.
        if hide_keywords and is_safe_match(hide_keywords, *fd["tags"]):
            continue
        if with_subpath:
            fd["subpath"] = subpath
        # Absent for a file outside the tier — a container with no metadata
        # reader. The frontend reads an absent key as "does not participate",
        # which is NOT the same as "unscanned" and is never blurred.
        if path in verdicts:
            fd["prompt_match"] = verdicts[path]
        files.append(fd)
    # Computed from what was actually consumed, not from `len(found) > cap`:
    # once the loop can stop early on a budget, the only honest statement is
    # "there were candidates this response never looked at".
    truncated = walk_truncated or probed < len(found)
    return files, truncated, unscanned


def _walk_files(
    base: str,
    exts: set[str],
    image_subset: set[str],
    cap: int,
    hide_keywords: set[str] | None = None,
    hide_prefix: str = "",
    prompt_keywords: set[str] | None = None,
) -> tuple[list[dict[str, Any]], bool, int]:
    """Recursively collect the ``cap`` NEWEST files under ``base`` for the flat view.

    Two phases, because the two costs are wildly different:

    1. **Enumerate** the whole subtree, keeping only what ``os.scandir`` already
       hands over — name, subpath, extension, and a ``stat`` (a syscall, no file
       open). Bounded by ``FLAT_WALK_CAP`` purely so a pathological tree cannot
       make the request unbounded.
    2. **Sort by mtime (newest first), slice to ``cap``, then probe.** Only the
       survivors pay ``_scan_file_entry``'s two file opens (PIL header for the
       dimensions, XMP read for the rating).

    Doing it the other way round — probing during the walk and stopping at
    ``cap`` — truncates in *directory* order, so on a subtree larger than the cap
    the flat view silently omits whatever the alphabetical descent hadn't reached
    yet. The newest render, the one the flat view exists to surface, is exactly
    as likely as any other file to be in the missing tail. Sorting first also
    means the expensive probes run only on files that actually ship.

    Each file dict carries a ``subpath`` (forward-slashed, relative to ``base``,
    "" at the top level) so the frontend can address its thumbnail and mutations.
    Symlinks are never followed (``follow_symlinks=False`` on every probe), so
    the walk stays inside the resolved sandbox root. Hidden entries and the
    ``clipspace`` / ``__pycache__`` dirs are skipped just like the flat lister.
    Returns ``(files, truncated)``; ``truncated`` is True when files were
    dropped — either by the newest-N slice or by the enumeration backstop.
    """
    # Phase 1 — cheap enumeration. (mtime, subpath, name, ext, path, stat).
    found: list[tuple[float, str, str, str, str, os.stat_result]] = []
    walk_truncated = False
    # DFS over scandir (not os.walk) so each directory keeps DirEntry's cheap,
    # symlink-safe is_dir/is_file/stat — the same guards the flat lister uses.
    stack: list[tuple[str, str]] = [("", base)]
    while stack and not walk_truncated:
        subpath, directory = stack.pop()
        try:
            with os.scandir(directory) as it:
                subdirs: list[tuple[str, str]] = []
                for entry in it:
                    try:
                        if entry.name.startswith("."):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in ("clipspace", "__pycache__"):
                                continue
                            child = f"{subpath}/{entry.name}" if subpath else entry.name
                            subdirs.append((child, entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext not in exts:
                                continue
                            st = entry.stat(follow_symlinks=False)
                            found.append((st.st_mtime, subpath, entry.name, ext, entry.path, st))
                            if len(found) >= FLAT_WALK_CAP:
                                walk_truncated = True
                                break
                    except OSError:
                        continue
                # Descend in name order (reversed onto the LIFO stack) so the
                # enumeration frontier is predictable if the backstop ever bites.
                subdirs.sort(key=lambda s: s[0].lower(), reverse=True)
                stack.extend(subdirs)
        except OSError:
            # An unreadable subdirectory is skipped, not fatal — a flat view
            # should surface everything it can reach rather than 403/500 on one
            # bad dir.
            continue

    # The hide filter runs in _probe_newest, i.e. AFTER this enumeration — so
    # like `kind=`, a Safe View hide makes the walk traverse MORE, not less:
    # FLAT_WALK_CAP counts entries the filter has not yet seen. That follows
    # from filtering above the newest-N cap; don't "optimize" it by pruning the
    # descent here, which would reintroduce truncation in directory order.
    return _probe_newest(
        found,
        image_subset,
        cap,
        walk_truncated,
        with_subpath=True,
        hide_keywords=hide_keywords,
        hide_prefix=hide_prefix,
        prompt_keywords=prompt_keywords,
    )


@PromptServer.instance.routes.get("/image_browser/list")
async def image_browser_list(request: web.Request) -> web.Response:
    q = request.rel_url.query
    type_name = q.get("type", "output")
    subfolder = q.get("subfolder", "")
    abs_path = q.get("path", "")
    exts = _parse_extensions(q.get("extensions", ""))
    # Narrows, never widens: composes with an explicit `extensions=` rather than
    # overriding it, so a caller that asked for a narrower set still gets it.
    # Applied HERE, above the recursive/non-recursive split, so it reaches
    # _walk_files and the flat view too — and above the mtime sort + cap in
    # _probe_newest, which is the whole point: the cap is then spent entirely on
    # the kind you asked for (the newest N *videos*), not on whatever the newest
    # N files happened to be. Filtering client-side, or after the slice, would
    # under-report videos in any folder where stills outnumber them.
    #
    # Note this makes a narrow filter TRAVERSE MORE, not less: FLAT_WALK_CAP
    # counts only files that survive the extension test, so `kind=videos` over a
    # tree of 300k stills walks all of it without the backstop ever biting.
    # That follows from the newest-N guarantee above — don't "optimize" it by
    # moving the filter after the walk.
    narrow = KIND_FILTERS.get(q.get("kind", ""))
    if narrow:
        exts = exts & narrow
    # After the narrowing, which is the correct expression of intent — though it
    # changes nothing today, since IMG_EXTS and VIDEO_EXTS are disjoint and no
    # video would pass `ext in image_subset` either way. No test can tell the
    # two orderings apart; don't write one.
    image_subset = exts & IMG_EXTS
    # Flat/recursive listing is a sandboxed-root affordance only — recursing an
    # arbitrary base path (type=path, e.g. models/) is out of scope and could be
    # enormous, so the flag is ignored there.
    recursive = q.get("recursive", "") in ("1", "true", "yes") and type_name in SANDBOXED_TYPES

    # Safe View's server-side hide. BOTH conditions are required: `safe_hide`
    # asks for dropping rather than blurring, and an absent or empty `safe_kw`
    # filters nothing at all (there is no implicit default keyword here — the
    # frontend owns the default and sends it explicitly, so a request that
    # forgot the list cannot silently hide a user's files). An unparseable
    # `safe_hide` narrows nothing rather than 400ing, matching `recursive` and
    # `kind` — the request is still answerable.
    hide_keywords: set[str] = set()
    if q.get("safe_hide", "") in ("1", "true", "yes"):
        hide_keywords = parse_safe_keywords(q.get("safe_kw", ""))

    # The opt-in prompt tier, gated exactly like `safe_hide`: BOTH the flag and
    # a non-empty keyword list, so a request that forgot the list cannot blur a
    # user's whole grid on "unscanned" verdicts nobody asked for. Independent of
    # `safe_hide` — the two compose (see _probe_newest), and blur-only is the
    # default mode for this tier as it is for the others.
    prompt_keywords: set[str] = set()
    if q.get("safe_prompt", "") in ("1", "true", "yes"):
        prompt_keywords = parse_safe_keywords(q.get("safe_kw", ""))

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
                "truncated": False,
            }
        )

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    truncated = False
    unscanned = 0

    # The entries' shared LOGICAL parent, and the exact string the frontend
    # builds its own `path` haystack from — `${root}/${subfolder}` for a
    # sandboxed root, the absolute directory for type=path (the one case where
    # the logical path IS the OS path, so both sides see the same segments).
    # Never the resolved OS path for a sandboxed root: see is_safe_match.
    hide_prefix = base if type_name == "path" else f"{type_name}/{subfolder}"

    if recursive:
        # Flat view: no folder cards, files carry their relative subpath.
        files, truncated, unscanned = _walk_files(
            base, exts, image_subset, FLAT_LIST_CAP, hide_keywords, hide_prefix, prompt_keywords
        )
    else:
        found: list[_FoundEntry] = []
        try:
            with os.scandir(base) as it:
                for entry in it:
                    try:
                        if entry.name.startswith("."):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in ("clipspace", "__pycache__"):
                                continue
                            # A hidden folder is matched by NAME ONLY — the
                            # kit's documented folder rule, because a folder
                            # card carries no metadata to read. Dropping it
                            # matters: leaving the card would keep a visible
                            # (and now empty) doorway labelled with exactly the
                            # word the user asked not to see. The consequence,
                            # stated in the README, is that a blandly-named
                            # folder full of sensitive files is caught in flat
                            # view — which lists the files — not in folder view.
                            if is_safe_match(hide_keywords, entry.name):
                                continue
                            st = entry.stat(follow_symlinks=False)
                            dirs.append({"name": entry.name, "mtime": st.st_mtime})
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext not in exts:
                                continue
                            st = entry.stat(follow_symlinks=False)
                            found.append((st.st_mtime, "", entry.name, ext, entry.path, st))
                    except OSError:
                        continue
        except PermissionError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=403)
        except OSError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        # Same enumerate -> sort -> slice -> probe shape as the recursive path,
        # so a huge single directory pays the expensive probes only for the
        # files that ship. Newest first.
        files, truncated, unscanned = _probe_newest(
            found,
            image_subset,
            DIR_LIST_CAP,
            False,
            with_subpath=False,
            hide_keywords=hide_keywords,
            hide_prefix=hide_prefix,
            prompt_keywords=prompt_keywords,
        )

    dirs.sort(key=lambda d: d["name"].lower())

    # A listing that found unscanned files is the trigger for the background
    # sweep — the tier's only backlog warmer. Started HERE rather than at import
    # so a user who never enables it never pays for a walk of their output tree,
    # and skipped once everything in view is cached so a warm library does not
    # re-walk on every request.
    if unscanned:
        _maybe_start_sweep()

    body: dict[str, Any] = {
        "ok": True,
        "type": type_name,
        "subfolder": subfolder,
        "path": base,
        "dirs": dirs,
        "files": files,
        "exists": True,
        "truncated": truncated,
    }
    # Present only when the tier is on, so the default response stays
    # byte-identical to what it was before this tier existed.
    if prompt_keywords:
        body["safe_unscanned"] = unscanned
    return web.json_response(body)


@PromptServer.instance.routes.get("/image_browser/file")
async def image_browser_file(request: web.Request) -> web.Response:
    """Stream a file at an absolute path — OFF unless the user opts in.

    Previews videos and opens originals in ``type=path`` listings, which core
    /api/view cannot serve because it only reaches input/output/temp. That also
    makes this the one endpoint in the pack that hands back a host file's raw
    bytes, so it is the one behind a switch: see the module docstring,
    section 2. With the switch off it answers 403 and touches no disk.

    The three checks are ordered opt-in -> extension -> existence, and that
    order is load-bearing. Testing existence first would answer 404 for a path
    that is absent and 403 for one that is present-but-not-media, turning the
    endpoint into an existence oracle for every file on the host — a caller
    could enumerate /etc or a home directory without ever reading a byte.
    Gating on the extension first collapses both answers for anything outside
    the whitelist to the same 403.
    """
    q = request.rel_url.query
    abs_path = q.get("path", "")
    if not abs_path:
        return _err("missing path", 400)
    if not _absolute_path_reads_enabled(request):
        return _err(
            "absolute-path file reads are disabled. Enable Settings -> Touch Tools -> "
            "Image Browser -> 'Allow absolute-path file reads' to preview files outside "
            "input/output/temp.",
            403,
        )
    path = os.path.abspath(os.path.expanduser(abs_path))
    if os.path.splitext(path)[1].lower() not in STREAMABLE_EXTS:
        return _err("unsupported file type", 403)
    if not os.path.isfile(path):
        return _err("file not found", 404)
    mime, _ = mimetypes.guess_type(path)
    return web.FileResponse(
        path,
        headers={
            "Content-Type": mime or "application/octet-stream",
            "Cache-Control": "private, max-age=300",
        },
    )


def _resolve_thumb_target(q: Any) -> tuple[str | None, str]:
    """Resolve /thumb + /metadata query params to an absolute file path.

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


@PromptServer.instance.routes.get("/image_browser/metadata")
async def image_browser_metadata(request: web.Request) -> web.Response:
    """Embedded generation metadata for one file — sandboxed roots AND type=path.

    Same dual addressing as /thumb (``_resolve_thumb_target``). The gate is
    METADATA_EXTS — every image, plus the video containers image_meta can read
    (MP4/MOV/M4V, WebM/MKV) — and never STREAMABLE_EXTS, so no extension
    enters the perimeter that some reader here cannot actually parse.

    The whitelist is asserted **before** ``os.path.isfile`` — the opposite
    order to /file, which stats an arbitrary caller-supplied path before
    checking the extension (a pre-existing wart; new read endpoints follow
    this order). It also splits /thumb's single 404 in two, because a
    non-whitelisted extension is a bad request (400), not a missing file.

    No cache headers: this is a one-shot tap-to-open read, so duplicating
    /thumb's ETag scheme would buy nothing.
    """
    path, err = _resolve_thumb_target(request.rel_url.query)
    if err:
        return _err(err, 400)
    assert path is not None
    if not _has_metadata_reader(path):
        return _err("unsupported file type", 400)
    if not os.path.isfile(path):
        return _err("file not found", 404)

    raw, truncated = image_meta.read_raw_metadata(path)
    source, summary = image_meta.parse_generation_meta(raw)
    # The container label comes from the extension, keeping one source of
    # truth with the rest of the pack; an image whose format has no parser
    # (a .gif from IMG_EXTS) answers 200 with empty metadata, never a 500.
    fmt = image_meta.FORMAT_EXTS.get(os.path.splitext(path)[1].lower(), "")
    return web.json_response(
        {
            "ok": True,
            "format": fmt,
            "source": source,
            "summary": summary,
            "raw": raw,
            "truncated": truncated,
        }
    )


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
@_guard_mutation
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
@_guard_mutation
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
@_guard_mutation
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


def _merge_move_dir(src: str, dst: str) -> list[str]:
    """Recursively move the contents of ``src`` into an existing directory ``dst``.

    Both paths are absolute and ``dst`` already exists as a directory. Entries that
    don't collide are moved with ``shutil.move`` (a fast rename on the same volume);
    a subdirectory that collides with an existing destination subdirectory is merged
    recursively; any other collision (file-vs-anything, or a source symlink) is left
    untouched in the source and reported so nothing is silently overwritten. Returns
    the source-relative paths of the entries that could not be merged. ``src`` is
    removed only once it has been fully drained — a leftover conflict keeps it (and
    the conflicting entries) in place.
    """
    conflicts: list[str] = []
    for entry in os.listdir(src):
        s = os.path.join(src, entry)
        d = os.path.join(dst, entry)
        if os.path.exists(d):
            # Two real directories of the same name merge; anything else is a
            # collision we refuse rather than clobber.
            if os.path.isdir(d) and os.path.isdir(s) and not os.path.islink(s):
                conflicts.extend(os.path.join(entry, c) for c in _merge_move_dir(s, d))
            else:
                conflicts.append(entry)
        else:
            shutil.move(s, d)
    if not os.listdir(src):
        os.rmdir(src)
    return conflicts


@PromptServer.instance.routes.post("/image_browser/move_dir")
@_guard_mutation
async def image_browser_move_dir(request: web.Request) -> web.Response:
    """Move a folder (with its whole subtree) between sandboxed roots/subfolders.

    Body: ``{type, subfolder, name, dest_type, dest_subfolder}``. The folder keeps
    its name; only its parent changes. Same write perimeter as the file move plus
    the folder resolver (``_resolve_sandboxed_dir``: sandboxed types only, bare
    traversal-free name, containment) minus the media-extension gate — directories
    have no extension. Symlinked source folders are rejected (moving through a link
    could reach outside the sandbox), and the destination may not be the folder
    itself or any descendant of it — moving a tree into its own subtree is refused
    before ``shutil.move`` can create a loop or leave a partial copy behind.

    When a folder of the same name already exists at the destination the two are
    **merged** (``ok:true`` with ``merged:true``): the source's contents move into
    the existing folder, matching subdirectories merge recursively, and any entry
    that would overwrite an existing file is left in the source and reported in
    ``errors`` so nothing is clobbered. A same-named *file* at the destination is
    still a hard collision (**409**).
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    name = body.get("name", "")
    src, err = _resolve_sandboxed_dir(body.get("type", ""), body.get("subfolder") or "", name)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert src is not None

    # Destination keeps the same folder name; only the parent changes.
    dst, err = _resolve_sandboxed_dir(
        body.get("dest_type", ""), body.get("dest_subfolder") or "", name
    )
    if err:
        return web.json_response({"ok": False, "error": f"destination: {err}"}, status=400)
    assert dst is not None

    if os.path.islink(src):
        return web.json_response({"ok": False, "error": "refusing to move a symlink"}, status=400)
    if not os.path.isdir(src):
        return web.json_response({"ok": False, "error": "folder not found"}, status=404)

    src_abs = os.path.abspath(src)
    dst_abs = os.path.abspath(dst)
    if src_abs == dst_abs:
        return web.json_response(
            {"ok": False, "error": "source and destination are the same"}, status=400
        )
    dst_dir = os.path.dirname(dst_abs)
    # Refuse moving a folder into itself or any descendant — shutil.move would
    # otherwise recurse into the just-created copy (or raise mid-copy, leaving a
    # partial tree). commonpath == src means dst_dir is at or below src.
    if os.path.commonpath([src_abs, dst_dir]) == src_abs:
        return web.json_response(
            {"ok": False, "error": "cannot move a folder into itself"}, status=400
        )
    if os.path.exists(dst_abs):
        if not os.path.isdir(dst_abs):
            # A same-named *file* blocks the folder — nowhere to merge into.
            return web.json_response(
                {"ok": False, "error": "a file with that name already exists at the destination"},
                status=409,
            )
        # A same-named folder already exists — merge the source's contents into it
        # instead of refusing. Colliding files are left in the source and reported.
        try:
            conflicts = _merge_move_dir(src_abs, dst_abs)
        except OSError as exc:
            log.exception("move_dir merge failed for %s -> %s", src, dst)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        errors = [{"name": c, "error": "already exists at the destination"} for c in conflicts]
        return web.json_response({"ok": True, "merged": True, "errors": errors})
    if not os.path.isdir(dst_dir):
        return web.json_response(
            {"ok": False, "error": "destination folder does not exist"}, status=404
        )
    try:
        shutil.move(src, dst)
    except OSError as exc:
        log.exception("move_dir failed for %s -> %s", src, dst)
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
    if len(items) > MAX_MUTATION_BATCH:
        return None, web.json_response(
            {"ok": False, "error": f"too many items (max {MAX_MUTATION_BATCH})"}, status=400
        )
    for item in items:
        if not isinstance(item, dict):
            return None, web.json_response(
                {"ok": False, "error": "items must be objects"}, status=400
            )
    return items, None


@PromptServer.instance.routes.post("/image_browser/delete_many")
@_guard_mutation
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
@_guard_mutation
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
@_guard_mutation
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

    # Counted with the cap so the walk stops as soon as the answer is "too
    # many" — see _count_dir_contents. Above the cap the counts are a lower
    # bound, which is all the refusal needs.
    n_files, n_dirs = _count_dir_contents(target, limit=MAX_RMDIR_ENTRIES)
    recursive = body.get("recursive") is True
    if n_files + n_dirs > MAX_RMDIR_ENTRIES:
        # 413, NOT 409. The frontend discriminates the "folder is not empty"
        # confirm on (status === 409 && typeof data.files === "number") and
        # answers it by re-posting with recursive:true — so a 409 here would
        # be read as "confirm and retry", the retry would be refused the same
        # way, and the user would sit in a confirm/refuse loop with no exit. A
        # distinct status falls through to the client's generic error path,
        # which surfaces this message once.
        return web.json_response(
            {
                "ok": False,
                "error": (
                    f"folder holds more than {MAX_RMDIR_ENTRIES} entries — "
                    "delete it from a file manager"
                ),
                "code": "too_large",
            },
            status=413,
        )
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
@_guard_mutation
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
@_guard_mutation
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


@PromptServer.instance.routes.post("/image_browser/tag")
@_guard_mutation
async def image_browser_tag(request: web.Request) -> web.Response:
    """Add or remove ONE ``dc:subject`` keyword on a file's XMP (or sidecar).

    Body: ``{type, subfolder, name, tag, present}`` — ``present: true`` adds the
    keyword, ``false`` removes it. A keyword write mutates the file exactly as a
    star does, so it goes through ``_resolve_sandboxed_file``: ``type=path`` is
    rejected, the name must be bare, and the extension must be a media one. This
    is the SAME perimeter ``/rating`` uses, and deliberately not a laxer one —
    ADR-0002 keeps arbitrary-path mutation out of this pack entirely.

    ``xmp_meta.write_tags`` is a DELTA, so the file's other keywords survive the
    write, and its rating is untouched (the two vocabularies strip only their
    own half of the packet). The response carries the keywords READ BACK OFF THE
    FILE afterwards rather than an echo of the request: the two differ whenever
    the file already carried the keyword under a different casing, or the write
    landed in the sidecar, and painting the request would show the caller a
    state the file does not have.

    This is discretion, not access control. Marking a file changes what Safe
    View blurs and what ``/list`` returns; every read endpoint still serves the
    same bytes to anything that addresses the file directly.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    # Normalized by the SAME function the writer uses, so a value that could not
    # survive the round trip is refused here instead of written and silently
    # mangled.
    tag = xmp_meta.normalize_tag(body.get("tag"))
    if not tag:
        return web.json_response({"ok": False, "error": "invalid tag"}, status=400)
    present = body.get("present")
    if not isinstance(present, bool):
        return web.json_response({"ok": False, "error": "present must be a boolean"}, status=400)

    target, err = _resolve_sandboxed_file(
        body.get("type", ""), body.get("subfolder") or "", body.get("name", "")
    )
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert target is not None
    if not os.path.isfile(target):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)

    ok, backend = xmp_meta.write_tags(
        target, add=[tag] if present else [], remove=[] if present else [tag]
    )
    if not ok:
        log.error("tag write failed for %s: %s", target, backend)
        return web.json_response({"ok": False, "error": backend}, status=500)
    return web.json_response(
        {
            # head_only=False: the write may have landed past the header scan
            # window, and answering with a read that could not see it would
            # report the keyword as absent one tap after adding it.
            "ok": True,
            "tags": xmp_meta.read_tags(target, head_only=False),
            "backend": backend,
        }
    )


#: Ceiling on one batch rating read. The sidebar injector asks only for the
#: cards currently on screen, so a legitimate batch is tens of items; this is a
#: backstop against a client asking for a whole output tree in one request,
#: which would stat-and-parse thousands of files on the event loop.
MAX_RATING_BATCH = 200


@PromptServer.instance.routes.post("/image_browser/ratings")
@_guard_mutation
async def image_browser_ratings(request: web.Request) -> web.Response:
    """Read 0..5 ratings for many files in one request (batch READ).

    Body: ``{items: [{type, subfolder, name}, ...]}``. Answers
    ``{ok, ratings: [...]}`` **index-aligned with items** — position i is the
    rating for item i.

    Two contracts worth keeping:

    * ``null`` (not ``0``) for any item that could not be read — rejected
      address, missing file, unreadable XMP. "Unrated" and "unknown" are
      different facts, and collapsing them would make the injector paint a
      confident zero-star row over a file it never actually read.
    * The sandbox gate is ``_resolve_sandboxed_file``, the same resolver the
      rating WRITE uses, so ``type=path`` is rejected here too. Strictly this
      is a read and could be laxer, but ratings are a sandboxed-roots concept
      in this pack and one perimeter is easier to keep correct than two.

    Reads go through ``xmp_meta.read_rating_cached``, so a repeat request for
    an unchanged file costs a stat rather than a re-parse.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None
    items, err_resp = _validate_batch_items(body)
    if err_resp:
        return err_resp
    assert items is not None
    if len(items) > MAX_RATING_BATCH:
        return web.json_response(
            {"ok": False, "error": f"too many items (max {MAX_RATING_BATCH})"}, status=400
        )

    ratings: list[int | None] = []
    for item in items:
        target, err = _resolve_sandboxed_file(
            item.get("type", ""), item.get("subfolder") or "", item.get("name", "")
        )
        if err or target is None:
            ratings.append(None)
            continue
        try:
            st = os.stat(target)
            ratings.append(xmp_meta.read_rating_cached(target, st))
        except OSError as exc:
            # A missing or unreadable file is a normal race here (the sidebar
            # can list a file the user deleted a moment ago), so it is a null
            # entry rather than a 500 that would blank the whole batch.
            log.debug("batch rating read failed for %s: %s", target, exc)
            ratings.append(None)
    return web.json_response({"ok": True, "ratings": ratings})


@PromptServer.instance.routes.post("/image_browser/safeview_warm")
@_guard_mutation
async def image_browser_safeview_warm(request: web.Request) -> web.Response:
    """Scan and cache the prompt text of the files a render just produced.

    Body: ``{items: [{type, subfolder, name}, ...]}``. Answers
    ``{ok, scanned}`` — how many files were newly parsed (an already-cached
    file counts 0).

    THE SECOND CACHE WARMER. The background sweep covers the BACKLOG but
    finishes; this covers FRESH RENDERS the moment they land, driven by the
    frontend's ``executed`` websocket listener. Without it every new generation
    would be "unscanned" — and therefore blurred — until the next sweep, which
    is the most visible file in the grid being the one Safe View hides.

    Perimeter: ``_resolve_sandboxed_file``, the same resolver every write and
    the batch rating read use, so ``type=path`` is rejected. This is a read and
    could be laxer, but it is driven by ComfyUI's own output addresses, which
    are always sandboxed — one perimeter is easier to keep correct than two.
    Files whose container has no metadata reader are skipped rather than
    refused: the frontend posts every output of an execution, and a mixed batch
    must not fail because one entry was a ``.avi``.

    The parse runs in an executor. ``image_meta`` on the event loop is exactly
    the stall this whole tier is built to avoid.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None
    items, err_resp = _validate_batch_items(body)
    if err_resp:
        return err_resp
    assert items is not None
    if len(items) > MAX_WARM_BATCH:
        return web.json_response(
            {"ok": False, "error": f"too many items (max {MAX_WARM_BATCH})"}, status=400
        )

    targets: list[str] = []
    for item in items:
        target, err = _resolve_sandboxed_file(
            item.get("type", ""), item.get("subfolder") or "", item.get("name", "")
        )
        if err or target is None or not _has_metadata_reader(target):
            continue
        targets.append(target)
    if not targets:
        return web.json_response({"ok": True, "scanned": 0})

    loop = asyncio.get_running_loop()
    scanned = await loop.run_in_executor(None, safeview_store.scan_paths, _safeview_db(), targets)
    return web.json_response({"ok": True, "scanned": scanned})


# ---------------------------------------------------------------------------
# Pins — folders AND individual media, shared across packs and devices
# ---------------------------------------------------------------------------
#
# The list itself lives in <user_dir>/comfy-pins.json (pins_store.py), which is
# what makes a pin set on a phone show up on the desktop and a pin set here show
# up in comfyui-gallery-loader's picker: both are browsers against ONE ComfyUI,
# and the localStorage list this replaces structurally could not span either gap.
#
# The two handlers below are deliberately near-identical to their twins in
# comfyui-gallery-loader — same delta grammar, same response shape — so the two
# packs cannot drift into disagreeing about a file they share.


def _pins_file() -> str:
    # Resolved lazily (not at import) so a test stub of folder_paths doesn't
    # break module load — same reason as _thumb_cache_dir above.
    return pins_store.pins_path(str(folder_paths.get_user_directory()))


def _resolve_pin(pin: dict[str, Any]) -> str | None:
    """Absolute path for a pin, or None when it is not addressable.

    Files go through ``_resolve_sandboxed_file`` — the SAME perimeter every
    write and the batch rating read use, so a pin can never address something
    those would refuse. ``type=path`` never reaches here: ``pins_store`` refuses
    to hold one, and this resolver would reject it anyway.
    """
    if pin["kind"] == "dir":
        base, err = _resolve_listing_base(pin["type"], pin.get("subfolder", ""), "")
        return None if err else base
    target, err = _resolve_sandboxed_file(
        pin["type"], pin.get("subfolder", ""), pin.get("name", "")
    )
    return None if err else target


def _pin_exists(pin: dict[str, Any]) -> bool:
    target = _resolve_pin(pin)
    if target is None:
        return False
    return os.path.isdir(target) if pin["kind"] == "dir" else os.path.isfile(target)


def _pin_entry(pin: dict[str, Any]) -> dict[str, Any]:
    """One pin, plus ``exists`` and (for a resolvable file) its listing stats.

    An unresolvable pin comes back with ``exists: false`` rather than being
    dropped: "the file moved" and "you never pinned it" are different facts, and
    collapsing them would make a stale pin vanish with no way to notice — the
    same reason /ratings answers ``null`` instead of ``0``. The frontend renders
    those dimmed with an unpin affordance and a "Prune missing" action.

    A file pin carries the SAME shape /list emits per file (``_scan_file_entry``),
    so the pinned view renders through the ordinary ``renderGrid`` with no
    special-casing — ratings, ⓘ/⤓, multi-select and the write buttons included.
    """
    out: dict[str, Any] = dict(pin)
    target = _resolve_pin(pin)
    if target is None:
        out["exists"] = False
        return out
    if pin["kind"] == "dir":
        out["exists"] = os.path.isdir(target)
        return out
    try:
        st = os.stat(target)
    except OSError:
        out["exists"] = False
        return out
    if not os.path.isfile(target):
        out["exists"] = False
        return out
    name = str(pin.get("name", ""))
    out.update(_scan_file_entry(target, name, os.path.splitext(name)[1].lower(), st, IMG_EXTS))
    out["exists"] = True
    return out


def _pins_response(pins: list[dict[str, Any]]) -> web.Response:
    return web.json_response(
        {
            "ok": True,
            "pins": [_pin_entry(p) for p in pins],
            "max": pins_store.MAX_PINS,
        }
    )


@PromptServer.instance.routes.get("/image_browser/pins")
async def image_browser_pins_get(request: web.Request) -> web.Response:
    """The pin list, each entry resolved (``exists`` + a file's listing stats)."""
    return _pins_response(pins_store.load_pins(_pins_file()))


@PromptServer.instance.routes.post("/image_browser/pins")
@_guard_mutation
async def image_browser_pins_post(request: web.Request) -> web.Response:
    """Apply ONE delta: ``{op: "add"|"remove"|"prune", item?}``.

    Deliberately not a whole-list PUT. Two browsers with the modal open would
    each send their own full list and the second write would silently discard
    the first's pin — the classic lost update, and the one thing a plain JSON
    file would otherwise have needed a database to avoid. A delta read-modify-
    written inside a single aiohttp handler cannot interleave with another.

    Answers with the whole resolved list so the caller needs no follow-up GET.
    """
    body, err_resp = await _read_json(request)
    if err_resp:
        return err_resp
    assert body is not None

    path = _pins_file()
    updated, err = pins_store.apply_delta(
        pins_store.load_pins(path), body.get("op"), body.get("item"), exists=_pin_exists
    )
    if err:
        return _err(err, 400)
    try:
        pins_store.save_pins(path, updated)
    except OSError as exc:
        log.exception("pin store write failed for %s", path)
        return _err(str(exc), 500)
    return _pins_response(updated)


# No custom node — this pack is a pure frontend view. Keeping the mappings empty
# (but present) satisfies ComfyUI's loader and the pack's __init__ contract.
NODE_CLASS_MAPPINGS: dict[str, Any] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}
