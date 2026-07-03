// src/index.ts
import { app } from "/scripts/app.js";

// src/api.ts
var EXT_NAME = "comfyui-image-browser";
var BASE_URL = "/image_browser/base";
var LIST_URL = "/image_browser/list";
var THUMB_URL = "/image_browser/thumb";
var FILE_URL = "/image_browser/file";
var DELETE_URL = "/image_browser/delete";
var DELETE_MANY_URL = "/image_browser/delete_many";
var RENAME_URL = "/image_browser/rename";
var MOVE_URL = "/image_browser/move";
var MOVE_MANY_URL = "/image_browser/move_many";
var RATING_URL = "/image_browser/rating";
var IMG_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif"
]);
var VIDEO_EXTS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpg",
  ".mpeg"
]);
var SANDBOXED_TYPES = ["input", "output", "temp"];
var BASE_PATHS = null;
async function fetchBasePaths() {
  if (BASE_PATHS)
    return BASE_PATHS;
  let resolved;
  try {
    const r = await fetch(BASE_URL, { cache: "no-cache" });
    if (!r.ok)
      throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok)
      throw new Error(data.error || "base paths fetch failed");
    resolved = data;
  } catch (e) {
    console.warn(`[${EXT_NAME}] ${BASE_URL} failed`, e);
    resolved = { base_path: "/", input_dir: "", output_dir: "", temp_dir: "" };
  }
  BASE_PATHS = resolved;
  return resolved;
}
async function fetchListing(p) {
  const params = new URLSearchParams;
  if (p.type === "path") {
    params.set("type", "path");
    params.set("path", p.path || "/");
  } else {
    params.set("type", p.type);
    params.set("subfolder", p.subfolder || "");
  }
  const r = await fetch(`${LIST_URL}?${params.toString()}`, { cache: "no-cache" });
  if (!r.ok)
    throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (!data.ok)
    throw new Error(data.error || "listing failed");
  return data;
}
function joinAbs(dir, name) {
  const d = (dir || "/").replace(/\/+$/, "");
  return d === "" ? `/${name}` : `${d}/${name}`;
}
function imageThumbURL(type, subfolder, name, absDir) {
  if (type === "path") {
    return `${THUMB_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({
    filename: name,
    type,
    subfolder: subfolder || "",
    preview: "webp;75"
  });
  return `/api/view?${p.toString()}`;
}
function videoSrcURL(type, subfolder, name, absDir) {
  if (type === "path") {
    return `${FILE_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `/api/view?${p.toString()}`;
}
function fullSrcURL(type, subfolder, name, absDir) {
  if (type === "path") {
    return `${FILE_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `/api/view?${p.toString()}`;
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
}
function deleteFile(type, subfolder, name) {
  return postJSON(DELETE_URL, { type, subfolder, name });
}
function renameFile(type, subfolder, name, newName) {
  return postJSON(RENAME_URL, { type, subfolder, name, new_name: newName });
}
function moveFile(type, subfolder, name, destType, destSubfolder) {
  return postJSON(MOVE_URL, {
    type,
    subfolder,
    name,
    dest_type: destType,
    dest_subfolder: destSubfolder
  });
}
async function postJSONBatch(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(`HTTP ${r.status}`);
  }
  if (!r.ok || !data?.ok) {
    const msg = data?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}
function deleteMany(items) {
  return postJSONBatch(DELETE_MANY_URL, { items });
}
function moveMany(items, destType, destSubfolder) {
  return postJSONBatch(MOVE_MANY_URL, {
    items,
    dest_type: destType,
    dest_subfolder: destSubfolder
  });
}

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = { fieldProviders: [], activeModal: null, pointerClaim: null };
    g[KEY] = kit;
  }
  return kit;
}
var guardInstalled = false;
function setActiveModal(handle) {
  installPointerGuard();
  dismissActiveModal();
  getKit().activeModal = handle;
}
function dismissActiveModal() {
  const kit = getKit();
  const active = kit.activeModal;
  if (!active)
    return;
  kit.activeModal = null;
  try {
    active.close();
  } catch (e) {
    console.warn("[comfy-modal-kit] active modal close() threw", e);
  }
}
function getActiveModal() {
  return getKit().activeModal;
}
function installPointerGuard() {
  if (guardInstalled)
    return;
  if (typeof window === "undefined")
    return;
  guardInstalled = true;
  window.addEventListener("pointerdown", pointerGuard, true);
}
function pointerGuard(e) {
  const active = getKit().activeModal;
  if (!active)
    return;
  const target = e.target;
  if (active.element && target && active.element.contains(target)) {
    return;
  }
  e.stopImmediatePropagation();
  dismissActiveModal();
}
function fuzzyScore(query, target) {
  if (!query)
    return { score: 0, matches: [] };
  if (!target)
    return null;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const matches = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIdx = -1;
  for (let ti = 0;ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      consecutive = 0;
      continue;
    }
    let charScore = 1;
    if (ti === 0) {
      charScore += 5;
    } else {
      const prev = t[ti - 1];
      const orig = target[ti];
      if (prev === "_" || prev === "-" || prev === " " || prev === "." || prev === "/") {
        charScore += 4;
      } else if (prev !== undefined && prev >= "a" && prev <= "z" && orig !== undefined && orig >= "A" && orig <= "Z") {
        charScore += 3;
      }
    }
    if (ti === prevMatchIdx + 1) {
      consecutive++;
      charScore += consecutive * 2;
    } else {
      consecutive = 0;
    }
    score += charScore;
    matches.push(ti);
    prevMatchIdx = ti;
    qi++;
  }
  if (qi < q.length)
    return null;
  score -= target.length * 0.01;
  return { score, matches };
}
var STYLE_ID = "cmn-notify-style";
var CONTAINER_ID = "cmn-notify-container";
function defaultLife(severity) {
  switch (severity) {
    case "error":
      return 0;
    case "warn":
      return 8000;
    default:
      return 4000;
  }
}
function defaultCopyable(severity) {
  return severity === "error" || severity === "warn";
}
function notifyClipboardText(summary, detail) {
  return detail ? `${summary}
${detail}` : summary;
}
async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    if (typeof document === "undefined")
      return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
var CSS = `
.cmn-container {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(380px, calc(100vw - 24px));
    pointer-events: none;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cmn-toast {
    pointer-events: auto;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-left-width: 4px;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 1.4;
    animation: cmn-in 0.16s ease-out;
}
@keyframes cmn-in {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}
.cmn-toast.cmn-success { border-left-color: #4caf50; }
.cmn-toast.cmn-info    { border-left-color: #6ba6ff; }
.cmn-toast.cmn-warn    { border-left-color: #e0a83a; }
.cmn-toast.cmn-error   { border-left-color: #e0533a; }
.cmn-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}
.cmn-text {
    flex: 1;
    min-width: 0;
    word-break: break-word;
}
.cmn-summary { font-weight: 600; }
.cmn-detail  { color: #b8b8c0; margin-top: 2px; white-space: pre-wrap; }
.cmn-close {
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
}
.cmn-close:hover { color: #fff; }
.cmn-actions { display: flex; gap: 8px; }
.cmn-copy {
    background: #2a2a36;
    color: #d8d8e0;
    border: 1px solid #3a3a44;
    border-radius: 5px;
    /* Touch-first: comfortable tap target, 13px text. */
    min-height: 32px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.cmn-copy:hover  { background: #34343f; color: #fff; }
.cmn-copy.cmn-copied { background: #2f4a30; border-color: #4caf50; color: #cfe8d0; }
`;
function ensureStyle() {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(STYLE_ID))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    c.className = "cmn-container";
    document.body.appendChild(c);
  }
  return c;
}
function notify(opts) {
  const { severity, summary, detail } = opts;
  if (typeof document === "undefined" || !document.body) {
    console.info(`[notify] ${severity}: ${summary}${detail ? ` — ${detail}` : ""}`);
    return null;
  }
  ensureStyle();
  const container = ensureContainer();
  const life = opts.life ?? defaultLife(severity);
  const copyable = opts.copyable ?? defaultCopyable(severity);
  const toast = document.createElement("div");
  toast.className = `cmn-toast cmn-${severity}`;
  toast.setAttribute("role", severity === "error" ? "alert" : "status");
  let timer;
  const close = () => {
    if (timer)
      clearTimeout(timer);
    toast.remove();
    if (container.childElementCount === 0)
      container.remove();
  };
  const row = document.createElement("div");
  row.className = "cmn-row";
  const text = document.createElement("div");
  text.className = "cmn-text";
  const summaryEl = document.createElement("div");
  summaryEl.className = "cmn-summary";
  summaryEl.textContent = summary;
  text.appendChild(summaryEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "cmn-detail";
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmn-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", close);
  row.append(text, closeBtn);
  toast.appendChild(row);
  if (copyable) {
    const actions = document.createElement("div");
    actions.className = "cmn-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "cmn-copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyTextToClipboard(notifyClipboardText(summary, detail));
      copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
      copyBtn.classList.toggle("cmn-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("cmn-copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);
    toast.appendChild(actions);
  }
  container.appendChild(toast);
  if (life > 0) {
    timer = setTimeout(close, life);
  }
  return { close, el: toast };
}
var MAX_RATING = 5;
function ratingOf(f) {
  const r = f.rating;
  return typeof r === "number" && r > 0 ? Math.min(MAX_RATING, Math.floor(r)) : 0;
}
function nextRating(cur, val) {
  return val === cur ? 0 : val;
}
function ratingRequestBody(addr, rating) {
  if (addr.type === "path") {
    return { type: "path", path: addr.absDir, name: addr.name, rating };
  }
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, rating };
}
async function postRating(url, addr, rating) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ratingRequestBody(addr, rating))
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.error || "rating failed");
  return typeof data.rating === "number" ? data.rating : rating;
}
function starsHTML(prefix, rating) {
  const r = ratingOf({ rating });
  let buttons = "";
  for (let i = 1;i <= MAX_RATING; i++) {
    const on = i <= r ? " is-on" : "";
    buttons += `<button type="button" class="${prefix}-star${on}" data-val="${i}" tabindex="-1">★</button>`;
  }
  return `<div class="${prefix}-stars" data-rating="${r}" title="Rate (click the active star to clear)">${buttons}</div>`;
}
function applyStars(row, rating) {
  const r = ratingOf({ rating });
  row.dataset.rating = String(r);
  for (const s of row.querySelectorAll("[data-val]")) {
    s.classList.toggle("is-on", Number(s.dataset.val) <= r);
  }
}
var STYLE_ID2 = "cmp-shell-style";
var CSS2 = `
.cmp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 9998;
    backdrop-filter: blur(2px);
    touch-action: manipulation;
}
.cmp-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 9999;
    width: min(960px, calc(100vw - 24px));
    max-height: min(85vh, 800px);
    touch-action: manipulation;
    display: flex;
    flex-direction: column;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    overflow: hidden;
}
.cmp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #21212a;
    flex-shrink: 0;
}
.cmp-title {
    flex: 1;
    font-weight: 600;
    color: #9ec6ff;
    font-size: 14px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-subtitle {
    color: #888;
    font-weight: 400;
    font-size: 12px;
    margin-left: 6px;
}
.cmp-close {
    background: transparent;
    color: #aaa;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    width: 36px;
    height: 36px;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    flex-shrink: 0;
}
.cmp-close:hover {
    background: #2a2a32;
    color: #fff;
}
.cmp-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #1f1f26;
    flex-shrink: 0;
}
.cmp-toolbar:empty {
    display: none;
}
.cmp-searchrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a32;
    flex-shrink: 0;
}
.cmp-search {
    flex: 1;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    color: #e8e8ea;
    padding: 8px 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    font-family: inherit;
    outline: none;
    min-width: 0;
}
.cmp-search:focus {
    border-color: #6ba6ff;
}
.cmp-status {
    color: #888;
    font-size: 12px;
    white-space: nowrap;
}
.cmp-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 8px;
    position: relative;
}
.cmp-body.is-busy {
    opacity: 0.5;
    pointer-events: none;
}
.cmp-footer {
    padding: 8px 14px;
    border-top: 1px solid #2a2a32;
    color: #777;
    font-size: 11px;
    background: #1f1f26;
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
}
.cmp-footer:empty {
    display: none;
}
.cmp-footer kbd {
    background: #2a2a36;
    border: 1px solid #3a3a44;
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: #b8b8c0;
}
`;
function ensureStyle2() {
  if (document.getElementById(STYLE_ID2))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID2;
  s.textContent = CSS2;
  document.head.appendChild(s);
}
function openModalShell(opts = {}) {
  ensureStyle2();
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "cmp-dialog";
  if (opts.width)
    dialog.style.width = opts.width;
  if (opts.height)
    dialog.style.maxHeight = opts.height;
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) {
    dialog.addEventListener(ev, stop);
  }
  const headerEl = document.createElement("div");
  headerEl.className = "cmp-header";
  const titleEl = document.createElement("div");
  titleEl.className = "cmp-title";
  titleEl.textContent = opts.title || "";
  if (opts.subtitle) {
    const sub = document.createElement("span");
    sub.className = "cmp-subtitle";
    sub.textContent = opts.subtitle;
    titleEl.appendChild(sub);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmp-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close (Esc)";
  headerEl.append(titleEl, closeBtn);
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "cmp-toolbar";
  const searchRow = document.createElement("div");
  searchRow.className = "cmp-searchrow";
  const searchEl = document.createElement("input");
  searchEl.type = "search";
  searchEl.className = "cmp-search";
  searchEl.placeholder = opts.placeholder || "Filter…";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  const statusEl = document.createElement("div");
  statusEl.className = "cmp-status";
  searchRow.append(searchEl, statusEl);
  if (opts.showSearch === false)
    searchRow.style.display = "none";
  const bodyEl = document.createElement("div");
  bodyEl.className = "cmp-body";
  const footerEl = document.createElement("div");
  footerEl.className = "cmp-footer";
  if (opts.showFooter !== false) {
    const l = document.createElement("div");
    if (opts.footerLeftHTML)
      l.innerHTML = opts.footerLeftHTML;
    const r = document.createElement("div");
    if (opts.footerRightHTML)
      r.innerHTML = opts.footerRightHTML;
    footerEl.append(l, r);
  } else {
    footerEl.style.display = "none";
  }
  dialog.append(headerEl, toolbarEl, searchRow, bodyEl, footerEl);
  let torn = false;
  const teardown = () => {
    if (torn)
      return;
    torn = true;
    try {
      backdrop.remove();
      dialog.remove();
      document.removeEventListener("keydown", onKey, true);
    } finally {
      try {
        opts.onClose?.();
      } catch (e) {
        console.warn("[modal-shell] onClose threw", e);
      }
    }
  };
  const handle = { id: "modal-shell", element: dialog, close: teardown };
  const requestClose = () => {
    if (getActiveModal() === handle) {
      dismissActiveModal();
    } else {
      teardown();
    }
  };
  backdrop.addEventListener("pointerdown", requestClose);
  closeBtn.addEventListener("click", requestClose);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    try {
      opts.onKeyDown?.(e);
    } catch (err) {
      console.warn("[modal-shell] onKeyDown threw", err);
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop, dialog);
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
    },
    close: requestClose,
    _onKey: onKey,
    opts
  };
  setActiveModal(handle);
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (getActiveModal() === handle)
        searchEl.focus();
    });
  }
  return controller;
}

// src/overlay.ts
function openOverlay(modal, onDismiss) {
  const host = modal.dialog;
  const backdrop = document.createElement("div");
  backdrop.className = "ib-ov-backdrop";
  const card = document.createElement("div");
  card.className = "ib-ov-card";
  backdrop.appendChild(card);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", modal._onKey, true);
    backdrop.remove();
  }
  function dismiss() {
    onDismiss?.();
    close();
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop)
      dismiss();
  });
  document.removeEventListener("keydown", modal._onKey, true);
  document.addEventListener("keydown", onKey, true);
  host.appendChild(backdrop);
  return { card, close };
}
function confirmAction(modal, opts) {
  return new Promise((resolve) => {
    const ov = openOverlay(modal, () => resolve(false));
    const h = document.createElement("div");
    h.className = "ib-ov-title";
    h.textContent = opts.title;
    const p = document.createElement("div");
    p.className = "ib-ov-msg";
    p.textContent = opts.message;
    const row = document.createElement("div");
    row.className = "ib-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ib-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(false);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = opts.danger ? "ib-ov-btn ib-ov-danger" : "ib-ov-btn ib-ov-primary";
    ok.textContent = opts.confirmLabel || "OK";
    ok.addEventListener("click", () => {
      ov.close();
      resolve(true);
    });
    row.append(cancel, ok);
    ov.card.append(h, p, row);
    ok.focus();
  });
}
function promptText(modal, opts) {
  return new Promise((resolve) => {
    const ov = openOverlay(modal, () => resolve(null));
    const h = document.createElement("div");
    h.className = "ib-ov-title";
    h.textContent = opts.title;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ib-ov-input";
    input.value = opts.value || "";
    if (opts.label)
      input.setAttribute("aria-label", opts.label);
    const errEl = document.createElement("div");
    errEl.className = "ib-ov-err";
    const row = document.createElement("div");
    row.className = "ib-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ib-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "ib-ov-btn ib-ov-primary";
    ok.textContent = opts.confirmLabel || "OK";
    function submit() {
      const v = input.value.trim();
      const err = opts.validate?.(v) ?? (v ? null : "Value required");
      if (err) {
        errEl.textContent = err;
        return;
      }
      ov.close();
      resolve(v);
    }
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    row.append(cancel, ok);
    ov.card.append(h, input, errEl, row);
    input.focus();
    input.select();
  });
}
var OVERLAY_CSS = `
.ib-ov-backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    touch-action: manipulation;
}
.ib-ov-card {
    background: #1c1c24;
    border: 1px solid #33333f;
    border-radius: 10px;
    padding: 18px;
    width: min(520px, calc(100% - 24px));
    max-height: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.ib-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.ib-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.ib-ov-input {
    font-size: 16px;
    padding: 10px 12px;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ec;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.ib-ov-input:focus { outline: none; border-color: #6ba6ff; }
.ib-ov-err { font-size: 12px; color: #ff7a7a; min-height: 14px; }
.ib-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ib-ov-btn {
    font-size: 13px;
    padding: 9px 16px;
    border-radius: 6px;
    border: 1px solid #3a3a44;
    background: #2a2a36;
    color: #d8d8dc;
    cursor: pointer;
    font-family: inherit;
    min-height: 38px;
}
.ib-ov-btn:hover { background: #3a3a4a; color: #fff; }
.ib-ov-primary { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.ib-ov-primary:hover { background: #3a4868; color: #fff; }
.ib-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.ib-ov-danger:hover { background: #5c2a3c; color: #fff; }
`;

// src/browser.ts
var STYLE_ID3 = "ib-style";
var SORT_STORAGE_KEY = "comfyui-image-browser:sort";
var VALID_SORTS = new Set([
  "mtime:desc",
  "mtime:asc",
  "name:asc",
  "name:desc",
  "size:desc",
  "pixels:desc",
  "rating:desc",
  "rating:asc"
]);
function loadSavedSort() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !VALID_SORTS.has(raw))
      return null;
    const [key, dir] = raw.split(":");
    return { key, dir };
  } catch {
    return null;
  }
}
function saveSort(key, dir) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
  } catch {}
}
function openImageBrowser() {
  ensureStyle3();
  const state = {
    type: "output",
    subfolder: "",
    absPath: "",
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: ""
  };
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }
  const modal = openModalShell({
    title: "Image Browser",
    placeholder: "Filter by filename…",
    width: "100vw",
    height: "100vh",
    footerLeftHTML: "<kbd>j/k</kbd> navigate · <kbd>?</kbd> help · <kbd>Esc</kbd> close",
    footerRightHTML: '<span class="ib-count"></span>',
    onClose: () => window.removeEventListener("keydown", onWindowKey, true)
  });
  modal.dialog.classList.add("ib-dialog");
  const root = document.createElement("div");
  root.className = "image-browser-body";
  modal.bodyEl.appendChild(root);
  const tabsEl = document.createElement("div");
  tabsEl.className = "ib-tabs";
  for (const t of ["input", "output", "temp", "path"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-tab";
    b.dataset.type = t;
    b.textContent = t === "path" ? "browse…" : t;
    tabsEl.appendChild(b);
  }
  const crumbsEl = document.createElement("div");
  crumbsEl.className = "ib-crumbs";
  const sortEl = document.createElement("select");
  sortEl.className = "ib-control";
  sortEl.title = "Sort";
  sortEl.innerHTML = `
    <option value="mtime:desc">Newest</option>
    <option value="mtime:asc">Oldest</option>
    <option value="name:asc">Name A→Z</option>
    <option value="name:desc">Name Z→A</option>
    <option value="size:desc">Largest file</option>
    <option value="pixels:desc">Highest resolution</option>
    <option value="rating:desc">Highest rating</option>
    <option value="rating:asc">Lowest rating</option>`;
  sortEl.value = `${state.sortKey}:${state.sortDir}`;
  const refreshEl = document.createElement("button");
  refreshEl.type = "button";
  refreshEl.className = "ib-control ib-icon";
  refreshEl.title = "Refresh";
  refreshEl.textContent = "⟳";
  modal.toolbarEl.append(tabsEl, crumbsEl, sortEl, refreshEl);
  const gridEl = document.createElement("div");
  gridEl.className = "ib-grid";
  root.appendChild(gridEl);
  const countEl = modal.footerEl.querySelector(".ib-count");
  function setCount(visible, total) {
    if (countEl)
      countEl.textContent = `${visible} / ${total}`;
  }
  const selected = new Map;
  let focusIndex = -1;
  let visualMode = false;
  let visualAnchor = 0;
  let pendingOp = null;
  let pendingTimer = null;
  let yanked = null;
  let renderedFiles = [];
  const selectedBadge = document.createElement("span");
  selectedBadge.className = "ib-selected-badge";
  selectedBadge.style.display = "none";
  modal.headerEl.appendChild(selectedBadge);
  function navigateUp() {
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/")
        return;
      const i = p.lastIndexOf("/");
      state.absPath = i <= 0 ? "/" : p.slice(0, i);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      const i = p.lastIndexOf("/");
      state.subfolder = i <= 0 ? "" : p.slice(0, i);
    }
    loadAndRender();
  }
  function navigateInto(name) {
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }
  async function switchType(type) {
    state.type = type;
    state.subfolder = "";
    if (type === "path") {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    loadAndRender();
  }
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    renderGrid();
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k;
    state.sortDir = d;
    saveSort(k, d);
    renderGrid();
  });
  refreshEl.addEventListener("click", () => loadAndRender());
  tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b)
      return;
    const t = b.dataset.type;
    if (state.type === t)
      return;
    switchType(t);
  });
  crumbsEl.addEventListener("click", (e) => {
    const c = e.target.closest("[data-sub], [data-abs]");
    if (!c)
      return;
    if (c.dataset.abs !== undefined)
      state.absPath = c.dataset.abs || "/";
    else
      state.subfolder = c.dataset.sub || "";
    loadAndRender();
  });
  gridEl.addEventListener("click", (e) => {
    const target = e.target;
    const actionBtn = target.closest("[data-action]");
    const card = target.closest(".ib-card");
    if (!card)
      return;
    if (card.classList.contains("is-up")) {
      navigateUp();
      return;
    }
    if (card.classList.contains("is-dir")) {
      navigateInto(card.dataset.name);
      return;
    }
    const name = card.dataset.name;
    const ext = card.dataset.ext || "";
    const star = target.closest(".ib-star");
    if (star) {
      e.stopPropagation();
      const row = star.closest(".ib-stars");
      if (!row || !SANDBOXED_TYPES.includes(state.type))
        return;
      const cur = Number(row.dataset.rating || "0");
      setStarRating(name, row, nextRating(cur, Number(star.dataset.val)));
      return;
    }
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === "open")
        openFull(name, ext);
      else if (action === "delete")
        onDelete(name);
      else if (action === "rename")
        onRename(name);
      else if (action === "move")
        onMove(name);
      return;
    }
    openFull(name, ext);
  });
  function setStarRating(name, row, next) {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    const f = state.files.find((x) => x.name === name);
    if (f)
      f.rating = next;
    const addr = {
      type: state.type,
      subfolder: state.subfolder,
      absDir: state.absPath,
      name
    };
    postRating(RATING_URL, addr, next).then((confirmed) => {
      if (confirmed !== next) {
        applyStars(row, confirmed);
        if (f)
          f.rating = confirmed;
      }
    }).catch((e) => {
      reportError("Rating failed", e);
      applyStars(row, prev);
      if (f)
        f.rating = prev;
    });
  }
  function openFull(name, _ext) {
    const url = fullSrcURL(state.type, state.subfolder, name, state.absPath);
    window.open(url, "_blank", "noopener");
  }
  async function onDelete(name) {
    const ok = await confirmAction(modal, {
      title: "Delete file?",
      message: `Permanently delete "${name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    try {
      await deleteFile(state.type, state.subfolder, name);
      state.files = state.files.filter((f) => f.name !== name);
      renderGrid();
    } catch (e) {
      reportError("Delete failed", e);
    }
  }
  async function onRename(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    const newName = await promptText(modal, {
      title: "Rename file",
      label: "New filename",
      value: name,
      confirmLabel: "Rename",
      validate: (v) => {
        if (!v)
          return "Filename required";
        if (v.includes("/") || v.includes("\\"))
          return "No slashes allowed";
        if (v === "." || v === "..")
          return "Invalid name";
        if (ext && !v.toLowerCase().endsWith(ext.toLowerCase()))
          return `Keep the ${ext} extension`;
        return null;
      }
    });
    if (!newName || newName === name)
      return;
    try {
      await renameFile(state.type, state.subfolder, name, newName);
      const f = state.files.find((x) => x.name === name);
      if (f)
        f.name = newName;
      renderGrid();
    } catch (e) {
      reportError("Rename failed", e);
    }
  }
  async function onMove(name) {
    const dest = await pickDestination(modal, {
      type: state.type,
      subfolder: state.subfolder
    });
    if (!dest)
      return;
    try {
      await moveFile(state.type, state.subfolder, name, dest.type, dest.subfolder);
      state.files = state.files.filter((f) => f.name !== name);
      renderGrid();
      notify({
        severity: "success",
        summary: "Moved",
        detail: `"${name}" → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
      });
    } catch (e) {
      reportError("Move failed", e);
    }
  }
  function renderTabs() {
    for (const b of tabsEl.querySelectorAll(".ib-tab")) {
      b.classList.toggle("is-active", b.dataset.type === state.type);
    }
  }
  function renderCrumbs() {
    crumbsEl.innerHTML = "";
    const mk = (text, attr, value) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ib-crumb";
      b.setAttribute(attr, value);
      b.textContent = text;
      return b;
    };
    if (state.type === "path") {
      crumbsEl.appendChild(mk("/", "data-abs", "/"));
      let acc = "";
      for (const p of state.absPath.split("/").filter(Boolean)) {
        acc = `${acc}/${p}`;
        crumbsEl.appendChild(mk(p, "data-abs", acc));
      }
    } else {
      crumbsEl.appendChild(mk(state.type, "data-sub", ""));
      let acc = "";
      for (const p of state.subfolder.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${p}` : p;
        crumbsEl.appendChild(mk(p, "data-sub", acc));
      }
    }
  }
  async function loadAndRender() {
    focusIndex = 0;
    visualMode = false;
    modal.dialog.classList.remove("is-visual");
    clearPending();
    renderTabs();
    renderCrumbs();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    try {
      const data = await fetchListing({
        type: state.type,
        subfolder: state.subfolder,
        path: state.absPath
      });
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      modal.setStatus(data.exists ? "" : "Directory not found.");
    } catch (e) {
      console.error(`[${EXT_NAME}] list failed:`, e);
      modal.setStatus(`Error: ${e.message}`);
      state.dirs = [];
      state.files = [];
    }
    modal.setBusy(false);
    renderGrid();
  }
  function thumbForFile(f) {
    const ext = (f.ext || "").toLowerCase();
    if (IMG_EXTS.has(ext)) {
      return {
        kind: "img",
        src: imageThumbURL(state.type, state.subfolder, f.name, state.absPath)
      };
    }
    if (VIDEO_EXTS.has(ext)) {
      return {
        kind: "video",
        src: videoSrcURL(state.type, state.subfolder, f.name, state.absPath)
      };
    }
    return { kind: "icon", text: "\uD83D\uDCC4" };
  }
  function renderGrid() {
    const q = state.query;
    gridEl.innerHTML = "";
    const canWrite = SANDBOXED_TYPES.includes(state.type);
    const showUp = state.type === "path" ? state.absPath && state.absPath !== "/" : !!state.subfolder;
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ib-card is-up";
      up.innerHTML = `<div class="ib-thumb ib-thumb-icon">↑</div><div class="ib-name">..</div>`;
      gridEl.appendChild(up);
    }
    for (const d of state.dirs) {
      if (q && !d.name.toLowerCase().includes(q))
        continue;
      const c = document.createElement("div");
      c.className = "ib-card is-dir";
      c.dataset.name = d.name;
      c.innerHTML = `<div class="ib-thumb ib-thumb-icon">\uD83D\uDCC1</div><div class="ib-name" title="${escHTML(d.name)}">${escHTML(d.name)}</div>`;
      gridEl.appendChild(c);
    }
    let files = state.files;
    if (q) {
      const scored = [];
      for (const f of files) {
        const r = fuzzyScore(q, f.name);
        if (r)
          scored.push({ f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else {
      files = sortFiles(files, state.sortKey, state.sortDir);
    }
    renderedFiles = files;
    if (files.length === 0)
      focusIndex = -1;
    else if (focusIndex < 0)
      focusIndex = 0;
    else if (focusIndex >= files.length)
      focusIndex = files.length - 1;
    let visible = 0;
    for (let fi = 0;fi < files.length; fi++) {
      const f = files[fi];
      if (!f)
        continue;
      const c = document.createElement("div");
      c.className = "ib-card is-file";
      if (fi === focusIndex)
        c.classList.add("is-focused");
      if (isSelected(f))
        c.classList.add("is-selected");
      c.dataset.name = f.name;
      c.dataset.ext = (f.ext || "").toLowerCase();
      const t = thumbForFile(f);
      const dims = f.width && f.height ? `${f.width}×${f.height}` : "";
      const when = new Date(f.mtime * 1000).toLocaleString();
      const titleText = dims ? `${f.name}
${dims}
${when}` : `${f.name}
${when}`;
      const thumbInner = t.kind === "img" ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">` : t.kind === "video" ? `<video muted playsinline preload="none" data-src="${t.src}"></video>` : `<div class="ib-thumb-icon">${t.text}</div>`;
      const moveBtn = canWrite ? `<button type="button" class="ib-act" data-action="move" title="Move">⇄</button>` : "";
      const writeBtns = canWrite ? `<button type="button" class="ib-act" data-action="rename" title="Rename">✎</button>
           ${moveBtn}
           <button type="button" class="ib-act ib-act-danger" data-action="delete" title="Delete">\uD83D\uDDD1</button>` : "";
      const starsRow = canWrite ? starsHTML("ib", ratingOf(f)) : ratingOf(f) ? `<div class="ib-stars is-ro" data-rating="${ratingOf(f)}">${"★".repeat(ratingOf(f))}</div>` : "";
      c.innerHTML = `
        <div class="ib-thumb">${thumbInner}</div>
        <div class="ib-name" title="${escHTML(titleText)}">${escHTML(f.name)}</div>
        ${dims ? `<div class="ib-meta">${dims}</div>` : ""}
        ${starsRow}
        <div class="ib-actions">
          <button type="button" class="ib-act" data-action="open" title="Open full size">↗</button>
          ${writeBtns}
        </div>`;
      gridEl.appendChild(c);
      visible++;
    }
    if (!visible && !state.dirs.length && !showUp) {
      const el = document.createElement("div");
      el.className = "ib-empty";
      el.textContent = "No matching files in this folder.";
      gridEl.appendChild(el);
    }
    setCount(visible, state.files.length);
    installLazyThumbs(gridEl);
    const focusedCard = gridEl.querySelector(".ib-card.is-focused");
    focusedCard?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function installLazyThumbs(rootEl) {
    if (typeof IntersectionObserver === "undefined")
      return;
    const els = rootEl.querySelectorAll("img[data-src], video[data-src]");
    if (!els.length)
      return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting)
          continue;
        const el = e.target;
        const src = el.dataset.src;
        if (src) {
          if (el.tagName === "VIDEO")
            el.preload = "metadata";
          el.src = src;
          el.removeAttribute("data-src");
        }
        io.unobserve(el);
      }
    }, { root: rootEl, rootMargin: "300px" });
    for (const el of els)
      io.observe(el);
  }
  function reportError(summary, e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[${EXT_NAME}] ${summary}:`, e);
    notify({ severity: "error", summary, detail });
  }
  function isInInput() {
    const el = document.activeElement;
    if (!el)
      return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }
  function selectionKey(type, subfolder, name) {
    return `${type}:${subfolder}:${name}`;
  }
  function isSelected(f) {
    if (state.type === "path")
      return false;
    return selected.has(selectionKey(state.type, state.subfolder, f.name));
  }
  function fileCards() {
    return Array.from(gridEl.querySelectorAll(".ib-card.is-file"));
  }
  function gridColumns() {
    const cards = fileCards();
    if (cards.length < 2)
      return 1;
    const top = cards[0]?.offsetTop ?? 0;
    let n = 0;
    for (const c of cards) {
      if (c.offsetTop !== top)
        break;
      n++;
    }
    return Math.max(1, n);
  }
  function applyFocus() {
    for (const [i, c] of fileCards().entries()) {
      c.classList.toggle("is-focused", i === focusIndex);
    }
    const focused = gridEl.querySelector(".ib-card.is-focused");
    focused?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function refreshSelectionClasses() {
    for (const [i, c] of fileCards().entries()) {
      const f = renderedFiles[i];
      c.classList.toggle("is-selected", !!f && isSelected(f));
    }
  }
  function moveFocus(delta) {
    const n = renderedFiles.length;
    if (n === 0)
      return;
    focusIndex = Math.max(0, Math.min(n - 1, focusIndex + delta));
    if (visualMode)
      extendSelectionTo(focusIndex);
    applyFocus();
  }
  function focusFirst() {
    const n = renderedFiles.length;
    if (n === 0)
      return;
    focusIndex = 0;
    if (visualMode)
      extendSelectionTo(focusIndex);
    applyFocus();
  }
  function focusLast() {
    const n = renderedFiles.length;
    if (n === 0)
      return;
    focusIndex = n - 1;
    if (visualMode)
      extendSelectionTo(focusIndex);
    applyFocus();
  }
  function updateSelectedCount() {
    const n = selected.size;
    selectedBadge.style.display = n > 0 ? "inline" : "none";
    selectedBadge.textContent = n > 0 ? `${n} selected` : "";
  }
  function toggleSelectionAt(i) {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const f = renderedFiles[i];
    if (!f)
      return;
    const key = selectionKey(state.type, state.subfolder, f.name);
    if (selected.has(key))
      selected.delete(key);
    else
      selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function extendSelectionTo(i) {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const lo = Math.min(visualAnchor, i);
    const hi = Math.max(visualAnchor, i);
    for (let k = lo;k <= hi; k++) {
      const f = renderedFiles[k];
      if (!f)
        continue;
      const key = selectionKey(state.type, state.subfolder, f.name);
      if (!selected.has(key))
        selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function selectAllVisible() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    for (const f of renderedFiles) {
      const key = selectionKey(state.type, state.subfolder, f.name);
      if (!selected.has(key))
        selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function clearSelection() {
    selected.clear();
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function toggleVisualMode() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    if (renderedFiles.length === 0)
      return;
    visualMode = !visualMode;
    if (visualMode) {
      if (focusIndex < 0)
        focusIndex = 0;
      visualAnchor = focusIndex;
      extendSelectionTo(focusIndex);
    }
    modal.dialog.classList.toggle("is-visual", visualMode);
  }
  function collectSelectedOrFocused() {
    if (selected.size > 0) {
      return Array.from(selected.values()).map((v) => ({
        type: v.type,
        subfolder: v.subfolder,
        name: v.file.name
      }));
    }
    const f = renderedFiles[focusIndex];
    if (!f || state.type === "path")
      return [];
    return [{ type: state.type, subfolder: state.subfolder, name: f.name }];
  }
  function setPending(op) {
    clearPending();
    pendingOp = op;
    pendingTimer = setTimeout(clearPending, 1500);
    const hint = op === "d" ? "d… (d/y=delete, n=cancel)" : op === "y" ? "y… (y=yank)" : "g… (g=top)";
    modal.setStatus(hint);
  }
  function clearPending() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingOp = null;
    modal.setStatus("");
  }
  async function doDelete() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const items = collectSelectedOrFocused();
    if (items.length === 0)
      return;
    const count = items.length;
    const ok = await confirmAction(modal, {
      title: count === 1 ? "Delete file?" : `Delete ${count} files?`,
      message: count === 1 ? `Permanently delete "${items[0]?.name}"? This cannot be undone.` : `Permanently delete ${count} selected files? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    try {
      const result = await deleteMany(items);
      const errored = new Set((result.errors ?? []).map((e) => e.name));
      const removedHere = new Set(items.filter((it) => it.type === state.type && it.subfolder === state.subfolder && !errored.has(it.name)).map((it) => it.name));
      state.files = state.files.filter((f) => !removedHere.has(f.name));
      for (const it of items) {
        if (!errored.has(it.name))
          selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      updateSelectedCount();
      renderGrid();
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((e) => e.name).join(", ");
        reportError(`Deleted ${result.deleted}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify({ severity: "success", summary: "Deleted", detail: `${result.deleted} file(s)` });
      }
    } catch (e) {
      reportError("Delete failed", e);
    }
  }
  function doYank() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const items = collectSelectedOrFocused();
    if (items.length === 0)
      return;
    yanked = items;
    notify({
      severity: "info",
      summary: "Yanked",
      detail: `${items.length} file(s) — press p to move here`
    });
  }
  async function doPaste() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    if (!yanked || yanked.length === 0) {
      notify({ severity: "info", summary: "Nothing to paste", detail: "Yank files first with yy" });
      return;
    }
    try {
      const result = await moveMany(yanked, state.type, state.subfolder);
      for (const it of yanked) {
        const errored = result.errors?.some((e) => e.name === it.name);
        if (!errored)
          selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      yanked = null;
      updateSelectedCount();
      await loadAndRender();
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((e) => e.name).join(", ");
        reportError(`Moved ${result.moved}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify({ severity: "success", summary: "Moved", detail: `${result.moved} file(s)` });
      }
    } catch (e) {
      reportError("Paste (move) failed", e);
    }
  }
  async function siblingNav(dir) {
    let parentType;
    let parentSub;
    let parentPath;
    let currentName;
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/")
        return;
      const i = p.lastIndexOf("/");
      parentPath = i <= 0 ? "/" : p.slice(0, i);
      parentType = "path";
      parentSub = "";
      currentName = p.slice(i + 1);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      if (!p)
        return;
      const i = p.lastIndexOf("/");
      parentSub = i <= 0 ? "" : p.slice(0, i);
      parentType = state.type;
      parentPath = "";
      currentName = p.slice(i + 1);
    }
    try {
      const data = await fetchListing({
        type: parentType,
        subfolder: parentSub,
        path: parentPath
      });
      const dirs = (data.dirs || []).map((d) => d.name).sort();
      const idx = dirs.indexOf(currentName);
      if (idx < 0)
        return;
      const next = idx + dir;
      if (next < 0 || next >= dirs.length)
        return;
      const target = dirs[next];
      if (!target)
        return;
      if (state.type === "path") {
        state.absPath = parentPath === "/" ? `/${target}` : `${parentPath}/${target}`;
      } else {
        state.subfolder = parentSub ? `${parentSub}/${target}` : target;
      }
      focusIndex = 0;
      await loadAndRender();
    } catch (e) {
      reportError("Sibling navigation failed", e);
    }
  }
  function showHelp() {
    const ov = openOverlay(modal, () => {});
    ov.card.classList.add("ib-help-card");
    ov.card.innerHTML = `
      <div class="ib-ov-title">Keyboard shortcuts</div>
      <div class="ib-help-body">
        <div class="ib-help-col">
          <div class="ib-help-h">Navigate</div>
          <dl>
            <dt>j / k</dt><dd>down / up row</dd>
            <dt>h / l</dt><dd>left / right</dd>
            <dt>g g</dt><dd>first file</dd>
            <dt>G</dt><dd>last file</dd>
            <dt>K</dt><dd>parent dir</dd>
            <dt>H / L</dt><dd>prev / next sibling</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Select</div>
          <dl>
            <dt>Space</dt><dd>toggle focused</dd>
            <dt>v</dt><dd>visual mode</dd>
            <dt>Ctrl+A</dt><dd>select all visible</dd>
            <dt>Esc</dt><dd>clear selection</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Act</div>
          <dl>
            <dt>d d</dt><dd>delete selected</dd>
            <dt>d y</dt><dd>confirm delete</dd>
            <dt>y y</dt><dd>yank (cut) selected</dd>
            <dt>p</dt><dd>paste (move) here</dd>
            <dt>r</dt><dd>rename focused</dd>
            <dt>m</dt><dd>move focused…</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Other</div>
          <dl>
            <dt>Enter / o</dt><dd>open preview</dd>
            <dt>/</dt><dd>focus search</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>Esc</dt><dd>close (priority)</dd>
          </dl>
        </div>
      </div>
      <div class="ib-ov-actions">
        <button type="button" class="ib-ov-btn ib-ov-primary" data-help-close>Close</button>
      </div>`;
    const closeBtn = ov.card.querySelector("[data-help-close]");
    closeBtn?.addEventListener("click", () => ov.close());
  }
  function onWindowKey(e) {
    if (modal.dialog.querySelector(".ib-ov-backdrop"))
      return;
    const inInput = isInInput();
    if (e.key === "Escape") {
      if (inInput) {
        document.activeElement?.blur();
      } else if (pendingOp) {
        clearPending();
      } else if (visualMode) {
        visualMode = false;
        modal.dialog.classList.remove("is-visual");
      } else if (selected.size > 0) {
        clearSelection();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (inInput)
      return;
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      e.stopPropagation();
      selectAllVisible();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey)
      return;
    if (pendingOp) {
      const op = pendingOp;
      clearPending();
      if (op === "d" && (e.key === "d" || e.key === "y" || e.key === "Enter")) {
        e.preventDefault();
        e.stopPropagation();
        doDelete();
        return;
      }
      if (op === "d" && (e.key === "n" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (op === "y" && e.key === "y") {
        e.preventDefault();
        e.stopPropagation();
        doYank();
        return;
      }
      if (op === "g" && e.key === "g") {
        e.preventDefault();
        e.stopPropagation();
        focusFirst();
        return;
      }
    }
    const f = renderedFiles[focusIndex];
    switch (e.key) {
      case "j":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(gridColumns());
        break;
      case "k":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-gridColumns());
        break;
      case "h":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-1);
        break;
      case "l":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(1);
        break;
      case "G":
        e.preventDefault();
        e.stopPropagation();
        focusLast();
        break;
      case "K":
        e.preventDefault();
        e.stopPropagation();
        navigateUp();
        break;
      case "H":
        e.preventDefault();
        e.stopPropagation();
        siblingNav(-1);
        break;
      case "L":
        e.preventDefault();
        e.stopPropagation();
        siblingNav(1);
        break;
      case "g":
        e.preventDefault();
        e.stopPropagation();
        setPending("g");
        break;
      case "d":
        e.preventDefault();
        e.stopPropagation();
        setPending("d");
        break;
      case "y":
        e.preventDefault();
        e.stopPropagation();
        setPending("y");
        break;
      case "p":
        e.preventDefault();
        e.stopPropagation();
        doPaste();
        break;
      case " ":
        e.preventDefault();
        e.stopPropagation();
        toggleSelectionAt(focusIndex);
        break;
      case "v":
        e.preventDefault();
        e.stopPropagation();
        toggleVisualMode();
        break;
      case "Enter":
      case "o":
        e.preventDefault();
        e.stopPropagation();
        if (f)
          openFull(f.name, f.ext || "");
        break;
      case "r":
        if (SANDBOXED_TYPES.includes(state.type) && f) {
          e.preventDefault();
          e.stopPropagation();
          onRename(f.name);
        }
        break;
      case "m":
        if (SANDBOXED_TYPES.includes(state.type) && f) {
          e.preventDefault();
          e.stopPropagation();
          onMove(f.name);
        }
        break;
      case "/":
        e.preventDefault();
        e.stopPropagation();
        modal.searchEl.focus();
        break;
      case "?":
        e.preventDefault();
        e.stopPropagation();
        showHelp();
        break;
      default:
        break;
    }
  }
  window.addEventListener("keydown", onWindowKey, true);
  loadAndRender();
  return modal;
}
function pickDestination(modal, start) {
  return new Promise((resolve) => {
    const ov = openOverlay(modal, () => resolve(null));
    ov.card.classList.add("ib-move-card");
    const cur = {
      type: SANDBOXED_TYPES.includes(start.type) ? start.type : "output",
      subfolder: start.subfolder
    };
    const title = document.createElement("div");
    title.className = "ib-ov-title";
    title.textContent = "Move to…";
    const tabs = document.createElement("div");
    tabs.className = "ib-tabs";
    for (const t of SANDBOXED_TYPES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ib-tab";
      b.dataset.type = t;
      b.textContent = t;
      tabs.appendChild(b);
    }
    const crumbs = document.createElement("div");
    crumbs.className = "ib-crumbs";
    const list = document.createElement("div");
    list.className = "ib-move-list";
    const status = document.createElement("div");
    status.className = "ib-ov-msg";
    const row = document.createElement("div");
    row.className = "ib-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ib-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const moveHere = document.createElement("button");
    moveHere.type = "button";
    moveHere.className = "ib-ov-btn ib-ov-primary";
    moveHere.addEventListener("click", () => {
      ov.close();
      resolve({ type: cur.type, subfolder: cur.subfolder });
    });
    row.append(cancel, moveHere);
    ov.card.append(title, tabs, crumbs, list, status, row);
    function renderCrumbs() {
      crumbs.innerHTML = "";
      const mk = (text, sub) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ib-crumb";
        b.dataset.sub = sub;
        b.textContent = text;
        return b;
      };
      crumbs.appendChild(mk(cur.type, ""));
      let acc = "";
      for (const p of cur.subfolder.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${p}` : p;
        crumbs.appendChild(mk(p, acc));
      }
    }
    async function load() {
      for (const b of tabs.querySelectorAll(".ib-tab"))
        b.classList.toggle("is-active", b.dataset.type === cur.type);
      renderCrumbs();
      moveHere.textContent = `Move to ${cur.type}${cur.subfolder ? `/${cur.subfolder}` : ""}`;
      list.innerHTML = "";
      status.textContent = "Loading…";
      try {
        const data = await fetchListing({ type: cur.type, subfolder: cur.subfolder });
        status.textContent = "";
        if (cur.subfolder) {
          const up = document.createElement("button");
          up.type = "button";
          up.className = "ib-move-row is-up";
          up.textContent = "↑ ..";
          list.appendChild(up);
        }
        if (!data.dirs.length && !cur.subfolder) {
          const none = document.createElement("div");
          none.className = "ib-ov-msg";
          none.textContent = "No subfolders — move into the root above.";
          list.appendChild(none);
        }
        for (const d of data.dirs) {
          const r = document.createElement("button");
          r.type = "button";
          r.className = "ib-move-row";
          r.dataset.name = d.name;
          r.textContent = `\uD83D\uDCC1 ${d.name}`;
          list.appendChild(r);
        }
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    }
    tabs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b)
        return;
      cur.type = b.dataset.type;
      cur.subfolder = "";
      load();
    });
    crumbs.addEventListener("click", (e) => {
      const c = e.target.closest("[data-sub]");
      if (!c)
        return;
      cur.subfolder = c.dataset.sub || "";
      load();
    });
    list.addEventListener("click", (e) => {
      const up = e.target.closest(".is-up");
      if (up) {
        const p = cur.subfolder.replace(/\/+$/, "");
        const i = p.lastIndexOf("/");
        cur.subfolder = i <= 0 ? "" : p.slice(0, i);
        load();
        return;
      }
      const r = e.target.closest("[data-name]");
      if (!r)
        return;
      const base = cur.subfolder.replace(/\/+$/, "");
      cur.subfolder = base ? `${base}/${r.dataset.name}` : r.dataset.name;
      load();
    });
    load();
  });
}
function sortFiles(files, key, dir) {
  const mul = dir === "asc" ? 1 : -1;
  const nameCmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const numCmp = (getter) => (a, b) => (getter(a) ?? 0) - (getter(b) ?? 0) || nameCmp(a, b);
  let cmp;
  switch (key) {
    case "name":
      cmp = nameCmp;
      break;
    case "size":
      cmp = numCmp((f) => f.size);
      break;
    case "pixels":
      cmp = numCmp((f) => f.width && f.height ? f.width * f.height : 0);
      break;
    case "rating":
      cmp = numCmp((f) => f.rating);
      break;
    default:
      cmp = numCmp((f) => f.mtime);
      break;
  }
  return [...files].sort((a, b) => mul * cmp(a, b));
}
function escHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
var BROWSER_CSS = `
.ib-dialog { width: 100vw !important; height: 100vh !important; max-height: 100vh !important; border-radius: 0; }
.image-browser-body { display: block; }
.ib-tabs {
    display: flex; gap: 2px; align-items: center;
    background: #1a1a22; border: 1px solid #2a2a32; border-radius: 4px; padding: 2px;
}
.ib-tab {
    background: transparent; color: #8a8a92; border: 0; border-radius: 3px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
    text-transform: capitalize; min-height: 32px;
}
.ib-tab:hover { background: #2a2a36; color: #e0e0e4; }
.ib-tab.is-active { background: #2f3a52; color: #9ec6ff; }
.ib-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; flex: 1; min-width: 0; }
.ib-crumb {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #3a3a44; border-radius: 4px;
    padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-crumb:hover { background: #3a3a4a; color: #fff; }
.ib-control {
    background: #2a2a36; color: #d8d8dc; border: 1px solid #3a3a44; border-radius: 4px;
    padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-control:hover { background: #3a3a4a; color: #fff; }
.ib-icon { min-width: 34px; text-align: center; }
.ib-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px; padding: 4px;
}
.ib-card {
    background: #21212a; border: 1px solid #2a2a32; border-radius: 6px; overflow: hidden;
    cursor: pointer; display: flex; flex-direction: column;
    transition: transform 0.06s ease, border-color 0.1s ease;
}
.ib-card:hover { border-color: #6ba6ff; transform: translateY(-1px); }
.ib-card.is-up, .ib-card.is-dir { background: #1f1f26; }
.ib-thumb {
    aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center;
    background: #12121a; overflow: hidden;
}
.ib-thumb-icon { font-size: 32px; color: #777; }
.ib-thumb img, .ib-thumb video {
    width: 100%; height: 100%; object-fit: cover; display: block; background: #000;
}
.ib-name {
    padding: 6px 8px; font-size: 11.5px; color: #d8d8dc; white-space: nowrap;
    text-overflow: ellipsis; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.ib-meta { padding: 0 8px 4px; font-size: 10.5px; color: #888; }
.ib-stars { display: flex; justify-content: center; gap: 1px; padding: 0 6px 4px; }
.ib-star {
    appearance: none; background: transparent; border: 0; padding: 5px 4px;
    font-size: 15px; line-height: 1; color: #555; cursor: pointer;
    min-width: 26px; min-height: 26px;
}
.ib-star.is-on, .ib-star:hover { color: #ffd866; }
@media (max-width: 600px) {
    .ib-star { font-size: 18px; padding: 7px 5px; min-width: 30px; min-height: 32px; }
}
.ib-stars.is-ro { color: #ffd866; font-size: 12px; cursor: default; }
.ib-actions { display: flex; gap: 2px; padding: 0 6px 6px; margin-top: auto; }
.ib-act {
    flex: 1; background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 6px 0; font-size: 13px; line-height: 1; cursor: pointer; font-family: inherit;
    min-height: 34px;
}
.ib-act:hover { background: #3a3a4a; color: #fff; }
.ib-act-danger:hover { background: #5c2a3c; color: #ff9eb0; }
.ib-empty { grid-column: 1 / -1; padding: 48px; text-align: center; color: #777; font-style: italic; }
.ib-count { color: #888; }
.ib-move-card { width: min(560px, calc(100% - 24px)); }
.ib-move-list {
    display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto;
    border: 1px solid #2a2a32; border-radius: 6px; padding: 4px; background: #17171e;
}
.ib-move-row {
    text-align: left; background: transparent; color: #cfcfd6; border: 0; border-radius: 4px;
    padding: 10px 12px; font-size: 13px; cursor: pointer; font-family: inherit; min-height: 40px;
}
.ib-move-row:hover { background: #2a2a3a; color: #fff; }
.cmp-match { color: #ffd866; font-weight: 700; }
.ib-card.is-focused { outline: 2px solid #6ba6ff; outline-offset: -2px; z-index: 1; }
.ib-card.is-selected { border-color: #ffd866; background: #2a2a1f; }
.ib-card.is-selected.is-focused { outline-color: #ffd866; }
.ib-dialog.is-visual .ib-grid { outline: 2px solid #ffd866; outline-offset: -2px; }
.ib-selected-badge {
    background: #2f3a52; color: #9ec6ff; border: 1px solid #4a5878; border-radius: 10px;
    padding: 2px 8px; font-size: 11px; margin-left: 8px; display: inline;
}
.ib-help-card { width: min(640px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ib-help-body {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; overflow-y: auto; padding: 8px 0;
}
.ib-help-col { display: flex; flex-direction: column; gap: 4px; }
.ib-help-h { font-size: 12px; font-weight: 600; color: #9ec6ff; text-transform: uppercase; letter-spacing: 0.5px; }
.ib-help-body dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.ib-help-body dt {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; color: #ffd866;
}
.ib-help-body dd { margin: 0 0 4px 0; font-size: 11.5px; color: #b8b8c0; }
`;
function ensureStyle3() {
  if (document.getElementById(STYLE_ID3))
    return;
  const s = document.createElement("style");
  s.id = STYLE_ID3;
  s.textContent = BROWSER_CSS + OVERLAY_CSS;
  document.head.appendChild(s);
}

// src/index.ts
var OPEN_COMMAND_ID = "image-browser.open";
function openShell() {
  return openImageBrowser();
}
function openShellSafe() {
  try {
    openImageBrowser();
  } catch (e) {
    console.warn(`[${EXT_NAME}] open failed`, e);
  }
}
app.registerExtension({
  name: "comfy.image-browser",
  actionBarButtons: [
    {
      icon: "icon-[lucide--images]",
      label: "Image Browser",
      tooltip: "Browse & manage input/output images",
      onClick: openShellSafe
    }
  ],
  commands: [
    {
      id: OPEN_COMMAND_ID,
      label: "Open Image Browser",
      function: openShellSafe
    }
  ],
  menuCommands: [
    {
      path: ["Extensions", "Image Browser"],
      commands: [OPEN_COMMAND_ID]
    }
  ]
});
export {
  openShell
};
