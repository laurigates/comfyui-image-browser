// api.ts — typed wrappers over the /image_browser/* backend endpoints plus the
// URL builders the grid uses for thumbnails and previews. No DOM here.

import type { PromptVerdict } from "@laurigates/comfy-modal-kit";

export const EXT_NAME = "comfyui-image-browser";

const BASE_URL = "/image_browser/base";
const LIST_URL = "/image_browser/list";
const THUMB_URL = "/image_browser/thumb";
const FILE_URL = "/image_browser/file";
const METADATA_URL = "/image_browser/metadata";
const DELETE_URL = "/image_browser/delete";
const DELETE_MANY_URL = "/image_browser/delete_many";
const RENAME_URL = "/image_browser/rename";
const MOVE_URL = "/image_browser/move";
const MOVE_DIR_URL = "/image_browser/move_dir";
const MOVE_MANY_URL = "/image_browser/move_many";
const RMDIR_URL = "/image_browser/rmdir";
const MKDIR_URL = "/image_browser/mkdir";
const PINS_URL = "/image_browser/pins";
export const RATING_URL = "/image_browser/rating";
const SAFEVIEW_WARM_URL = "/image_browser/safeview_warm";

export const IMG_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif",
]);
export const VIDEO_EXTS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpg",
  ".mpeg",
]);

// Video containers whose embedded metadata the backend can actually read —
// ISOBMFF (MP4/MOV/M4V) and Matroska (WebM/MKV). Deliberately NARROWER than
// VIDEO_EXTS: .avi/.mpg have no reader, and this set is what decides whether a
// card gets the ⓘ / ⤓ buttons, so listing a container the endpoint 400s on
// would ship two dead controls. It mirrors the backend's METADATA_EXTS (itself
// derived from image_meta.FORMAT_EXTS); tests/test_metadata.py reads this
// literal back out of the source and fails if the two ever disagree, because a
// silently drifted mirror is exactly the failure the write-gate mirror warns
// about — a control that is present here and rejected there.
export const META_VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);

// Everything /metadata answers for. Images are all admitted: one whose format
// has no parser (a .gif) answers 200 with empty metadata rather than an error,
// which is the honest "nothing embedded here" the overlay renders.
export const META_EXTS = new Set([...IMG_EXTS, ...META_VIDEO_EXTS]);

// The three sandboxed ComfyUI roots the browser exposes as tabs, plus the
// arbitrary-path mode and the pinned view. Writes (delete/rename/move) are
// backend-restricted to the sandboxed roots; "path" is browse-only.
//
// "pinned" is a VIEW, never a write target and never a request parameter: its
// grid is assembled from /pins, and every card in it carries its OWN root in
// `pinType` (pins span roots). It is deliberately absent from SANDBOXED_TYPES —
// a per-card control must therefore gate on the card's own type, not on the
// location's, which is what browser.ts's fileType()/canWriteFile() exist for.
export type BrowseType = "input" | "output" | "temp" | "path" | "pinned";
export const SANDBOXED_TYPES: BrowseType[] = ["input", "output", "temp"];

interface BasePaths {
  base_path: string;
  input_dir: string;
  output_dir: string;
  temp_dir: string;
  user_dir?: string;
  ok?: boolean;
  error?: string;
}

interface ListingDir {
  name: string;
  mtime?: number;
}

export interface ListingFile {
  name: string;
  ext?: string;
  mtime: number;
  size?: number;
  width?: number;
  height?: number;
  rating?: number;
  // Present only in a recursive ("flat") listing: the file's directory relative
  // to the requested subfolder (forward-slashed, "" for a top-level file). The
  // grid labels the card with it and joins it onto the request subfolder to
  // address the file's thumbnail and mutations.
  subpath?: string;
  // The three below are present ONLY in a pinned listing (pinsToFiles), never in
  // a /list response. Pins span roots, so a pinned card cannot be addressed off
  // the location the way a folder/flat card can: it carries its own root and
  // subfolder, which browser.ts's fileType()/fileSub() read in preference to
  // state.type/state.subfolder. `subpath` is deliberately NOT reused for
  // pinSub — subpath means "relative to the requested subfolder", and a pinned
  // grid has no requested subfolder to be relative to.
  pinType?: BrowseType;
  pinSub?: string;
  pinKind?: "dir" | "file";
  // False when the pin no longer resolves on disk. Such an entry is RETURNED,
  // not dropped ("the file moved" and "you never pinned it" are different
  // facts), and renders dimmed with an unpin affordance.
  pinExists?: boolean;
  // Safe View's opt-in prompt tier. Present ONLY when the listing was requested
  // with `safePrompt`, and only for a file whose container has a metadata
  // reader. The snake_case name is the backend's JSON key verbatim.
  //
  // FOUR STATES, and the two easy to collapse are the two that matter:
  // `"unscanned"` means the file participates but has no cached verdict yet and
  // is read as SENSITIVE (fail-safe), while ABSENT means the file is outside the
  // tier and is never sensitive by it. A folder card and a .avi are absent, not
  // unscanned — collapsing the two would blur the whole grid the moment the tier
  // came on. See the kit's PromptVerdict doc comment.
  prompt_match?: PromptVerdict;
}

interface ListResponse {
  ok: boolean;
  error?: string;
  type: string;
  subfolder: string;
  path: string;
  dirs: ListingDir[];
  files: ListingFile[];
  exists: boolean;
  // True when a recursive listing hit the backend's file cap and stopped early.
  truncated?: boolean;
  // Safe View prompt tier: how many files this listing could not yet judge —
  // returned with the `"unscanned"` sentinel, or dropped outright when hiding is
  // also on (where nothing carries a sentinel to count). Present only when the
  // tier was requested. It is what the toolbar's "scanning N" pill reports, so a
  // mostly-blurred grid on first enable explains itself instead of looking broken.
  safe_unscanned?: number;
}

// Which media family the listing is narrowed to — the toolbar's segmented
// All / 🖼 Images / 🎬 Videos control. The names are the backend's `kind=`
// values verbatim; tests/test_helpers.py asserts them against KIND_FILTERS,
// because a drift here would be a silent no-filter rather than an error.
export type TypeFilter = "all" | "images" | "videos";

interface ListParams {
  type: BrowseType;
  subfolder?: string;
  path?: string;
  // Flat view: walk the subfolder recursively and return every descendant file
  // (each tagged with its subpath). Sandboxed roots only — ignored for path mode.
  recursive?: boolean;
  // Narrow the listing to one media family. Filtered server-side because both
  // listing paths cap at 5000 files by mtime AFTER sorting: narrowing on the
  // server spends that cap on the kind asked for (the newest N videos), while
  // filtering the response here would filter an already-truncated listing.
  kind?: TypeFilter;
  // Safe View's keyword list, already normalized by the kit's parseKeywords.
  // Sent as a comma-separated string; the backend re-parses it with the same
  // rules, so a stray separator or an odd case cannot make the two disagree.
  safeKeywords?: readonly string[];
  // Drop matching entries server-side instead of blurring them here. Filtered
  // above the same newest-N cap, and for exactly the reason `kind` is: a folder
  // of mostly-sensitive files must still return a full page of the rest, where
  // dropping them from an already-truncated response would return a near-empty
  // grid. This is the whole reason hiding is a backend feature at all.
  safeHide?: boolean;
  // Also match the file's embedded generation prompt and model name. Opt-in and
  // OFF by default because it is the only tier that costs a file parse per file;
  // the backend answers from a persistent cache and reports "unscanned" for
  // anything not in it yet. Independent of `safeHide` — the two compose.
  safePrompt?: boolean;
}

let BASE_PATHS: BasePaths | null = null;

export async function fetchBasePaths(): Promise<BasePaths> {
  if (BASE_PATHS) return BASE_PATHS;
  let resolved: BasePaths;
  try {
    const r = await fetch(BASE_URL, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "base paths fetch failed");
    resolved = data;
  } catch (e) {
    console.warn(`[${EXT_NAME}] ${BASE_URL} failed`, e);
    resolved = { base_path: "/", input_dir: "", output_dir: "", temp_dir: "" };
  }
  BASE_PATHS = resolved;
  return resolved;
}

export async function fetchListing(p: ListParams): Promise<ListResponse> {
  const params = new URLSearchParams();
  if (p.type === "path") {
    params.set("type", "path");
    params.set("path", p.path || "/");
  } else {
    params.set("type", p.type);
    params.set("subfolder", p.subfolder || "");
    if (p.recursive) params.set("recursive", "1");
  }
  // Deliberately OUTSIDE the branch: the filter applies on the browse…/path tab
  // too, and setting it in both arms is the shape that already lost `recursive`
  // from the path request above. Omitted for "all" so the default request URL
  // stays byte-identical to what it was before the filter existed.
  if (p.kind && p.kind !== "all") params.set("kind", p.kind);
  // Both conditions, deliberately: the backend also refuses to filter on an
  // empty keyword list, so a caller that sent `safe_hide=1` alone would get an
  // unfiltered listing while believing it had asked for a filtered one. Sending
  // nothing in that case makes the request honest about what it wants.
  if (p.safeHide && p.safeKeywords && p.safeKeywords.length > 0) {
    params.set("safe_kw", p.safeKeywords.join(","));
    params.set("safe_hide", "1");
  }
  // Same both-conditions rule as `safe_hide`, and for the same reason: the
  // backend refuses to run the tier on an empty keyword list, so sending the
  // flag alone would ask for a filter it will not get. `safe_kw` is set here too
  // rather than assumed from the branch above — the two flags are independent,
  // and the prompt tier is usable with hiding off.
  if (p.safePrompt && p.safeKeywords && p.safeKeywords.length > 0) {
    params.set("safe_kw", p.safeKeywords.join(","));
    params.set("safe_prompt", "1");
  }
  const r = await fetch(`${LIST_URL}?${params.toString()}`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as ListResponse;
  if (!data.ok) throw new Error(data.error || "listing failed");
  return data;
}

// ---- Thumbnail / preview URL dispatch ---------------------------------

export function joinAbs(dir: string, name: string): string {
  const d = (dir || "/").replace(/\/+$/, "");
  return d === "" ? `/${name}` : `${d}/${name}`;
}

// All image thumbnails go through the pack's own /thumb endpoint (never core
// /api/view, which re-encodes on every request with no cache headers). The
// ?v= cache key (mtime + size from /list) pairs with the backend's long
// max-age: a changed file keys a new URL, an unchanged one never re-fetches.
export function thumbVersion(mtime: number, size?: number): string {
  return `${mtime}-${size ?? 0}`;
}

export function imageThumbURL(
  type: BrowseType,
  subfolder: string,
  name: string,
  absDir: string,
  v: string,
): string {
  if (type === "path") {
    return `${THUMB_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}&v=${encodeURIComponent(v)}`;
  }
  const p = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name,
    v,
  });
  return `${THUMB_URL}?${p.toString()}`;
}

export function videoSrcURL(
  type: BrowseType,
  subfolder: string,
  name: string,
  absDir: string,
): string {
  if (type === "path") {
    return `${FILE_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `/api/view?${p.toString()}`;
}

// The full-size view opens the original (no downscale) in a new tab.
export function fullSrcURL(
  type: BrowseType,
  subfolder: string,
  name: string,
  absDir: string,
): string {
  if (type === "path") {
    return `${FILE_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `/api/view?${p.toString()}`;
}

// ---- Embedded generation metadata (read-only) --------------------------
//
// /metadata is a READ, so it takes the same dual addressing as /thumb — including
// type=path. It is gated on IMG_EXTS server-side (images only, no video), and it
// NEVER fabricates: a summary key the backend could not read is simply absent
// from the response, which is why every field below is optional.

// The recognised generation parameters. Mirrors the backend's summary keys
// (image_meta.SUMMARY_WIDGETS + the prompt/model resolvers); a key the parser
// could not fill is omitted from the response rather than sent empty. Module-local
// on purpose — callers reach these keys through ImageMetadata / MetaRow and never
// need to name the union, so exporting it would only add an unused export.
type MetaField =
  | "positive"
  | "negative"
  | "seed"
  | "steps"
  | "cfg"
  | "sampler"
  | "scheduler"
  | "model";

export interface ImageMetadata {
  ok: boolean;
  // Container label, derived from the extension ("png" / "jpeg" / "webp"); "" for
  // an image whose format has no parser (a .gif is still a 200 with empty data).
  format: string;
  // Which writer's metadata was recognised. "comfyui" is reported whenever the
  // container carried a Comfy graph, even if the summary came out empty.
  source: "comfyui" | "a1111" | "none";
  summary: Partial<Record<MetaField, string>>;
  // Every embedded text key the container yielded, verbatim (the raw disclosure).
  raw: Record<string, string>;
  // True when the backend clipped a value (or the whole payload) at its cap.
  truncated?: boolean;
}

export async function fetchMetadata(
  type: BrowseType,
  subfolder: string,
  name: string,
  absDir: string,
): Promise<ImageMetadata> {
  const params =
    type === "path"
      ? new URLSearchParams({ path: joinAbs(absDir, name) })
      : new URLSearchParams({ type, subfolder: subfolder || "", name });
  const r = await fetch(`${METADATA_URL}?${params.toString()}`, { cache: "no-cache" });
  // The backend answers its refusals through _err (a JSON body with the reason
  // AND a 4xx status), so parse the body before deciding the message — a bare
  // `HTTP 400` would hide "unsupported file type".
  let data: Partial<ImageMetadata> & { error?: string } = {};
  try {
    data = await r.json();
  } catch {
    // fall through to status-based error below
  }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return {
    ok: true,
    format: data.format || "",
    source: data.source || "none",
    summary: data.summary || {},
    raw: data.raw || {},
    truncated: data.truncated === true,
  };
}

// Which raw keys carry a loadable graph, in ComfyUI's own preference order.
// `workflow` is the editable graph (node positions, groups, widget values);
// `prompt` is the flattened API-format graph the backend actually executed.
// ComfyUI's handleFile() prefers the former and falls back to the latter, so a
// prompt-only image (one saved by a node that omits the UI graph) still loads —
// as a reconstructed graph rather than the original layout.
const WORKFLOW_RAW_KEYS = ["workflow", "prompt"] as const;

// Does this image actually carry a graph? Used to decide BEFORE fetching the
// full-size bytes, so an image with no workflow gets an honest "none here"
// instead of handleFile() silently doing nothing (its no-workflow path is a
// quiet return, which would read to the user as a broken button).
//
// Whitespace-only and literal "null"/"{}" values count as absent: some writers
// emit the key with an empty payload, and a truthiness check alone would
// promise a graph the loader then can't produce.
export function embeddedWorkflowJSON(
  meta: Pick<ImageMetadata, "raw"> | null | undefined,
): string | null {
  const raw = meta?.raw;
  if (!raw) return null;
  for (const k of WORKFLOW_RAW_KEYS) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t !== "" && t !== "null" && t !== "{}" && t !== "[]") return v;
  }
  return null;
}

export function hasEmbeddedWorkflow(meta: Pick<ImageMetadata, "raw"> | null | undefined): boolean {
  return embeddedWorkflowJSON(meta) !== null;
}

// Display order for the summary, in one place so the overlay rows and the
// copy-all clipboard block can never disagree. Prompts first (they are what
// actually gets copied), then the model, then the numerics.
export const META_FIELDS: { key: MetaField; label: string }[] = [
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "model", label: "Model" },
  { key: "seed", label: "Seed" },
  { key: "steps", label: "Steps" },
  { key: "cfg", label: "CFG" },
  { key: "sampler", label: "Sampler" },
  { key: "scheduler", label: "Scheduler" },
];

export interface MetaRow {
  key: MetaField;
  label: string;
  value: string;
}

// Walk META_FIELDS (not the response's own key order — that is JSON insertion
// order and varies by writer) and drop anything missing or whitespace-only, so
// an unknown field never renders as a bare "Negative:" row with a Copy button
// that copies nothing. Values are String()-coerced defensively: the backend
// stringifies everything, but a hand-rolled proxy or a future numeric key must
// not put `[object Object]` — or a throw — in front of the user.
export function metaRows(
  summary: Partial<Record<MetaField, unknown>> | null | undefined,
): MetaRow[] {
  const rows: MetaRow[] = [];
  if (!summary || typeof summary !== "object") return rows;
  const bag = summary as Record<string, unknown>;
  for (const { key, label } of META_FIELDS) {
    const v = bag[key];
    if (v === undefined || v === null) continue;
    const value = String(v);
    if (!value.trim()) continue;
    rows.push({ key, label, value });
  }
  return rows;
}

// The "Copy all" payload. Multi-line prompts stay verbatim (no re-indent, no
// quoting) so the text can be pasted straight back into a prompt box.
export function metaClipboardText(rows: MetaRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}`).join("\n");
}

// ---- Mutations (sandboxed roots only) ---------------------------------

async function postJSON(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: { ok?: boolean; error?: string } = {};
  try {
    data = await r.json();
  } catch {
    // fall through to status-based error below
  }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
}

export function deleteFile(type: BrowseType, subfolder: string, name: string): Promise<void> {
  return postJSON(DELETE_URL, { type, subfolder, name });
}

export function renameFile(
  type: BrowseType,
  subfolder: string,
  name: string,
  newName: string,
): Promise<void> {
  return postJSON(RENAME_URL, { type, subfolder, name, new_name: newName });
}

export function moveFile(
  type: BrowseType,
  subfolder: string,
  name: string,
  destType: BrowseType,
  destSubfolder: string,
): Promise<void> {
  return postJSON(MOVE_URL, {
    type,
    subfolder,
    name,
    dest_type: destType,
    dest_subfolder: destSubfolder,
  });
}

// Move a folder (with its whole subtree) into another sandboxed root/subfolder.
// The folder keeps its name; only its parent changes. Backend refuses moving a
// folder into itself or a descendant (400/409 surfaces as a rejected promise).
// When a folder of the same name already exists at the destination the two are
// MERGED (ok:true, merged:true): non-colliding entries move in, matching
// subfolders merge recursively, and any file that would be overwritten is left
// in the source and reported in errors[] — so a merge with conflicts is NOT a
// throw (like the batch endpoints).
interface MoveDirResult {
  ok: boolean;
  merged?: boolean;
  errors?: BatchError[];
}

export function moveDir(
  type: BrowseType,
  subfolder: string,
  name: string,
  destType: BrowseType,
  destSubfolder: string,
): Promise<MoveDirResult> {
  return postJSONBatch<MoveDirResult>(MOVE_DIR_URL, {
    type,
    subfolder,
    name,
    dest_type: destType,
    dest_subfolder: destSubfolder,
  });
}

// ---- Batch mutations (sandboxed roots only) ---------------------------
//
// Batch endpoints return ok:true with per-item errors in an errors[] array —
// a partial success is NOT a throw. The wrapper only throws on a top-level
// failure (non-2xx or ok:false), so the caller can surface per-item failures
// after re-listing the directory.

export interface BatchItem {
  type: BrowseType;
  subfolder: string;
  name: string;
}

interface BatchError {
  name: string;
  error: string;
}

interface DeleteManyResult {
  ok: boolean;
  deleted: number;
  errors?: BatchError[];
}

interface MoveManyResult {
  ok: boolean;
  moved: number;
  errors?: BatchError[];
}

async function postJSONBatch<T extends { ok: boolean; errors?: BatchError[] }>(
  url: string,
  body: unknown,
): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: T;
  try {
    data = (await r.json()) as T;
  } catch {
    throw new Error(`HTTP ${r.status}`);
  }
  // Batch endpoints return ok:true even when some items failed (the errors
  // list carries per-item detail). Only throw on a top-level failure.
  if (!r.ok || !data?.ok) {
    const msg = (data as { error?: string })?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

export function deleteMany(items: BatchItem[]): Promise<DeleteManyResult> {
  return postJSONBatch<DeleteManyResult>(DELETE_MANY_URL, { items });
}

interface WarmResult {
  ok: boolean;
  scanned: number;
}

/**
 * Ask the backend to parse and cache the prompt metadata of these files.
 *
 * The prompt tier's FAST warmer, driven by the `executed` websocket event: a
 * file the user just generated is the most visible card in the grid, and
 * without this it would be `"unscanned"` — and therefore blurred — until the
 * background sweep next ran. The sweep covers the backlog; this covers the
 * present. Neither subsumes the other.
 */
export function warmSafeView(items: BatchItem[]): Promise<WarmResult> {
  return postJSONBatch<WarmResult>(SAFEVIEW_WARM_URL, { items });
}

// ---- Folder deletion (sandboxed roots only) ----------------------------
//
// /rmdir is a two-step contract: a non-empty folder without recursive:true
// answers 409 with the nested file/dir counts, so the UI can surface a
// "contains N files" confirm and re-post with recursive:true. An empty
// folder deletes on the first call.

type RmdirResult =
  | { status: "deleted"; files: number; dirs: number }
  | { status: "not_empty"; files: number; dirs: number };

export async function removeDir(
  type: BrowseType,
  subfolder: string,
  name: string,
  recursive = false,
): Promise<RmdirResult> {
  const r = await fetch(RMDIR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, subfolder, name, recursive }),
  });
  let data: { ok?: boolean; error?: string; files?: number; dirs?: number } = {};
  try {
    data = await r.json();
  } catch {
    // fall through to status-based error below
  }
  if (r.ok && data.ok) {
    return { status: "deleted", files: data.files ?? 0, dirs: data.dirs ?? 0 };
  }
  if (r.status === 409 && typeof data.files === "number") {
    return { status: "not_empty", files: data.files, dirs: data.dirs ?? 0 };
  }
  throw new Error(data.error || `HTTP ${r.status}`);
}

export function moveMany(
  items: BatchItem[],
  destType: BrowseType,
  destSubfolder: string,
): Promise<MoveManyResult> {
  return postJSONBatch<MoveManyResult>(MOVE_MANY_URL, {
    items,
    dest_type: destType,
    dest_subfolder: destSubfolder,
  });
}

// ---- Folder creation (sandboxed roots only) ----------------------------
//
// Creates a new folder under the current subfolder. postJSON throws on a
// top-level failure, so a name collision (409) surfaces as a rejected promise
// with the backend's error message.
export function makeDir(type: BrowseType, subfolder: string, name: string): Promise<void> {
  return postJSON(MKDIR_URL, { type, subfolder, name });
}

// ---- Pins (server-side, shared between packs AND devices) --------------
//
// The list lives in <user_dir>/comfy-pins.json (pins_store.py), NOT in
// localStorage: a phone and a desktop are two browsers against one ComfyUI, and
// localStorage structurally cannot span them. A pin addresses a sandboxed root
// only — `type=path` is rejected by the store, the same perimeter as every
// write.

// One stored pin. `name` is present iff kind === "file"; `subfolder` is "" at a
// root and otherwise forward-slashed and relative.
export interface PinItem {
  kind: "dir" | "file";
  type: BrowseType;
  subfolder: string;
  name?: string;
}

// A pin as the endpoints ANSWER it: the stored item, plus `exists`, plus — for
// a resolvable file — the same per-file keys /list emits, so the pinned view
// renders through the ordinary renderGrid with no special-casing.
export interface PinEntry extends PinItem {
  exists: boolean;
  ext?: string;
  mtime?: number;
  size?: number;
  width?: number;
  height?: number;
  rating?: number;
}

// Not exported: callers consume it through fetchPins/postPinDelta's inferred
// return type and never need to name it, exactly like ListResponse above.
interface PinsResponse {
  ok: boolean;
  max: number;
  pins: PinEntry[];
}

// Identity of a pin — what add/remove dedupe on, and what the frontend's
// "is this pinned?" Set keys. Mirrors pins_store.pin_key: `kind` is part of the
// key, so pinning `output/keep` as a folder does not collide with a file called
// `keep` sitting beside it.
export function pinKeyOf(p: PinItem): string {
  return `${p.kind}:${p.type}:${p.subfolder}:${p.name ?? ""}`;
}

// Both /pins reads and /pins writes answer the SAME shape — the whole freshly
// resolved list — so a delta needs no follow-up GET. Parse the body before
// deciding the message (same discipline as fetchMetadata): a refusal carries
// its reason in `error` alongside a 4xx, and a bare `HTTP 400` would hide
// "pin limit reached (max 200)", which the UI must surface verbatim.
async function readPinsResponse(r: Response): Promise<PinsResponse> {
  let data: Partial<PinsResponse> & { error?: string } = {};
  try {
    data = await r.json();
  } catch {
    // fall through to status-based error below
  }
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return { ok: true, max: typeof data.max === "number" ? data.max : 0, pins: data.pins ?? [] };
}

export async function fetchPins(): Promise<PinsResponse> {
  return readPinsResponse(await fetch(PINS_URL, { cache: "no-cache" }));
}

// One DELTA, never a whole-list PUT: two browsers with the modal open would each
// send their own full list and the second write would silently discard the
// first's pin. `item` is omitted for "prune". Adding an already-present pin is a
// successful no-op, which is what makes the localStorage migration replayable.
export async function postPinDelta(
  op: "add" | "remove" | "prune",
  item?: PinItem,
): Promise<PinsResponse> {
  const body: { op: string; item?: PinItem } = { op };
  if (item) body.item = item;
  const r = await fetch(PINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readPinsResponse(r);
}

// Turn a /pins response into the grid's own ListingFile[]. Folder pins are
// dropped here — they are the toolbar chips and the picker's shortcut rows, not
// cards.
//
// An exists:false entry carries no stats at all, so mtime/size/rating are
// normalized to 0 rather than left undefined: sortFiles compares them
// arithmetically and an undefined would produce NaN orderings that shuffle the
// whole grid, not merely misplace the missing row.
export function pinsToFiles(entries: PinEntry[]): ListingFile[] {
  const out: ListingFile[] = [];
  for (const e of entries) {
    if (e.kind !== "file") continue;
    const name = e.name;
    if (!name) continue;
    const dot = name.lastIndexOf(".");
    out.push({
      name,
      // A missing file has no backend-reported ext; derive it from the pinned
      // name so the card still routes to the right thumbnail kind if it returns.
      ext: (e.ext ?? (dot >= 0 ? name.slice(dot) : "")).toLowerCase(),
      mtime: e.exists ? (e.mtime ?? 0) : 0,
      size: e.exists ? (e.size ?? 0) : 0,
      width: e.width,
      height: e.height,
      rating: e.exists ? (e.rating ?? 0) : 0,
      pinType: e.type,
      pinSub: e.subfolder,
      pinKind: "file",
      pinExists: e.exists,
    });
  }
  return out;
}
