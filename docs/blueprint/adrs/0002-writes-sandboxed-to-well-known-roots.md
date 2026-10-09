---
id: ADR-0002
date: 2026-07-01
status: Accepted
deciders: Lauri Gates
domain: security
github-issues: []
---

# ADR-0002: Reads reach arbitrary paths; writes are sandboxed to input/output/temp

## Context

The Image Browser both **browses** and **manages** files. Browsing is most
useful with the widest reach — the arbitrary-path (`type=path`) mode lets the
user navigate `models/`, `custom_nodes/`, anywhere on disk, mirroring
`comfyui-gallery-loader`'s VHS path mode. Managing means **destructive**
operations: delete, rename, move.

A single security posture can't serve both. Arbitrary-path *reads* are already
an accepted, low-blast-radius capability (gallery-loader ships `/thumb` and
`/file` gated only on an extension whitelist). Arbitrary-path *writes*, by
contrast, would let a crafted request delete or overwrite any file the ComfyUI
process can touch — a qualitatively larger risk that a whitelist alone does not
contain.

## Decision

Split the perimeter by operation, not by folder:

- **Reads** (`/list`, `/thumb`, `/file`) accept the sandboxed types
  (`input`/`output`/`temp`) **and** arbitrary absolute paths (`type=path`).
  Arbitrary-path reads gate on `IMG_EXTS` / `STREAMABLE_EXTS` before touching
  disk — the same posture as gallery-loader.
- **Writes** (`/delete`, `/rename`, `/move`) are restricted to the **sandboxed
  roots only**. Every write goes through `_resolve_sandboxed_file`, which:
  1. **rejects `type=path`** outright (`writes are only allowed in
     input/output/temp`);
  2. requires a **bare, traversal-free** filename (`_is_bare_name`);
  3. enforces the **media-extension whitelist**;
  4. re-asserts **containment** in the resolved root via `os.path.commonpath`.
  `/rename` and `/move` refuse to clobber an existing target (HTTP 409).

- **The frontend mirrors the gate.** `renderGrid` only emits the
  rename/move/delete controls for `SANDBOXED_TYPES` (`canWrite`); the `browse…`
  tab is open-only. The backend is the real gate; the frontend mirror is UX.

## Consequences

- Browsing keeps its wide, convenient reach; a crafted request can never mutate
  a file outside `input`/`output`/`temp`.
- Managing files in arbitrary locations is **out of scope for v1** by design. If
  a future version needs it, it is a deliberate posture change (a new ADR), not
  a quiet widening of a write to `type=path`.
- The gate is unit-tested at its rejection boundary (`tests/test_helpers.py`);
  happy-path containment needs a real `folder_paths` and is covered by the live
  smoke matrix.

## Amendment (2026-08, PR #109) — the reach became opt-in, and containment moved to the root

Two claims above are no longer accurate. Recorded here rather than rewritten in
place, because *why* they changed is the useful part.

**"Arbitrary-path reads are an accepted, low-blast-radius capability."** They
are not low-blast-radius on a server with no authentication, and the split this
ADR drew — reads wide, writes narrow — is now drawn one notch tighter: every
arbitrary-path READ (`/file`, `/thumb?path=`, `/metadata?path=`,
`/list?type=path`) is behind the default-off setting
`ImageBrowser.AllowAbsolutePathReads`. The reasoning that kept three of them
open was that only `/file` returns a file's bytes; measured with the switch off,
`/thumb?path=` returned a decoded 512x384 WebP of a file outside every root. A
re-encode is a read. The decision's *shape* survives — reads may reach further
than writes — but the wide reach is now a configuration choice rather than a
default.

**"Containment in the resolved root via `os.path.commonpath`"** is now two
checks, and the second one's anchor is load-bearing. The lexical `commonpath`
stays. Beside it, a `realpath` check anchored on
`realpath(folder_paths.get_directory_by_type(type))` — the **root**, never the
subfolder-resolved base. Anchoring on the base resolves a symlinked subfolder
*into* the anchor, after which the target is contained by construction:
`output/link -> /etc` plus `POST /delete {subfolder: "link", name: "passwd.png"}`
answered `200 {"ok": true}` and deleted the victim.

The root anchor keeps a symlinked ROOT writable and costs the symlinked
SUBFOLDER, which is a real layout — so that is handed back by a second,
separate, default-off setting `ImageBrowser.AllowSymlinkedSubfolderWrites`. It
widens the subfolder only; a symlinked filename stays refused with it on.

**"The gate is unit-tested at its rejection boundary."** It is now tested at
both boundaries, end to end through `/delete` and `/rmdir` with real symlinks,
in `tests/test_guard.py`, with mutation entries in `tests/mutations-guard.json`
proving each assertion can fail.

## Amendment (2026-10, issue #113): the setting is not a boundary, so the reach is fixed

The 2026-08 amendment made every absolute-path read opt-in through
`ImageBrowser.AllowAbsolutePathReads`. Registry moderation kept 0.1.32 and
0.1.33 flagged as `arbitrary-file-read` afterwards, and the flag was right.
The setting lives in the user's `comfy.settings.json`, and core's
`POST /settings/{id}` (app/app_settings.py) writes that file for any caller
with no authentication. Any caller who can reach the port, which includes the
whole LAN on a `--listen 0.0.0.0` install, can switch the opt-in on with one
request and then read any media file on the host. "Cannot be flipped by a
request parameter or a header" was true. It was also beside the point, because
core provides another request that flips it.

Decision: the setting still decides **whether** the browse… tab works. Where
it reaches is fixed to `_read_roots()`: `folder_paths.base_path`, the
input/output/temp/user directories, and every path in
`folder_paths.folder_names_and_paths`, which includes models, custom_nodes and
`extra_model_paths.yaml` entries. All four reads (`/list?type=path`, `/file`,
`/thumb?path=`, `/metadata?path=`) check it lexically (`abspath` and
`commonpath`) before any disk touch, and answer `403` naming the remedy.

- **Widening takes the server's filesystem.** An operator lists the folder in
  `extra_model_paths.yaml` or symlinks it inside the tree. The check is
  lexical, so `..` cannot escape while an operator's symlink is followed. No
  route in this pack or in core creates a symlink.
- **Not an environment variable.** `os.environ` is a scanner tripwire that
  `tests/test_publish_hygiene.py` keeps out of shipped code. ComfyUI's
  directory list is already server-side configuration.
- **The ADR's shape survives.** Reads still reach further than writes, since
  the browse… tab covers `models/` and `custom_nodes/` and writes stay in
  input/output/temp. The reads no longer reach the whole host.

Pinned by `tests/test_read_reach.py`, which runs every case with the setting
ON. `tests/mutations-read-reach.json` proves each assertion can fail.
