// rating-cache.ts — asset addressing + the shared rating cache used by both
// stock-UI injectors (sidebar-stars.ts, lightbox-actions.ts).
//
// The cache is module-level and SHARED on purpose: rating a file in the
// lightbox must be visible on the sidebar card underneath it once the lightbox
// closes. Keyed by file address, never by DOM node — the sidebar's card grid is
// virtualized and recycles elements between files, so any node-bound state is a
// wrong-rating-on-the-wrong-image bug waiting to happen.

import type { RatingAddress } from "@laurigates/comfy-modal-kit";
import { SANDBOXED_TYPES } from "./api.js";

/** Batch READ of ratings — one request per settle, not one per card. */
const RATINGS_URL = "/image_browser/ratings";
/** Matches the backend's MAX_RATING_BATCH; keeps one pass under its cap. */
export const MAX_BATCH = 200;

/** Address → last known rating. Survives card recycling; keyed by file, not node. */
export const ratingCache = new Map<string, number>();
/** Addresses already asked for, so a scroll-back does not re-request them. */
export const requested = new Set<string>();

/** Drop all cached state. Called when an injector (re)installs. */
export function clearRatingState(): void {
  ratingCache.clear();
  requested.clear();
}

export function addressKey(a: RatingAddress): string {
  return `${a.type} ${a.subfolder} ${a.name}`;
}

/**
 * Parse a ComfyUI preview URL into the address the rating endpoints take.
 *
 * Returns null — rather than a guess — for anything that is not a
 * sandboxed-root view URL: a blob:/data: placeholder, a cloud asset URL, a
 * `type` outside input/output/temp. The caller renders no stars in that case,
 * which is the correct answer for a file this pack cannot address.
 *
 * `type` defaults to "input" because that is what ComfyUI's own /api/view
 * does when the parameter is omitted; `subfolder` defaults to "" for the same
 * reason. Exported for the unit tests — this is the one piece of the injectors
 * that is pure, and it is where the interesting edge cases live.
 */
export function parseAssetAddress(src: string | null | undefined): RatingAddress | null {
  if (!src) return null;
  let url: URL;
  try {
    // Relative srcs are the common case (`/api/view?...`); the base is only
    // needed to make URL() accept them and is never read back.
    url = new URL(src, "http://localhost");
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/api/view")) return null;
  const name = url.searchParams.get("filename");
  if (!name) return null;
  const type = url.searchParams.get("type") || "input";
  if (!SANDBOXED_TYPES.includes(type as (typeof SANDBOXED_TYPES)[number])) return null;
  return { type, subfolder: url.searchParams.get("subfolder") || "", name, absDir: "" };
}

/** Batch-read ratings for `addrs`. `null` at an index means "could not read". */
export async function fetchRatings(addrs: RatingAddress[]): Promise<(number | null)[]> {
  const res = await fetch(RATINGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: addrs.map((a) => ({ type: a.type, subfolder: a.subfolder, name: a.name })),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; ratings?: (number | null)[]; error?: string };
  if (!data.ok || !Array.isArray(data.ratings)) throw new Error(data.error || "bad response");
  return data.ratings;
}
