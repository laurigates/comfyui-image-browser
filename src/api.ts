// api.ts — typed wrappers over the /image_browser/* backend endpoints plus the
// URL builders the grid uses for thumbnails and previews. No DOM here.

export const EXT_NAME = "comfyui-image-browser";

const BASE_URL = "/image_browser/base";
const LIST_URL = "/image_browser/list";
const THUMB_URL = "/image_browser/thumb";
const FILE_URL = "/image_browser/file";
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
}

interface ListParams {
  type: BrowseType;
  subfolder?: string;
  path?: string;
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
// folder into itself or a descendant (409/400 surfaces as a rejected promise).
export function moveDir(
  type: BrowseType,
  subfolder: string,
  name: string,
  destType: BrowseType,
  destSubfolder: string,
): Promise<void> {
  return postJSON(MOVE_DIR_URL, {
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
