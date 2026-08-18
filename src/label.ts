// Card-label shaping: what to drop from a filename, and where to cut it so the
// part that identifies the file survives a narrow card.
//
// THE PROBLEM. `.ib-name` is `white-space: nowrap; text-overflow: ellipsis` at
// 11.5px monospace in a 150px card — about 19 characters. A ComfyUI output name
// under this install's convention is
//
//     hhmmss _ sampler _ scheduler _ s<seed> _ <descriptor> _<counter>_ .ext
//     105129_euler_flux2sched_s633110127082924_klein-snofs-i2i-pid4k_00001_.png
//
// so the first 19 characters are the time plus the sampler — and the sampler,
// scheduler and seed are constant across a whole session. Every card in a day
// folder therefore renders a label that is identical past the sixth character,
// and the descriptor that says what the file actually IS is the part the
// ellipsis eats. Truncating from the end is exactly backwards for this shape.
//
// THE FIX is not a character budget computed in TypeScript. This pack already
// carries one CSS-constant-mirrored-in-TS hazard (CARD_MIN_WIDTH /
// INLINE_ACTION_SLOTS, pinned by a test that reads the constants back out of
// the shipped stylesheet), and a second one would be worse here: `auto-fill`
// almost never hands out the minimum track, so a budget derived from
// `minmax(150px, …)` would over-truncate on every viewport wider than the
// floor. Instead the name is split into two spans and the CSS lets the browser
// ellipsize the HEAD at whatever the real track width is, while the TAIL is
// `flex: 0 0 auto` and never elides. At a wide track nothing is elided at all.
//
// These helpers are pure and DOM-free so they can be asserted in the node test
// tier. The markup that consumes them lives in browser.ts.

/** A name split for rendering: `head` may be ellipsized, `tail` may not. */
export interface SplitName {
  head: string;
  tail: string;
}

/**
 * ComfyUI's save-node counter, as it actually appears on disk.
 *
 * TWO shapes, both sampled from the reference install: core `SaveImage` writes
 * `_00001_` with a trailing underscore, while kijai's WanVideoWrapper writes
 * `_00018` without one. A pattern matching only the first leaves a bare
 * five-digit tail on every video the wrapper produced.
 */
const COUNTER_RE = /_\d{2,6}_?$/;

/**
 * The convention's leading `hhmmss_`.
 *
 * Its presence is what makes the counter redundant — see stripCounter.
 */
const TIME_PREFIX_RE = /^\d{6}_/;

/** A trailing extension: a dot plus 1-5 alphanumerics, at the very end. */
const EXT_RE = /\.[A-Za-z0-9]{1,5}$/;

/**
 * Drop the save counter, where it carries nothing.
 *
 * THE EXTENSION IS DELIBERATELY KEPT. Dropping it is tempting — the card
 * already shows a thumbnail, so `.png` looks redundant — and it costs nothing
 * in tail budget either, because the token boundaries dominate the split. But
 * a thumbnail says "image" or "video", never WHICH container, and in this
 * workspace the container is load-bearing: the pip OpenCV build ComfyUI imports
 * cannot decode AV1, so a `.webm` and an `.mp4` of the same clip behave
 * differently in a graph (see .claude/rules/bundled-lib-not-system-lib.md).
 * `.png` vs `.webp` matters for the same reason one tier down. The information
 * is cheap to keep and expensive to be missing.
 *
 * THE COUNTER IS ONLY DROPPED FROM A NAME THAT CARRIES THE CONVENTION'S
 * `hhmmss_` PREFIX, and that condition is load-bearing rather than decorative.
 * Under the convention the leading time is the per-file discriminator, so
 * `…_klein-snofs-i2i-pid4k_00001_.png` loses nothing by shedding `_00001_`. But
 * the reference install also holds names like `flux_kontext_00078_.png` and
 * `krea2_identity_edit_00040_.png`, written before the convention or by a node
 * that ignores it — and there the counter is the ONLY thing that differs
 * between siblings. Stripping it unconditionally would render two distinct
 * files with a byte-identical label, which is a worse version of the bug this
 * module exists to fix. When in doubt the counter stays.
 *
 * Never strips to empty.
 */
export function stripCounter(name: string): string {
  const ext = EXT_RE.exec(name);
  const suffix = ext ? ext[0] : "";
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  if (!stem || !TIME_PREFIX_RE.test(stem)) return name;
  const trimmed = stem.replace(COUNTER_RE, "");
  return trimmed ? trimmed + suffix : name;
}

/**
 * Cut `name` so the last `minTail`..`maxTail` characters are held back from the
 * ellipsis, preferring a token boundary.
 *
 * The tail is chosen as the LONGEST run that still fits `maxTail` and begins at
 * a `_`, `-` or `/`, so it reads as whole tokens (`-snofs-i2i-pid4k`) rather than a
 * character count that happens to land mid-word (`2i-pid4k`). With no boundary
 * in range it falls back to exactly `minTail` characters, because a slightly
 * ugly tail still identifies the file and no tail at all does not.
 *
 * A name at or under `maxTail` is returned whole as the tail, with an empty
 * head — there is nothing to elide, and splitting it would put an ellipsis in
 * front of a name that already fits.
 *
 * `maxTail` deliberately sits near half the ~19 characters the narrowest card
 * can show, so the head keeps enough width to render the leading `hhmmss`. It
 * is a preference, not a layout constant: the CSS never reads it, so it cannot
 * drift out of sync with a rule the way a computed width budget would.
 */
export function splitTail(name: string, minTail = 8, maxTail = 14): SplitName {
  if (name.length <= maxTail) return { head: "", tail: name };
  const from = name.length - maxTail;
  for (let i = from; i <= name.length - minTail; i++) {
    const ch = name[i];
    // `/` is here for the subpath row, which is shaped by the same helper — a
    // path's tokens are its segments.
    if (ch === "_" || ch === "-" || ch === "/")
      return { head: name.slice(0, i), tail: name.slice(i) };
  }
  const cut = name.length - minTail;
  return { head: name.slice(0, cut), tail: name.slice(cut) };
}

/**
 * The full treatment for one card label.
 *
 * `verbatim` renders the name unshaped in a single span, and is passed when a
 * fuzzy query is active. That is not a rendering convenience — a user who typed
 * `00078` or `png` must be able to see the characters they matched on, and a
 * label that has quietly dropped them looks like a false positive from the
 * search.
 */
export function labelParts(name: string, verbatim: boolean): SplitName {
  if (verbatim) return { head: "", tail: name };
  return splitTail(stripCounter(name));
}
