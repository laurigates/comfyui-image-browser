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
