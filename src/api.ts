// api.ts — typed wrappers over the /image_browser/* backend endpoints plus the
// URL builders the grid uses for thumbnails and previews. No DOM here.

export const EXT_NAME = "comfyui-image-browser";

const BASE_URL = "/image_browser/base";
const LIST_URL = "/image_browser/list";
const THUMB_URL = "/image_browser/thumb";
const FILE_URL = "/image_browser/file";
const DELETE_URL = "/image_browser/delete";
const RENAME_URL = "/image_browser/rename";
const MOVE_URL = "/image_browser/move";

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

// input/output/temp use core /api/view (subfolder + preview scaling built in);
// arbitrary paths fall back to our own /thumb + /file endpoints.
export function imageThumbURL(
  type: BrowseType,
  subfolder: string,
  name: string,
  absDir: string,
): string {
  if (type === "path") {
    return `${THUMB_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({
    filename: name,
    type,
    subfolder: subfolder || "",
    preview: "webp;75",
  });
  return `/api/view?${p.toString()}`;
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
