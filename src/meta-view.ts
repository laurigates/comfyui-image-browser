// meta-view.ts — one renderer for embedded generation metadata.
//
// Two surfaces show the same /metadata answer: the ⓘ overlay card in the grid
// and the lightbox's info panel. Both used to need the same source line, the
// same never-invent-a-row rule, the same raw disclosure and the same copy
// feedback, so the markup and the copy wiring live here once. A second copy is
// where "no bare Negative: row" or the latching-label fix would quietly regress.

import {
  copyTextToClipboard,
  escapeHTML as escHTML,
  type MetaRow,
  metaClipboardText,
  metaRows,
} from "@laurigates/comfy-modal-kit";
import type { ImageMetadata } from "./api.js";

/** Placeholder painted synchronously while a read is in flight. */
export const META_LOADING_HTML = `<div class="ib-meta-status">Reading metadata…</div>`;

interface RenderedMeta {
  /** Body markup: source line, rows (or the honest empty line), note, raw. */
  html: string;
  /** "Copy all" markup, or "" when there is nothing to copy. */
  copyAllHTML: string;
  rows: MetaRow[];
  rawJSON: string;
}

export function renderMeta(data: ImageMetadata): RenderedMeta {
  const rows = metaRows(data.summary);
  const rawKeys = Object.keys(data.raw);
  const srcLabel =
    data.source === "comfyui"
      ? "ComfyUI"
      : data.source === "a1111"
        ? "A1111"
        : "no generation data";
  const rowsHTML = rows
    .map(
      (r, i) => `
        <div class="ib-meta-row">
          <div class="ib-meta-k">${escHTML(r.label)}</div>
          <div class="ib-meta-v">${escHTML(r.value)}</div>
          <button type="button" class="ib-meta-copy" data-copy-row="${i}">Copy</button>
        </div>`,
    )
    .join("");
  // Never invent a row. With nothing recognised the honest report is which of
  // the two cases it is: no embedded text at all, or text we couldn't map (in
  // which case the raw disclosure below is the whole answer).
  const emptyHTML = rows.length
    ? ""
    : `<div class="ib-meta-empty">${
        rawKeys.length ? "No recognised generation parameters." : "No generation metadata found."
      }</div>`;
  const rawJSON = JSON.stringify(data.raw, null, 2);
  const rawHTML = rawKeys.length
    ? `
        <details class="ib-meta-raw">
          <summary>Raw metadata (${rawKeys.length} key${rawKeys.length === 1 ? "" : "s"})</summary>
          <pre>${escHTML(rawJSON)}</pre>
          <button type="button" class="ib-meta-copy" data-copy-raw>Copy JSON</button>
        </details>`
    : "";
  const noteHTML = data.truncated
    ? `<div class="ib-meta-note">Some values were truncated by the server.</div>`
    : "";
  const html = `
        <div class="ib-meta-src">${escHTML(srcLabel)}${
          data.format ? `<span class="ib-meta-fmt">${escHTML(data.format)}</span>` : ""
        }</div>
        ${emptyHTML}
        ${rowsHTML}
        ${noteHTML}
        ${rawHTML}`;
  const copyAllHTML = rows.length
    ? `<button type="button" class="cmp-ov-btn cmp-ov-primary" data-copy-all>Copy all</button>`
    : "";
  return { html, copyAllHTML, rows, rawJSON };
}

/**
 * Bind every copy control under `root` to what `meta` rendered.
 *
 * Each restore label is read ONCE here, off the freshly painted markup — never
 * inside the click handler, where a mid-feedback label would stick.
 */
export function wireMetaCopy(root: HTMLElement, meta: RenderedMeta): void {
  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-copy-row]")) {
    const row = meta.rows[Number(btn.dataset.copyRow)];
    const label = btn.textContent || "Copy";
    if (row) btn.addEventListener("click", () => copyInto(btn, row.value, label));
  }
  const rawBtn = root.querySelector<HTMLButtonElement>("[data-copy-raw]");
  const rawLabel = rawBtn?.textContent || "Copy JSON";
  rawBtn?.addEventListener("click", () => copyInto(rawBtn, meta.rawJSON, rawLabel));
  const allBtn = root.querySelector<HTMLButtonElement>("[data-copy-all]");
  const allLabel = allBtn?.textContent || "Copy all";
  allBtn?.addEventListener("click", () => copyInto(allBtn, metaClipboardText(meta.rows), allLabel));
}

// Copy feedback lives on the button itself: label → "Copied ✓" → back.
// DELIBERATELY no notify() toast on success — the toast stack is a child of
// <body> above the dialog, so on the installed kit a toast raised over an open
// overlay parks its ✕ on top of the shell's, and tapping it dismisses the whole
// browser. The label flip is also the clearer confirmation: it names which
// field went to the clipboard. copyTextToClipboard (not navigator.clipboard
// directly) carries the non-secure-context fallback plain-http LAN ComfyUI needs.
//
// `restore` is PASSED IN, never read back off the button: reading
// btn.textContent at click time captures the TRANSIENT label whenever a second
// click lands inside the 1500 ms window, so the feedback latches permanently —
// and in the fail-then-succeed order the button settles on "Copy failed" after
// a copy that worked, i.e. it lies about whether the value is on the clipboard.
// One feedback slot per button (copyFeedback): a new click supersedes the
// previous click's pending restore AND its late-resolving promise (the `seq`
// check), so the label always shows the LAST copy's outcome and then `restore`.
const copyFeedback = new WeakMap<
  HTMLButtonElement,
  { seq: number; timer: ReturnType<typeof setTimeout> | null }
>();

function copyInto(btn: HTMLButtonElement, text: string, restore: string): void {
  let fb = copyFeedback.get(btn);
  if (!fb) {
    fb = { seq: 0, timer: null };
    copyFeedback.set(btn, fb);
  }
  const slot = fb;
  const seq = ++slot.seq;
  // Hold the current feedback until this copy answers — no flicker back to
  // `restore` mid-flight — but drop the stale restore timer that would fire
  // out of order once this click's own timer is armed.
  if (slot.timer !== null) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  void copyTextToClipboard(text).then((ok) => {
    if (slot.seq !== seq) return; // a later click owns the label now
    btn.textContent = ok ? "Copied ✓" : "Copy failed";
    btn.classList.toggle("is-copied", ok);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      btn.textContent = restore;
      btn.classList.remove("is-copied");
    }, 1500);
  });
}
