// safe-tag.ts — the "mark sensitive" control.
//
// Safe View's keyword tiers match a file's NAME, its PATH and its `dc:subject`
// KEYWORDS. The first two are whatever the user's folders happen to be called;
// this is the third, and the only one the user can set from inside ComfyUI. It
// writes a real interoperable keyword — the same `dc:subject` array digiKam,
// Lightroom, Bridge, XnView and Windows read — so a file marked here reads as
// tagged everywhere else, and a file tagged there reads as sensitive here.
//
// STILL DISCRETION, NOT ACCESS CONTROL. Marking a file changes what the grid
// blurs and what /list returns; every other endpoint serves the same bytes to
// anything that addresses the file directly, exactly as before.
//
// A PORT of `comfyui-gallery-loader/src/safe-tag.ts`, not a shared module: the
// two packs are separate npm-less repos and the kit is what they share.
//
// WHAT IS LEFT HERE IS THE PART THAT DIVERGED ON PURPOSE. `sensitiveKeyword`
// was the one function that should not have stayed duplicated — two packs
// writing the same keyword into the same files on disk — and it now lives in
// the kit's safe-view.ts (laurigates/comfy-modal-kit#33, adopted at 0.14.0);
// import it from `@laurigates/comfy-modal-kit`. The three below stay: this
// pack's `tagRequestBody` has no `type: "path"` arm (ADR-0002 — a tag write is
// a write, and `/image_browser/tag` rejects `type=path`), its `TagAddress`
// carries no `absDir`, and `markSensitiveHTML` emits this pack's own class
// prefix. Unifying any of them would silently reverse a considered decision.

/** This pack's own route. `comfyui-gallery-loader` posts to its own. */
export const TAG_URL = "/image_browser/tag";

/** Where a file lives — same shape as the kit's `RatingAddress`, deliberately. */
export interface TagAddress {
  type: string;
  subfolder: string;
  name: string;
}

/** The `tags` a listing row carries. Absent on a row from an older backend. */
export interface TaggedFile {
  tags?: readonly string[];
}

/**
 * Whether a file already carries EXACTLY this keyword — the control's pressed
 * state, and which way the next tap writes.
 *
 * Exact (case-insensitively), not "would the filter match it": a file tagged
 * `nsfw art` is hidden by the keyword `nsfw` but does not carry it, and a
 * control that showed itself as pressed there would offer to remove a keyword
 * that is not on the file. Reading it as unmarked is the truthful state and the
 * tap adds the keyword the filter actually names.
 */
export function hasSensitiveTag(f: TaggedFile, keyword: string): boolean {
  const want = keyword.toLowerCase();
  return (f.tags ?? []).some((t) => t.toLowerCase() === want);
}

/**
 * The POST body. Sandboxed roots only — there is no `type: "path"` arm, because
 * a tag write is a WRITE and `/image_browser/tag` rejects `type=path` exactly
 * as `/delete`, `/rename` and `/rating` do (ADR-0002). The caller gates the
 * control on `canWriteFile(f)`, so a path-tab card never reaches here.
 */
export function tagRequestBody(
  addr: TagAddress,
  tag: string,
  present: boolean,
): Record<string, unknown> {
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, tag, present };
}

/**
 * Write the keyword. Resolves to the file's keywords AFTER the write, as the
 * server read them back — not to what was sent. The two differ whenever the
 * file already carried the keyword under a different casing, and echoing the
 * request would paint a state the file does not have.
 */
export async function postTag(
  url: string,
  addr: TagAddress,
  tag: string,
  present: boolean,
): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tagRequestBody(addr, tag, present)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; error?: string; tags?: unknown };
  if (!data.ok) throw new Error(data.error || "tag failed");
  return Array.isArray(data.tags) ? (data.tags as string[]) : [];
}

/**
 * Markup for the per-card control, or "" when there is no keyword to write.
 *
 * The keyword is named in the `title` so the control cannot be mistaken for a
 * generic "hide this" — it says which word it writes into the file, which is
 * what makes the round trip through another photo manager predictable. The
 * caller escapes nothing: `keyword` has been through `parseKeywords`, which
 * strips every non-alphanumeric character. The label quotes it with `‘…’`
 * rather than `"…"` for the same reason — a straight double quote would close
 * the `title="…"` attribute this string is interpolated into.
 */
export function markSensitiveHTML(prefix: string, keyword: string, marked: boolean): string {
  const label = marked
    ? `Unmark sensitive (removes ‘${keyword}’)`
    : `Mark sensitive (‘${keyword}’)`;
  return `<button type="button" class="${prefix}-act ${prefix}-act-mark${marked ? " is-marked" : ""}" data-action="marksensitive" aria-pressed="${marked}" title="${label}" aria-label="${label}">🙈</button>`;
}
