// api.ts — typed wrappers over the /image_browser/* backend endpoints plus the
// URL builders the grid uses for thumbnails and previews. No DOM here.

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
export const RATING_URL = "/image_browser/rating";

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

// The three sandboxed ComfyUI roots the browser exposes as tabs, plus the
// arbitrary-path mode. Writes (delete/rename/move) are backend-restricted to
// the sandboxed roots; "path" is browse-only.
export type BrowseType = "input" | "output" | "temp" | "path";
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
}

interface ListParams {
  type: BrowseType;
  subfolder?: string;
  path?: string;
  // Flat view: walk the subfolder recursively and return every descendant file
  // (each tagged with its subpath). Sandboxed roots only — ignored for path mode.
  recursive?: boolean;
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
export function hasEmbeddedWorkflow(meta: Pick<ImageMetadata, "raw"> | null | undefined): boolean {
  const raw = meta?.raw;
  if (!raw) return false;
  return WORKFLOW_RAW_KEYS.some((k) => {
    const v = raw[k];
    if (typeof v !== "string") return false;
    const t = v.trim();
    return t !== "" && t !== "null" && t !== "{}" && t !== "[]";
  });
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
