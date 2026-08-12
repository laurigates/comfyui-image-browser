/* web/dist bundle built by bun from src/ in this repository (see package.json). Inlines @laurigates/comfy-modal-kit (MIT) - a first-party library by the same publisher, published to npm with provenance attestation: https://www.npmjs.com/package/@laurigates/comfy-modal-kit */

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
function installBackGuard(onBack) {
  if (typeof window === "undefined" || typeof history === "undefined")
    return () => {};
  let armed = false;
  let disposed = false;
  const arm = () => {
    history.pushState({ cmpBackGuard: true }, "");
    armed = true;
  };
  const dispose = (opts) => {
    if (disposed)
      return;
    disposed = true;
    window.removeEventListener("popstate", onPop);
    if (armed) {
      armed = false;
      if (opts?.pop !== false)
        history.back();
    }
  };
  function onPop() {
    armed = false;
    let handled = false;
    try {
      handled = onBack();
    } catch (e) {
      console.error("[comfy-modal-kit] back handler threw", e);
    }
    if (handled && !disposed) {
      arm();
      return;
    }
    dispose();
  }
  arm();
  window.addEventListener("popstate", onPop);
  return dispose;
}
var ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = {
      fieldProviders: [],
      modelPickers: [],
      activeModal: null,
      pointerClaim: null,
      modalChrome: [],
      pointerGuardInstalled: false,
      hubEntries: [],
      hubLauncherInstalled: false,
      hubToggles: [],
      safeViewListeners: []
    };
    g[KEY] = kit;
  }
  if (!kit.fieldProviders)
    kit.fieldProviders = [];
  if (!kit.modelPickers)
    kit.modelPickers = [];
  if (!kit.modalChrome)
    kit.modalChrome = [];
  if (!kit.hubEntries)
    kit.hubEntries = [];
  if (!kit.hubToggles)
    kit.hubToggles = [];
  if (!kit.safeViewListeners)
    kit.safeViewListeners = [];
  return kit;
}
var SORT_OPTIONS = [
  { value: "mtime:desc", label: "Newest" },
  { value: "mtime:asc", label: "Oldest" },
  { value: "name:asc", label: "Name A→Z" },
  { value: "name:desc", label: "Name Z→A" },
  { value: "size:desc", label: "Largest file" },
  { value: "size:asc", label: "Smallest file" },
  { value: "pixels:desc", label: "Largest resolution" },
  { value: "pixels:asc", label: "Smallest resolution" },
  { value: "rating:desc", label: "Highest rating" },
  { value: "rating:asc", label: "Lowest rating" }
];
var VALID_SORTS = new Set(SORT_OPTIONS.map((o) => o.value));
function sortFiles(files, key, dir) {
  const mul = dir === "asc" ? 1 : -1;
  const nameCmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const numCmp = (extract) => (a, b) => (extract(a) ?? 0) - (extract(b) ?? 0) || nameCmp(a, b);
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
function registerHubEntry(entry) {
  const list = getKit().hubEntries;
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0) {
    list.splice(i, 1, entry);
  } else {
    list.push(entry);
  }
}
function getHubEntries() {
  return [...getKit().hubEntries].sort(byPriority);
}
function byPriority(a, b) {
  return (b.priority ?? 0) - (a.priority ?? 0);
}
function registerHubToggle(toggle) {
  const list = getKit().hubToggles;
  const i = list.findIndex((t) => t.id === toggle.id);
  if (i >= 0) {
    list.splice(i, 1, toggle);
  } else {
    list.push(toggle);
  }
}
function getHubToggles() {
  return [...getKit().hubToggles].sort(byPriority);
}
var CHROME_ATTR = "data-cmp-chrome";
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
function isModalActive() {
  return getKit().activeModal !== null;
}
function getActiveModal() {
  return getKit().activeModal;
}
function registerModalChrome(el) {
  const chrome = getKit().modalChrome;
  if (!chrome.includes(el))
    chrome.push(el);
  el.setAttribute?.(CHROME_ATTR, "");
}
function unregisterModalChrome(el) {
  const chrome = getKit().modalChrome;
  for (let i = chrome.length - 1;i >= 0; i--) {
    if (chrome[i] === el)
      chrome.splice(i, 1);
  }
  el.removeAttribute?.(CHROME_ATTR);
}
function isModalChrome(node) {
  if (!node)
    return false;
  for (const el2 of getKit().modalChrome) {
    if (el2.contains?.(node))
      return true;
  }
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!el?.closest?.(`[${CHROME_ATTR}]`);
}
function installPointerGuard() {
  const kit = getKit();
  if (kit.pointerGuardInstalled)
    return;
  if (typeof window === "undefined")
    return;
  kit.pointerGuardInstalled = true;
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
  if (isModalChrome(target)) {
    return;
  }
  e.stopImmediatePropagation();
  dismissActiveModal();
}
function ensureStyleOnce(id, css) {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(id))
    return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
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
var CSS2 = `
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
/*
 * While a modal is up, clear the shell header's close button: .cmp-close is a
 * 36px button inside a .cmp-header padded 12px/14px at the dialog's top-right,
 * which lands under the toast's own × — worst case a full-viewport dialog like
 * comfyui-image-browser's .ib-dialog (100vw/100vh), where the two × controls
 * overlap exactly. Applied per raise, so a toast on the bare canvas keeps 12px.
 */
.cmn-container.cmn-modal-inset { top: 64px; }
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
    /* Touch-first: a 32px target, with the growth absorbed by a negative margin
       so the toast's visual density is unchanged from the old 24px glyph box. */
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: -4px -4px 0 0;
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
function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    c.className = "cmn-container";
    document.body.appendChild(c);
  }
  registerModalChrome(c);
  return c;
}
function notify(opts) {
  const { severity, summary, detail } = opts;
  if (typeof document === "undefined" || !document.body) {
    console.info(`[notify] ${severity}: ${summary}${detail ? ` — ${detail}` : ""}`);
    return null;
  }
  ensureStyleOnce(STYLE_ID, CSS2);
  const container = ensureContainer();
  container.classList.toggle("cmn-modal-inset", isModalActive());
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
    if (container.childElementCount === 0) {
      unregisterModalChrome(container);
      container.remove();
    }
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
var FAMILY_MENU_PATH = ["Extensions", "Touch Tools"];
var KEBAB_COMMAND_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
function makeLauncher(opts) {
  if (!KEBAB_COMMAND_ID.test(opts.id)) {
    console.warn(`[comfy-modal-kit] launcher id "${opts.id}" does not match the family convention "<pack-short-name>.<action>" (kebab-case)`);
  }
  const safeOpen = () => {
    try {
      opts.open();
    } catch (e) {
      console.error(`[comfy-modal-kit] launcher "${opts.id}" open failed`, e);
      try {
        notify({
          severity: "error",
          summary: opts.failSummary ?? `Could not open ${opts.label}`,
          detail: String(e)
        });
      } catch (notifyErr) {
        console.warn(`[comfy-modal-kit] notify failed`, notifyErr);
      }
    }
  };
  const fields = {
    commands: [{ id: opts.id, label: opts.label, icon: opts.icon, function: safeOpen }],
    menuCommands: [{ path: [...opts.menuPath ?? FAMILY_MENU_PATH], commands: [opts.id] }]
  };
  if (opts.actionBar !== false) {
    const bar = typeof opts.actionBar === "object" ? opts.actionBar : {};
    fields.actionBarButtons = [
      {
        icon: opts.icon,
        ...bar.label !== undefined ? { label: bar.label } : {},
        tooltip: bar.tooltip ?? opts.tooltip ?? opts.label,
        onClick: safeOpen
      }
    ];
  }
  return fields;
}
var STYLE_ID2 = "cmp-shell-style";
var CSS22 = `
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
    /* 44px, not 36: docs/modal-ux-drift-catalog.md:71 sets the family's D02
       target at >=44px, and the Touch Tools chooser cannot credibly promise
       >=44px rows while inheriting a 36px close control. */
    width: 44px;
    height: 44px;
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
function openModalShell(opts = {}) {
  ensureStyleOnce(STYLE_ID2, CSS22);
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
      bodyEl.removeEventListener("scroll", onBodyScroll);
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
  let liveScrollTop = 0;
  const onBodyScroll = () => {
    liveScrollTop = bodyEl.scrollTop;
  };
  bodyEl.addEventListener("scroll", onBodyScroll, { passive: true });
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    scrollHost: bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
    },
    getScrollTop() {
      if (bodyEl.isConnected)
        liveScrollTop = bodyEl.scrollTop;
      return liveScrollTop;
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
var HUB_LABEL = "Touch Tools";
var HUB_ICON = "pi pi-mobile";
var HUB_STYLE_ID = "cmk-hub-style";
var SETTINGS_COMMAND = "Comfy.ShowSettingsDialog";
var HUB_CSS = `
.cmk-hub-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px;
}
.cmk-hub-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    /* >=44px is the family's D02 touch-target floor; 48 for comfort. */
    min-height: 48px;
    padding: 8px 12px;
    background: #21212a;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    touch-action: manipulation;
}
.cmk-hub-row:hover {
    background: #2a2a36;
    border-color: #4a4a58;
}
.cmk-hub-icon {
    font-size: 18px;
    color: #9ec6ff;
    flex-shrink: 0;
    width: 20px;
    text-align: center;
}
.cmk-hub-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.cmk-hub-label {
    font-weight: 600;
    font-size: 14px;
}
.cmk-hub-desc {
    color: #9a9aa4;
    font-size: 12px;
}
.cmk-hub-sep {
    height: 1px;
    background: #2a2a32;
    margin: 8px 4px;
}
.cmk-hub-state {
    margin-left: auto;
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 999px;
    background: #2a2a32;
    color: #9a9aa4;
}
.cmk-hub-row[aria-checked="true"] .cmk-hub-state {
    background: #24406b;
    color: #9ec6ff;
}
.cmk-hub-empty {
    color: #9a9aa4;
    font-size: 13px;
    padding: 10px 12px;
}
.cmk-hub-note {
    color: #777;
    font-size: 11px;
    line-height: 1.4;
    padding: 10px 12px 4px;
}
`;
function makeHubEntry(opts) {
  const fields = makeLauncher({ ...opts, actionBar: false });
  const hubEntry = {
    id: opts.id,
    label: opts.label,
    icon: opts.icon,
    description: opts.description,
    priority: opts.priority,
    open: fields.commands[0]?.function ?? opts.open
  };
  return { ...fields, hubEntry };
}
function installHubButton() {
  const kit = getKit();
  if (kit.hubLauncherInstalled)
    return {};
  kit.hubLauncherInstalled = true;
  return {
    actionBarButtons: [
      {
        icon: HUB_ICON,
        label: HUB_LABEL,
        tooltip: "Touch Tools — open a touch-first tool",
        class: "!h-11 !min-w-11",
        onClick: () => {
          const entries = getHubEntries();
          if (entries.length === 1) {
            try {
              entries[0]?.open();
            } catch (e) {
              console.error("[comfy-modal-kit] hub single-entry open failed", e);
            }
            return;
          }
          openTouchToolsHub();
        }
      }
    ]
  };
}
function executeCommand(id) {
  const host = globalThis;
  const command = host.app?.extensionManager?.command;
  if (!command)
    throw new Error(`command manager unavailable (cannot run "${id}")`);
  command.execute(id);
}
function makeRow(icon, label, description) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "cmk-hub-row";
  const iconEl = document.createElement("i");
  iconEl.className = `cmk-hub-icon ${icon}`;
  const text = document.createElement("span");
  text.className = "cmk-hub-text";
  const labelEl = document.createElement("span");
  labelEl.className = "cmk-hub-label";
  labelEl.textContent = label;
  text.append(labelEl);
  if (description) {
    const descEl = document.createElement("span");
    descEl.className = "cmk-hub-desc";
    descEl.textContent = description;
    text.append(descEl);
  }
  row.append(iconEl, text);
  return row;
}
function openTouchToolsHub() {
  ensureStyleOnce(HUB_STYLE_ID, HUB_CSS);
  let disposeBack = () => {};
  const controller = openModalShell({
    title: HUB_LABEL,
    showSearch: false,
    showFooter: false,
    width: "min(420px, calc(100vw - 24px))",
    onClose: () => {
      disposeBack();
    }
  });
  disposeBack = installBackGuard(() => {
    controller.close();
    return false;
  });
  function runRow(action) {
    disposeBack({ pop: false });
    controller.close();
    setTimeout(() => {
      try {
        action();
      } catch (e) {
        console.error("[comfy-modal-kit] hub row action failed", e);
        try {
          notify({ severity: "error", summary: "Could not open that tool", detail: String(e) });
        } catch (n) {
          console.warn("[comfy-modal-kit] notify failed", n);
        }
      }
    }, 0);
  }
  const list = document.createElement("div");
  list.className = "cmk-hub-list";
  const entries = getHubEntries();
  for (const entry of entries) {
    const row = makeRow(entry.icon, entry.label, entry.description);
    row.addEventListener("click", () => runRow(entry.open));
    list.append(row);
  }
  for (const toggle of getHubToggles()) {
    const row = makeRow(toggle.icon, toggle.label, toggle.description);
    row.setAttribute("role", "switch");
    const state = document.createElement("span");
    state.className = "cmk-hub-state";
    row.append(state);
    const paint = () => {
      let on = false;
      try {
        on = toggle.get();
      } catch (e) {
        console.error(`[comfy-modal-kit] hub toggle "${toggle.id}" get failed`, e);
      }
      row.setAttribute("aria-checked", on ? "true" : "false");
      state.textContent = on ? "On" : "Off";
    };
    paint();
    row.addEventListener("click", () => {
      try {
        toggle.set(!toggle.get());
      } catch (e) {
        console.error(`[comfy-modal-kit] hub toggle "${toggle.id}" set failed`, e);
        try {
          notify({
            severity: "error",
            summary: `Could not change ${toggle.label}`,
            detail: String(e)
          });
        } catch (n) {
          console.warn("[comfy-modal-kit] notify failed", n);
        }
      }
      paint();
    });
    list.append(row);
  }
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cmk-hub-empty";
    empty.textContent = "No Touch Tools packs registered on this page yet.";
    list.append(empty);
  }
  const sep = document.createElement("div");
  sep.className = "cmk-hub-sep";
  list.append(sep);
  const settingsRow = makeRow("pi pi-cog", "Settings", "All Touch Tools options, in ComfyUI settings");
  settingsRow.addEventListener("click", () => runRow(() => executeCommand(SETTINGS_COMMAND)));
  list.append(settingsRow);
  const note = document.createElement("div");
  note.className = "cmk-hub-note";
  note.textContent = "Other Touch Tools packs work directly on the canvas and its widgets — their options are in Settings.";
  list.append(note);
  controller.bodyEl.append(list);
  return controller;
}
var DEFAULT_SELECTOR = "img[data-src], video[data-src]";
function installLazyMedia(container, opts) {
  const noop = () => {};
  if (typeof IntersectionObserver === "undefined")
    return noop;
  const els = container.querySelectorAll(opts.selector ?? DEFAULT_SELECTOR);
  if (!els.length)
    return noop;
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
  }, { root: opts.root, rootMargin: opts.rootMargin ?? "300px" });
  for (const el of els)
    io.observe(el);
  return () => io.disconnect();
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
var SAFE_VIEW_SETTINGS = {
  enabled: "TouchTools.SafeView.Enabled",
  keywords: "TouchTools.SafeView.Keywords",
  hide: "TouchTools.SafeView.Hide",
  blurNames: "TouchTools.SafeView.BlurNames",
  matchPrompt: "TouchTools.SafeView.MatchPrompt"
};
var SAFE_VIEW_DEFAULT_KEYWORDS = "nsfw";
var SAFE_VIEW_GLYPH_ON = "\uD83D\uDE48";
var SAFE_VIEW_GLYPH_OFF = "\uD83D\uDC41";
function safeViewSettings() {
  const fire = () => notifySafeViewChange();
  return [
    {
      id: SAFE_VIEW_SETTINGS.enabled,
      category: ["Touch Tools", "Safe View", "Enabled"],
      sortOrder: 100,
      name: "Safe View",
      tooltip: "Blur thumbnails and block out names for files and folders matching your keywords, in the Image Browser, the image picker and ComfyUI's own asset sidebar and lightbox. This is discretion, not security: the blur is CSS and the file is still downloaded, so it defeats someone glancing over your shoulder, not someone with your keyboard.",
      type: "boolean",
      defaultValue: true,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.keywords,
      category: ["Touch Tools", "Safe View", "Keywords"],
      sortOrder: 90,
      name: "Keywords",
      tooltip: "Comma- or space-separated. Matched as WHOLE WORDS against the file name, every folder above it, and the file's XMP keyword tags — so 'nsfw' matches output/nsfw/pic.png and my_nsfw_pic.png, while 'ass' does not match assets/ or classic.png. Case-insensitive. Empty means nothing is filtered.",
      type: "text",
      defaultValue: SAFE_VIEW_DEFAULT_KEYWORDS,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.hide,
      category: ["Touch Tools", "Safe View", "Hide"],
      sortOrder: 80,
      name: "Remove matches from the listing entirely",
      tooltip: "Off (default): matches stay in the grid, blurred, with a reveal button. On: matches are dropped server-side, so they never reach the browser and the listing count changes. Hiding is filtered above the newest-N cap, so a folder of mostly-sensitive files still returns a full page of the rest.",
      type: "boolean",
      defaultValue: false,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.blurNames,
      category: ["Touch Tools", "Safe View", "Names"],
      sortOrder: 70,
      name: "Block out names too",
      tooltip: "Replaces the file name, its folder label and its tooltip with a solid block. Off leaves names readable under a blurred thumbnail — which usually defeats the point, since the folder name is often what matched.",
      type: "boolean",
      defaultValue: true,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.matchPrompt,
      category: ["Touch Tools", "Safe View", "Prompt"],
      sortOrder: 60,
      name: "Also match the generation prompt and model",
      tooltip: "Off by default because it is expensive: every file's embedded metadata must be parsed and cached before its verdict is known, and a file with no verdict yet is blurred until the background scan reaches it. On a large library that means a mostly-blurred grid on first enable, clearing as the scan progresses.",
      type: "boolean",
      defaultValue: false,
      onChange: fire
    }
  ];
}
function safeViewSettingHost() {
  const host = globalThis;
  return host.app?.extensionManager?.setting ?? null;
}
var SAFE_VIEW_DEFAULTS = Object.freeze({
  enabled: true,
  keywords: Object.freeze([SAFE_VIEW_DEFAULT_KEYWORDS]),
  hide: false,
  blurNames: true,
  matchPrompt: false
});
function parseKeywords(raw) {
  if (typeof raw !== "string")
    return [];
  const out = [];
  const seen = new Set;
  for (const piece of raw.split(/[\s,]+/)) {
    const kw = piece.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!kw || seen.has(kw))
      continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}
function readSafeViewConfig(host = safeViewSettingHost()) {
  if (!host)
    return SAFE_VIEW_DEFAULTS;
  const bool = (id, fallback) => {
    const v = host.get(id);
    return typeof v === "boolean" ? v : fallback;
  };
  const rawKeywords = host.get(SAFE_VIEW_SETTINGS.keywords);
  return {
    enabled: bool(SAFE_VIEW_SETTINGS.enabled, SAFE_VIEW_DEFAULTS.enabled),
    keywords: rawKeywords === undefined ? SAFE_VIEW_DEFAULTS.keywords : parseKeywords(rawKeywords),
    hide: bool(SAFE_VIEW_SETTINGS.hide, SAFE_VIEW_DEFAULTS.hide),
    blurNames: bool(SAFE_VIEW_SETTINGS.blurNames, SAFE_VIEW_DEFAULTS.blurNames),
    matchPrompt: bool(SAFE_VIEW_SETTINGS.matchPrompt, SAFE_VIEW_DEFAULTS.matchPrompt)
  };
}
function isSafeViewActive(cfg = readSafeViewConfig()) {
  return cfg.enabled && cfg.keywords.length > 0;
}
function tokenize(input) {
  if (typeof input !== "string" || input === "")
    return [];
  return input.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}
function isSensitive(target, cfg) {
  if (!cfg.enabled || cfg.keywords.length === 0)
    return false;
  const haystack = new Set;
  for (const t of tokenize(target.name))
    haystack.add(t);
  for (const t of tokenize(target.path))
    haystack.add(t);
  for (const tag of target.tags ?? []) {
    for (const t of tokenize(tag))
      haystack.add(t);
  }
  for (const kw of cfg.keywords) {
    if (haystack.has(kw))
      return true;
  }
  if (cfg.matchPrompt) {
    if (target.promptMatch === true)
      return true;
    if (target.promptMatch === "unscanned")
      return true;
  }
  return false;
}
function makeRevealSet() {
  const set = new Set;
  const key = (type, subfolder, name) => `${type}:${subfolder}:${name}`;
  return {
    key,
    has: (t, s, n) => set.has(key(t, s, n)),
    reveal: (t, s, n) => {
      set.add(key(t, s, n));
    },
    clear: () => set.clear(),
    get size() {
      return set.size;
    }
  };
}
var SAFE_VIEW_STYLE_ID = "cmk-safe-view-style";
var SAFE_VIEW_BLUR_CLASS = "cmk-sv-blur";
var SAFE_VIEW_SPOILER_CLASS = "cmk-sv-spoiler";
var SPOILER_TITLE_ATTR = "data-cmk-sv-title";
var SAFE_VIEW_CSS = `
.${SAFE_VIEW_BLUR_CLASS} {
    /* Scale past the edges: a blurred element otherwise fades toward its own
       border and leaks a readable silhouette of the content at the rim. */
    filter: blur(18px);
    transform: scale(1.08);
}
.${SAFE_VIEW_SPOILER_CLASS} {
    /* A SOLID BLOCK, never a text blur — blurred text stays readable at small
       sizes, which is exactly the size a phone grid renders names at. */
    background: #3a3a44;
    color: transparent;
    border-radius: 3px;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
}
.cmk-sv-reveal {
    position: absolute;
    top: 4px;
    left: 4px;
    z-index: 2;
    /* >=34px is the family's per-card control floor. */
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    line-height: 1;
    background: rgba(20, 20, 26, 0.82);
    color: #e8e8ea;
    border: 1px solid #4a4a58;
    border-radius: 8px;
    cursor: pointer;
    touch-action: manipulation;
}
.cmk-sv-reveal:hover {
    background: rgba(40, 40, 52, 0.92);
}
`;
function ensureSafeViewStyle() {
  ensureStyleOnce(SAFE_VIEW_STYLE_ID, SAFE_VIEW_CSS);
}
function setBlurred(el, blurred) {
  ensureSafeViewStyle();
  el.classList.toggle(SAFE_VIEW_BLUR_CLASS, blurred);
}
function setSpoilered(el, spoilered) {
  ensureSafeViewStyle();
  el.classList.toggle(SAFE_VIEW_SPOILER_CLASS, spoilered);
  if (spoilered) {
    const title = el.getAttribute("title");
    if (title !== null) {
      el.setAttribute(SPOILER_TITLE_ATTR, title);
      el.removeAttribute("title");
    }
  } else {
    const parked = el.getAttribute(SPOILER_TITLE_ATTR);
    if (parked !== null) {
      el.setAttribute("title", parked);
      el.removeAttribute(SPOILER_TITLE_ATTR);
    }
  }
}
function makeRevealButton(opts) {
  ensureSafeViewStyle();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cmk-sv-reveal";
  btn.textContent = SAFE_VIEW_GLYPH_OFF;
  btn.title = "Reveal";
  btn.setAttribute("aria-label", opts.label ?? "Reveal hidden item");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    opts.onReveal();
  });
  return btn;
}
function onSafeViewChange(listener) {
  const list = getKit().safeViewListeners;
  list.push(listener);
  return () => {
    const i = list.indexOf(listener);
    if (i >= 0)
      list.splice(i, 1);
  };
}
function notifySafeViewChange() {
  for (const listener of [...getKit().safeViewListeners]) {
    try {
      listener();
    } catch (e) {
      console.error("[comfy-modal-kit] safe-view listener failed", e);
    }
  }
}
function toggleSafeView(host = safeViewSettingHost()) {
  if (!host)
    return;
  const cfg = readSafeViewConfig(host);
  if (cfg.keywords.length === 0) {
    notify({
      severity: "warn",
      summary: "Safe View has no keywords",
      detail: "Add keywords in Settings → Touch Tools → Safe View → Keywords."
    });
    return;
  }
  host.set(SAFE_VIEW_SETTINGS.enabled, !cfg.enabled);
}
function registerSafeViewHubToggle() {
  registerHubToggle({
    id: "safe-view.toggle",
    label: "Safe View",
    icon: "pi pi-eye-slash",
    description: "Blur sensitive thumbnails and names",
    priority: 100,
    get: () => isSafeViewActive(),
    set: () => toggleSafeView()
  });
}
var STYLE_ID3 = "cmp-overlay-style";
var CSS3 = `
.cmp-ov-backdrop {
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
.cmp-ov-card {
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
.cmp-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.cmp-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.cmp-ov-input {
    font-size: 16px;
    padding: 10px 12px;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ec;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.cmp-ov-input:focus { outline: none; border-color: #6ba6ff; }
.cmp-ov-err { font-size: 12px; color: #ff7a7a; min-height: 14px; }
.cmp-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cmp-ov-btn {
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
.cmp-ov-btn:hover { background: #3a3a4a; color: #fff; }
.cmp-ov-primary { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.cmp-ov-primary:hover { background: #3a4868; color: #fff; }
.cmp-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.cmp-ov-danger:hover { background: #5c2a3c; color: #fff; }
`;
function openShellOverlay(shell, opts = {}) {
  ensureStyleOnce(STYLE_ID3, CSS3);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-ov-backdrop";
  const card = document.createElement("div");
  card.className = "cmp-ov-card";
  backdrop.appendChild(card);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  let closed = false;
  function close() {
    if (closed)
      return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", shell._onKey, true);
    backdrop.remove();
  }
  function dismiss() {
    opts.onDismiss?.();
    close();
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop)
      dismiss();
  });
  document.removeEventListener("keydown", shell._onKey, true);
  document.addEventListener("keydown", onKey, true);
  shell.dialog.appendChild(backdrop);
  return { card, close };
}
function confirmInShell(shell, opts) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(shell, { onDismiss: () => resolve(false) });
    const h = document.createElement("div");
    h.className = "cmp-ov-title";
    h.textContent = opts.title;
    const p = document.createElement("div");
    p.className = "cmp-ov-msg";
    p.textContent = opts.message;
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = opts.cancelLabel || "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(false);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = opts.danger ? "cmp-ov-btn cmp-ov-danger" : "cmp-ov-btn cmp-ov-primary";
    ok.textContent = opts.confirmLabel || "OK";
    const confirm = () => {
      ov.close();
      resolve(true);
    };
    ok.addEventListener("click", confirm);
    if (opts.enterConfirms) {
      ov.card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          confirm();
        }
      });
    }
    row.append(cancel, ok);
    ov.card.append(h, p, row);
    ok.focus();
  });
}
function promptInShell(shell, opts) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(shell, { onDismiss: () => resolve(null) });
    const h = document.createElement("div");
    h.className = "cmp-ov-title";
    h.textContent = opts.title;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cmp-ov-input";
    input.value = opts.value || "";
    if (opts.label)
      input.setAttribute("aria-label", opts.label);
    const errEl = document.createElement("div");
    errEl.className = "cmp-ov-err";
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "cmp-ov-btn cmp-ov-primary";
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

// src/index.ts
import { app as app3 } from "/scripts/app.js";

// src/browser.ts
import { app } from "/scripts/app.js";

// src/api.ts
var EXT_NAME = "comfyui-image-browser";
var BASE_URL = "/image_browser/base";
var LIST_URL = "/image_browser/list";
var THUMB_URL = "/image_browser/thumb";
var FILE_URL = "/image_browser/file";
var METADATA_URL = "/image_browser/metadata";
var DELETE_URL = "/image_browser/delete";
var DELETE_MANY_URL = "/image_browser/delete_many";
var RENAME_URL = "/image_browser/rename";
var MOVE_URL = "/image_browser/move";
var MOVE_DIR_URL = "/image_browser/move_dir";
var MOVE_MANY_URL = "/image_browser/move_many";
var RMDIR_URL = "/image_browser/rmdir";
var MKDIR_URL = "/image_browser/mkdir";
var PINS_URL = "/image_browser/pins";
var RATING_URL = "/image_browser/rating";
var SAFEVIEW_WARM_URL = "/image_browser/safeview_warm";
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
var META_VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);
var META_EXTS = new Set([...IMG_EXTS, ...META_VIDEO_EXTS]);
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
    if (p.recursive)
      params.set("recursive", "1");
  }
  if (p.kind && p.kind !== "all")
    params.set("kind", p.kind);
  if (p.safeHide && p.safeKeywords && p.safeKeywords.length > 0) {
    params.set("safe_kw", p.safeKeywords.join(","));
    params.set("safe_hide", "1");
  }
  if (p.safePrompt && p.safeKeywords && p.safeKeywords.length > 0) {
    params.set("safe_kw", p.safeKeywords.join(","));
    params.set("safe_prompt", "1");
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
function thumbVersion(mtime, size) {
  return `${mtime}-${size ?? 0}`;
}
function imageThumbURL(type, subfolder, name, absDir, v) {
  if (type === "path") {
    return `${THUMB_URL}?path=${encodeURIComponent(joinAbs(absDir, name))}&v=${encodeURIComponent(v)}`;
  }
  const p = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name,
    v
  });
  return `${THUMB_URL}?${p.toString()}`;
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
async function fetchMetadata(type, subfolder, name, absDir) {
  const params = type === "path" ? new URLSearchParams({ path: joinAbs(absDir, name) }) : new URLSearchParams({ type, subfolder: subfolder || "", name });
  const r = await fetch(`${METADATA_URL}?${params.toString()}`, { cache: "no-cache" });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return {
    ok: true,
    format: data.format || "",
    source: data.source || "none",
    summary: data.summary || {},
    raw: data.raw || {},
    truncated: data.truncated === true
  };
}
var WORKFLOW_RAW_KEYS = ["workflow", "prompt"];
function embeddedWorkflowJSON(meta) {
  const raw = meta?.raw;
  if (!raw)
    return null;
  for (const k of WORKFLOW_RAW_KEYS) {
    const v = raw[k];
    if (typeof v !== "string")
      continue;
    const t = v.trim();
    if (t !== "" && t !== "null" && t !== "{}" && t !== "[]")
      return v;
  }
  return null;
}
var META_FIELDS = [
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "model", label: "Model" },
  { key: "seed", label: "Seed" },
  { key: "steps", label: "Steps" },
  { key: "cfg", label: "CFG" },
  { key: "sampler", label: "Sampler" },
  { key: "scheduler", label: "Scheduler" }
];
function metaRows(summary) {
  const rows = [];
  if (!summary || typeof summary !== "object")
    return rows;
  const bag = summary;
  for (const { key, label } of META_FIELDS) {
    const v = bag[key];
    if (v === undefined || v === null)
      continue;
    const value = String(v);
    if (!value.trim())
      continue;
    rows.push({ key, label, value });
  }
  return rows;
}
function metaClipboardText(rows) {
  return rows.map((r) => `${r.label}: ${r.value}`).join(`
`);
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
function moveDir(type, subfolder, name, destType, destSubfolder) {
  return postJSONBatch(MOVE_DIR_URL, {
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
function warmSafeView(items) {
  return postJSONBatch(SAFEVIEW_WARM_URL, { items });
}
async function removeDir(type, subfolder, name, recursive = false) {
  const r = await fetch(RMDIR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, subfolder, name, recursive })
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (r.ok && data.ok) {
    return { status: "deleted", files: data.files ?? 0, dirs: data.dirs ?? 0 };
  }
  if (r.status === 409 && typeof data.files === "number") {
    return { status: "not_empty", files: data.files, dirs: data.dirs ?? 0 };
  }
  throw new Error(data.error || `HTTP ${r.status}`);
}
function moveMany(items, destType, destSubfolder) {
  return postJSONBatch(MOVE_MANY_URL, {
    items,
    dest_type: destType,
    dest_subfolder: destSubfolder
  });
}
function makeDir(type, subfolder, name) {
  return postJSON(MKDIR_URL, { type, subfolder, name });
}
function pinKeyOf(p) {
  return `${p.kind}:${p.type}:${p.subfolder}:${p.name ?? ""}`;
}
async function readPinsResponse(r) {
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return { ok: true, max: typeof data.max === "number" ? data.max : 0, pins: data.pins ?? [] };
}
async function fetchPins() {
  return readPinsResponse(await fetch(PINS_URL, { cache: "no-cache" }));
}
async function postPinDelta(op, item) {
  const body = { op };
  if (item)
    body.item = item;
  const r = await fetch(PINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return readPinsResponse(r);
}
function pinsToFiles(entries) {
  const out = [];
  for (const e of entries) {
    if (e.kind !== "file")
      continue;
    const name = e.name;
    if (!name)
      continue;
    const dot = name.lastIndexOf(".");
    out.push({
      name,
      ext: (e.ext ?? (dot >= 0 ? name.slice(dot) : "")).toLowerCase(),
      mtime: e.exists ? e.mtime ?? 0 : 0,
      size: e.exists ? e.size ?? 0 : 0,
      width: e.width,
      height: e.height,
      rating: e.exists ? e.rating ?? 0 : 0,
      ...e.exists && e.tags ? { tags: e.tags } : {},
      pinType: e.type,
      pinSub: e.subfolder,
      pinKind: "file",
      pinExists: e.exists
    });
  }
  return out;
}

// src/safe-tag.ts
var TAG_URL = "/image_browser/tag";
function sensitiveKeyword(cfg) {
  return cfg.keywords.length ? cfg.keywords[0] : null;
}
function hasSensitiveTag(f, keyword) {
  const want = keyword.toLowerCase();
  return (f.tags ?? []).some((t) => t.toLowerCase() === want);
}
function tagRequestBody(addr, tag, present) {
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, tag, present };
}
async function postTag(url, addr, tag, present) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tagRequestBody(addr, tag, present))
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.error || "tag failed");
  return Array.isArray(data.tags) ? data.tags : [];
}
function markSensitiveHTML(prefix, keyword, marked) {
  const label = marked ? `Unmark sensitive (removes ‘${keyword}’)` : `Mark sensitive (‘${keyword}’)`;
  return `<button type="button" class="${prefix}-act ${prefix}-act-mark${marked ? " is-marked" : ""}" data-action="marksensitive" aria-pressed="${marked}" title="${label}" aria-label="${label}">\uD83D\uDE48</button>`;
}

// src/browser.ts
var STYLE_ID4 = "ib-style";
var SORT_STORAGE_KEY = "comfyui-image-browser:sort";
var VALID_SORTS2 = new Set([
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
    if (!raw || !VALID_SORTS2.has(raw))
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
var VIEW_STORAGE_KEY = "comfyui-image-browser:view";
var VIEW_PENDING_KEY = "comfyui-image-browser:view-pending";
function loadSavedView() {
  try {
    if (localStorage.getItem(VIEW_PENDING_KEY) === "1") {
      localStorage.removeItem(VIEW_PENDING_KEY);
      localStorage.setItem(VIEW_STORAGE_KEY, "folder");
      return { mode: "folder", recovered: true };
    }
    return {
      mode: localStorage.getItem(VIEW_STORAGE_KEY) === "flat" ? "flat" : "folder",
      recovered: false
    };
  } catch {
    return { mode: "folder", recovered: false };
  }
}
function saveView(mode) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {}
}
var FILTER_STORAGE_KEY = "comfyui-image-browser:filter";
var VALID_FILTERS = new Set(["all", "images", "videos"]);
function loadSavedFilter() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    return raw && VALID_FILTERS.has(raw) ? raw : "all";
  } catch {
    return "all";
  }
}
function saveFilter(filter) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, filter);
  } catch {}
}
function markFlatPending(pending) {
  try {
    if (pending)
      localStorage.setItem(VIEW_PENDING_KEY, "1");
    else
      localStorage.removeItem(VIEW_PENDING_KEY);
  } catch {}
}
var MOVE_DEST_STORAGE_KEY = "comfyui-image-browser:move-dest";
function loadSavedDest() {
  try {
    const raw = localStorage.getItem(MOVE_DEST_STORAGE_KEY);
    if (!raw)
      return null;
    const i = raw.indexOf(":");
    if (i < 0)
      return null;
    const type = raw.slice(0, i);
    if (!SANDBOXED_TYPES.includes(type))
      return null;
    return { type, subfolder: raw.slice(i + 1) };
  } catch {
    return null;
  }
}
function saveDest(d) {
  try {
    localStorage.setItem(MOVE_DEST_STORAGE_KEY, `${d.type}:${d.subfolder}`);
  } catch {}
}
var scrollMemory = new Map;
var pinEntries = [];
var pinKeys = new Set;
function setPinCache(entries) {
  pinEntries = entries;
  pinKeys = new Set(entries.map(pinKeyOf));
}
function isPinned(item) {
  return pinKeys.has(pinKeyOf(item));
}
function folderPins() {
  return pinEntries.filter((p) => p.kind === "dir");
}
function pinLabel(p) {
  return `${p.type}${p.subfolder ? `/${p.subfolder}` : ""}`;
}
var PINS_STORAGE_KEY = "comfyui-image-browser:pins";
var SCAN_POLL_MS = 3000;
var SCAN_POLL_MAX = 20;
async function migrateLocalPins() {
  let raw = null;
  try {
    raw = localStorage.getItem(PINS_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw)
    return;
  let legacy = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      legacy = parsed;
  } catch {
    legacy = [];
  }
  for (const p of legacy) {
    const type = p?.type;
    if (!p || typeof p.subfolder !== "string" || !SANDBOXED_TYPES.includes(type))
      continue;
    try {
      setPinCache((await postPinDelta("add", { kind: "dir", type, subfolder: p.subfolder })).pins);
    } catch (e) {
      console.warn(`[${EXT_NAME}] pin migration skipped ${type}/${p.subfolder}`, e);
    }
  }
  try {
    localStorage.removeItem(PINS_STORAGE_KEY);
  } catch {}
}
function openImageBrowser() {
  ensureStyleOnce(STYLE_ID4, BROWSER_CSS);
  const savedView = loadSavedView();
  const state = {
    type: "output",
    subfolder: "",
    absPath: "",
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: "",
    viewMode: savedView.mode,
    typeFilter: loadSavedFilter()
  };
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }
  let disposeBackGuard = null;
  const modal = openModalShell({
    title: "Image Browser",
    placeholder: "Filter by filename…",
    width: "100vw",
    height: "100vh",
    footerLeftHTML: "<kbd>j/k</kbd> navigate · <kbd>i</kbd> metadata · <kbd>w</kbd> workflow · <kbd>b</kbd> safe view · <kbd>?</kbd> help · <kbd>Esc</kbd> close",
    footerRightHTML: '<span class="ib-count"></span>',
    onClose: () => {
      rememberScroll();
      markFlatPending(false);
      disposeLazyThumbs?.();
      disposeLazyThumbs = null;
      cancelScrollRestore();
      window.removeEventListener("keydown", onWindowKey, true);
      window.removeEventListener("keydown", onScrollKey, true);
      disposeBackGuard?.();
      disposeBackGuard = null;
      disposeSafeView();
      cancelScanPoll();
      revealed.clear();
    }
  });
  modal.dialog.classList.add("ib-dialog");
  const root = document.createElement("div");
  root.className = "image-browser-body";
  modal.bodyEl.appendChild(root);
  const tabsEl = document.createElement("div");
  tabsEl.className = "ib-tabs";
  for (const t of ["input", "output", "temp", "path", "pinned"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-tab";
    b.dataset.type = t;
    b.textContent = t === "path" ? "browse…" : t === "pinned" ? "\uD83D\uDCCC pinned" : t;
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
  const viewToggleEl = document.createElement("button");
  viewToggleEl.type = "button";
  viewToggleEl.className = "ib-control ib-icon ib-view-toggle";
  viewToggleEl.title = "Flat view (all subfolders)";
  viewToggleEl.textContent = "≣";
  const selectToggleEl = document.createElement("button");
  selectToggleEl.type = "button";
  selectToggleEl.className = "ib-control ib-icon ib-select-toggle";
  selectToggleEl.title = "Select multiple";
  selectToggleEl.textContent = "☑";
  const pinToggleEl = document.createElement("button");
  pinToggleEl.type = "button";
  pinToggleEl.className = "ib-control ib-icon ib-pin-toggle";
  pinToggleEl.title = "Pin this folder";
  pinToggleEl.textContent = "\uD83D\uDCCC";
  const newFolderEl = document.createElement("button");
  newFolderEl.type = "button";
  newFolderEl.className = "ib-control ib-icon ib-newfolder";
  newFolderEl.title = "New folder";
  newFolderEl.textContent = "\uD83D\uDCC1+";
  const pruneEl = document.createElement("button");
  pruneEl.type = "button";
  pruneEl.className = "ib-control ib-prune";
  pruneEl.title = "Remove pins whose file or folder no longer exists";
  pruneEl.textContent = "\uD83E\uDDF9 Prune missing";
  pruneEl.style.display = "none";
  const safeToggleEl = document.createElement("button");
  safeToggleEl.type = "button";
  safeToggleEl.className = "ib-control ib-icon ib-safe-toggle";
  const scanPillEl = document.createElement("button");
  scanPillEl.type = "button";
  scanPillEl.className = "ib-control ib-scan-pill";
  scanPillEl.title = "Files whose generation prompt has not been scanned yet — blurred until it is. Tap to refresh.";
  scanPillEl.style.display = "none";
  const filterEl = document.createElement("div");
  filterEl.className = "ib-filter";
  const filterGroupEl = document.createElement("div");
  filterGroupEl.className = "ib-filter-group";
  for (const [value, label, title] of [
    ["all", "All", "Show images and videos"],
    ["images", "\uD83D\uDDBC Images", "Show images only"],
    ["videos", "\uD83C\uDFAC Videos", "Show videos only"]
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-filter-seg";
    b.dataset.filter = value;
    b.title = title;
    b.textContent = label;
    filterGroupEl.appendChild(b);
  }
  filterEl.appendChild(filterGroupEl);
  const pinsEl = document.createElement("div");
  pinsEl.className = "ib-pins";
  modal.toolbarEl.append(tabsEl, crumbsEl, viewToggleEl, selectToggleEl, pinToggleEl, newFolderEl, pruneEl, safeToggleEl, scanPillEl, sortEl, refreshEl, filterEl, pinsEl);
  const gridEl = document.createElement("div");
  gridEl.className = "ib-grid";
  root.appendChild(gridEl);
  const scrollHost = modal.bodyEl;
  let liveScrollTop = 0;
  let userTookOver = false;
  let restoreRaf = 0;
  scrollHost.addEventListener("scroll", () => {
    liveScrollTop = scrollHost.scrollTop;
  }, { passive: true });
  function yieldScroller() {
    userTookOver = true;
    cancelScrollRestore();
  }
  for (const ev of ["pointerdown", "wheel", "touchstart"]) {
    scrollHost.addEventListener(ev, yieldScroller, { passive: true, capture: true });
  }
  const SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End"
  ]);
  function onScrollKey(e) {
    if (!SCROLL_KEYS.has(e.key) || isInInput())
      return;
    yieldScroller();
  }
  window.addEventListener("keydown", onScrollKey, true);
  function currentScrollTop() {
    if (scrollHost.isConnected)
      liveScrollTop = scrollHost.scrollTop;
    return liveScrollTop;
  }
  function setScrollTop(v) {
    scrollHost.scrollTop = v;
    liveScrollTop = scrollHost.scrollTop;
  }
  function cancelScrollRestore() {
    if (restoreRaf !== 0) {
      cancelAnimationFrame(restoreRaf);
      restoreRaf = 0;
    }
  }
  const RESTORE_FRAMES = 12;
  function restoreScroll(target) {
    cancelScrollRestore();
    userTookOver = false;
    setScrollTop(target);
    if (target <= 0)
      return;
    if (typeof requestAnimationFrame !== "function" || scrollHost.clientHeight <= 0)
      return;
    let frames = 0;
    const step = () => {
      restoreRaf = 0;
      if (userTookOver || !scrollHost.isConnected)
        return;
      const max = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
      const reachable = Math.min(target, max);
      if (Math.abs(scrollHost.scrollTop - reachable) > 1)
        setScrollTop(reachable);
      if (++frames >= RESTORE_FRAMES)
        return;
      restoreRaf = requestAnimationFrame(step);
    };
    restoreRaf = requestAnimationFrame(step);
  }
  const selBar = document.createElement("div");
  selBar.className = "ib-selbar";
  selBar.innerHTML = `
    <span class="ib-selbar-count"></span>
    <button type="button" class="ib-selbar-btn" data-selbar="pin">\uD83D\uDCCC Pin</button>
    <button type="button" class="ib-selbar-btn" data-selbar="move">⇄ Move…</button>
    <button type="button" class="ib-selbar-btn ib-selbar-danger" data-selbar="delete">\uD83D\uDDD1 Delete</button>
    <button type="button" class="ib-selbar-btn" data-selbar="clear">✕</button>`;
  const selBarCount = selBar.querySelector(".ib-selbar-count");
  modal.dialog.appendChild(selBar);
  const countEl = modal.footerEl.querySelector(".ib-count");
  function setCount(visible, total) {
    if (countEl)
      countEl.textContent = `${visible} / ${total}`;
  }
  const revealed = makeRevealSet();
  let revealLocation = null;
  function safePathOf(f) {
    if (state.type === "path")
      return state.absPath;
    return `${fileType(f)}/${fileSub(f)}`;
  }
  function safeTargetOf(f) {
    return {
      name: f.name,
      path: safePathOf(f),
      tags: f.tags,
      promptMatch: f.prompt_match
    };
  }
  function isCardHidden(f, cfg) {
    if (!isSensitive(safeTargetOf(f), cfg))
      return false;
    return !revealed.has(fileType(f), fileSub(f), f.name);
  }
  function renderSafeToggle(cfg) {
    const active = cfg.enabled && cfg.keywords.length > 0;
    safeToggleEl.classList.toggle("is-active", active);
    safeToggleEl.textContent = active ? SAFE_VIEW_GLYPH_ON : SAFE_VIEW_GLYPH_OFF;
    safeToggleEl.title = active ? "Safe View is on — matching thumbnails are blurred (b)" : "Safe View is off — nothing is filtered (b)";
    safeToggleEl.setAttribute("aria-pressed", String(active));
  }
  safeToggleEl.addEventListener("click", () => toggleSafeView());
  let scanPollTimer = null;
  let scanPollsLeft = 0;
  function cancelScanPoll() {
    if (scanPollTimer !== null) {
      clearTimeout(scanPollTimer);
      scanPollTimer = null;
    }
  }
  function renderScanPill(unscanned) {
    cancelScanPoll();
    if (unscanned <= 0) {
      scanPillEl.style.display = "none";
      scanPollsLeft = 0;
      return;
    }
    scanPillEl.style.display = "";
    scanPillEl.textContent = `\uD83D\uDD0D scanning ${unscanned}`;
    if (scanPollsLeft > 0) {
      scanPollsLeft -= 1;
      scanPollTimer = setTimeout(() => {
        scanPollTimer = null;
        loadAndRender({ preserveScroll: true });
      }, SCAN_POLL_MS);
    }
  }
  scanPillEl.addEventListener("click", () => {
    scanPollsLeft = SCAN_POLL_MAX;
    loadAndRender({ preserveScroll: true });
  });
  const disposeSafeView = onSafeViewChange(() => {
    loadAndRender({ preserveScroll: true });
  });
  const selected = new Map;
  let selectMode = false;
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
  function isFlat() {
    return state.viewMode === "flat" && SANDBOXED_TYPES.includes(state.type);
  }
  function fileSub(f) {
    if (f.pinSub !== undefined)
      return f.pinSub;
    const sp = f.subpath || "";
    if (!sp)
      return state.subfolder;
    const base = state.subfolder.replace(/\/+$/, "");
    return base ? `${base}/${sp}` : sp;
  }
  function fileType(f) {
    return f.pinType ?? state.type;
  }
  function canWriteFile(f) {
    return SANDBOXED_TYPES.includes(fileType(f));
  }
  function isPinnedView() {
    return state.type === "pinned";
  }
  function canSelectHere() {
    return SANDBOXED_TYPES.includes(state.type) || isPinnedView();
  }
  function filePinItem(f) {
    return { kind: "file", type: fileType(f), subfolder: fileSub(f), name: f.name };
  }
  function pinItemOf(p) {
    return p.kind === "file" ? { kind: "file", type: p.type, subfolder: p.subfolder, name: p.name } : { kind: "dir", type: p.type, subfolder: p.subfolder };
  }
  function pinsUnder(type, sub) {
    return pinEntries.filter((p) => p.type === type && (p.subfolder === sub || p.subfolder.startsWith(`${sub}/`))).map(pinItemOf);
  }
  function locationKey() {
    const view = isFlat() ? ":flat" : "";
    const filter = state.typeFilter === "all" ? "" : `:${state.typeFilter}`;
    return state.type === "path" ? `path:${state.absPath}${filter}` : `${state.type}:${state.subfolder}${view}${filter}`;
  }
  function rememberScroll() {
    scrollMemory.set(locationKey(), currentScrollTop());
  }
  function navigateUp() {
    rememberScroll();
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
    rememberScroll();
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }
  async function switchType(type) {
    rememberScroll();
    state.type = type;
    state.subfolder = "";
    if (type === "path") {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    loadAndRender();
  }
  function canGoUp() {
    return state.type === "path" ? !!state.absPath && state.absPath !== "/" : !!state.subfolder;
  }
  disposeBackGuard = installBackGuard(() => {
    const hasOverlay = !!modal.dialog.querySelector(".cmp-ov-backdrop");
    if (hasOverlay) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      return true;
    }
    if (canGoUp()) {
      navigateUp();
      return true;
    }
    modal.close();
    return false;
  });
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    renderGrid({ scrollTo: 0 });
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k;
    state.sortDir = d;
    saveSort(k, d);
    renderGrid({ scrollTo: 0 });
  });
  refreshEl.addEventListener("click", () => loadAndRender({ preserveScroll: true }));
  newFolderEl.addEventListener("click", () => void onNewFolder());
  viewToggleEl.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    rememberScroll();
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    saveView(state.viewMode);
    loadAndRender();
  });
  filterEl.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-filter]");
    if (!seg)
      return;
    const next = seg.dataset.filter;
    if (next === state.typeFilter)
      return;
    rememberScroll();
    state.typeFilter = next;
    saveFilter(next);
    loadAndRender();
  });
  selectToggleEl.addEventListener("click", () => setSelectMode(!selectMode));
  pinToggleEl.addEventListener("click", () => void toggleFolderPinHere());
  pruneEl.addEventListener("click", () => void onPruneMissing());
  pinsEl.addEventListener("click", (e) => {
    const t = e.target;
    const chip = t.closest("[data-pin-type]");
    if (!chip)
      return;
    const type = chip.dataset.pinType;
    if (!SANDBOXED_TYPES.includes(type))
      return;
    const pin = { kind: "dir", type, subfolder: chip.dataset.pinSub || "" };
    if (t.closest(".ib-pin-x")) {
      unpinFolder(pin);
      return;
    }
    if (pin.type === state.type && pin.subfolder === state.subfolder)
      return;
    rememberScroll();
    state.type = pin.type;
    state.subfolder = pin.subfolder;
    loadAndRender();
  });
  selBar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-selbar]");
    if (!b)
      return;
    const action = b.dataset.selbar;
    if (action === "move")
      doMoveSelected();
    else if (action === "delete")
      doDelete();
    else if (action === "pin")
      doPinSelected();
    else if (action === "clear") {
      setSelectMode(false);
      clearSelection();
    }
  });
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
    rememberScroll();
    if (c.dataset.abs !== undefined)
      state.absPath = c.dataset.abs || "/";
    else
      state.subfolder = c.dataset.sub || "";
    loadAndRender();
  });
  gridEl.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      return;
    }
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
      if (actionBtn?.dataset.action === "rmdir") {
        e.stopPropagation();
        onDeleteDir(card.dataset.name);
        return;
      }
      if (actionBtn?.dataset.action === "movedir") {
        e.stopPropagation();
        onMoveDir(card.dataset.name);
        return;
      }
      navigateInto(card.dataset.name);
      return;
    }
    const idx = Number(card.dataset.idx);
    const f = renderedFiles[idx];
    const subEl = target.closest(".ib-subpath");
    if (subEl) {
      e.stopPropagation();
      rememberScroll();
      state.viewMode = "folder";
      saveView("folder");
      const t = subEl.dataset.pinType;
      if (t && SANDBOXED_TYPES.includes(t))
        state.type = t;
      state.subfolder = subEl.dataset.sub || "";
      loadAndRender();
      return;
    }
    if (!f)
      return;
    if (target.closest("[data-check]")) {
      e.stopPropagation();
      toggleSelectionAt(idx);
      return;
    }
    const star = target.closest(".ib-star");
    if (star) {
      e.stopPropagation();
      const row = star.closest(".ib-stars");
      if (!row || !canWriteFile(f))
        return;
      const cur = Number(row.dataset.rating || "0");
      setStarRating(f, row, nextRating(cur, Number(star.dataset.val)));
      return;
    }
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === "open")
        openFull(f);
      else if (action === "meta")
        openMetadata(f);
      else if (action === "workflow")
        loadWorkflow(f);
      else if (action === "delete")
        onDelete(f);
      else if (action === "rename")
        onRename(f);
      else if (action === "move")
        onMove(f);
      else if (action === "pin")
        toggleFilePin(f);
      else if (action === "marksensitive")
        toggleSensitiveTag(f, actionBtn);
      return;
    }
    if (selectMode && canWriteFile(f)) {
      toggleSelectionAt(idx);
      return;
    }
    openFull(f);
  });
  let suppressClick = false;
  let dragSel = null;
  let lpTimer = null;
  let lpX = 0;
  let lpY = 0;
  function cancelLongPress() {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }
  gridEl.addEventListener("pointerdown", (e) => {
    suppressClick = false;
    if (!canSelectHere())
      return;
    if (e.pointerType === "mouse" && e.button !== 0)
      return;
    const target = e.target;
    const card = target.closest(".ib-card.is-file");
    if (!card)
      return;
    const idx = Number(card.dataset.idx);
    if (!Number.isFinite(idx))
      return;
    if (target.closest("[data-check]")) {
      const f = renderedFiles[idx];
      dragSel = { on: !(f && isSelected(f)), last: idx, moved: false };
      try {
        gridEl.setPointerCapture(e.pointerId);
      } catch {}
      return;
    }
    if (e.pointerType === "mouse")
      return;
    lpX = e.clientX;
    lpY = e.clientY;
    cancelLongPress();
    lpTimer = setTimeout(() => {
      lpTimer = null;
      suppressClick = true;
      if (!selectMode)
        setSelectMode(true);
      toggleSelectionAt(idx);
    }, 450);
  });
  gridEl.addEventListener("pointermove", (e) => {
    if (dragSel) {
      if (!dragSel.moved) {
        dragSel.moved = true;
        setSelectedRange(dragSel.last, dragSel.last, dragSel.on);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el instanceof Element ? el.closest(".ib-card.is-file") : null;
      if (card) {
        const idx = Number(card.dataset.idx);
        if (Number.isFinite(idx) && idx !== dragSel.last) {
          setSelectedRange(dragSel.last, idx, dragSel.on);
          dragSel.last = idx;
        }
      }
      return;
    }
    if (lpTimer && (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8)) {
      cancelLongPress();
    }
  });
  function endPointerGesture(e) {
    if (dragSel) {
      if (dragSel.moved)
        suppressClick = true;
      dragSel = null;
      try {
        gridEl.releasePointerCapture(e.pointerId);
      } catch {}
    }
    cancelLongPress();
  }
  gridEl.addEventListener("pointerup", endPointerGesture);
  gridEl.addEventListener("pointercancel", endPointerGesture);
  gridEl.addEventListener("contextmenu", (e) => {
    if (selectMode || suppressClick || lpTimer)
      e.preventDefault();
  });
  function setStarRating(f, row, next) {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    f.rating = next;
    const addr = {
      type: fileType(f),
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name
    };
    postRating(RATING_URL, addr, next).then((confirmed) => {
      if (confirmed !== next) {
        applyStars(row, confirmed);
        f.rating = confirmed;
      }
    }).catch((e) => {
      reportError("Rating failed", e);
      applyStars(row, prev);
      f.rating = prev;
    });
  }
  async function toggleSensitiveTag(f, btn) {
    const keyword = sensitiveKeyword(readSafeViewConfig());
    if (!keyword)
      return;
    if (!canWriteFile(f))
      return;
    const next = !hasSensitiveTag(f, keyword);
    const button = btn;
    button.disabled = true;
    try {
      f.tags = await postTag(TAG_URL, { type: fileType(f), subfolder: fileSub(f), name: f.name }, keyword, next);
      renderGrid();
    } catch (e) {
      reportError(next ? "Not marked" : "Not unmarked", e);
      button.disabled = false;
    }
  }
  function openFull(f) {
    if (revealed.has(fileType(f), fileSub(f), f.name)) {} else if (isCardHidden(f, readSafeViewConfig())) {
      revealed.reveal(fileType(f), fileSub(f), f.name);
      renderGrid();
    }
    const url = fullSrcURL(fileType(f), fileSub(f), f.name, state.absPath);
    window.open(url, "_blank", "noopener");
  }
  const copyFeedback = new WeakMap;
  function copyInto(btn, text, restore) {
    let fb = copyFeedback.get(btn);
    if (!fb) {
      fb = { seq: 0, timer: null };
      copyFeedback.set(btn, fb);
    }
    const slot = fb;
    const seq = ++slot.seq;
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    copyTextToClipboard(text).then((ok) => {
      if (slot.seq !== seq)
        return;
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("is-copied", ok);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        btn.textContent = restore;
        btn.classList.remove("is-copied");
      }, 1500);
    });
  }
  async function loadWorkflow(f) {
    const sub = fileSub(f);
    const type = fileType(f);
    try {
      const meta = await fetchMetadata(type, sub, f.name, state.absPath);
      const graphJSON = embeddedWorkflowJSON(meta);
      if (!graphJSON) {
        notify({
          severity: "warn",
          summary: "No workflow in this file",
          detail: `${f.name} carries no embedded graph. Files saved by another tool (or re-encoded, e.g. by a phone gallery or a chat app) lose ComfyUI's metadata.`
        });
        return;
      }
      if (META_VIDEO_EXTS.has((f.ext || "").toLowerCase())) {
        const base = f.name.replace(/\.[^./]+$/, "");
        const file2 = new File([graphJSON], `${base}.json`, { type: "application/json" });
        modal.close();
        await app.handleFile(file2);
        return;
      }
      const res = await fetch(fullSrcURL(type, sub, f.name, state.absPath));
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], f.name, { type: blob.type });
      modal.close();
      await app.handleFile(file);
    } catch (e) {
      notify({
        severity: "error",
        summary: "Could not load workflow",
        detail: `${f.name}: ${e instanceof Error ? e.message : String(e)}`
      });
    }
  }
  async function openMetadata(f) {
    let live = true;
    const ov = openShellOverlay(modal, {
      onDismiss: () => {
        live = false;
      }
    });
    ov.card.classList.add("ib-meta-card");
    const close = () => {
      live = false;
      ov.close();
    };
    const title = `Metadata — ${escapeHTML(f.name)}`;
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ib-meta-body"><div class="ib-meta-status">Reading metadata…</div></div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    let data;
    try {
      data = await fetchMetadata(fileType(f), fileSub(f), f.name, state.absPath);
    } catch (e) {
      close();
      reportError("Metadata read failed", e);
      return;
    }
    if (!live)
      return;
    const rows = metaRows(data.summary);
    const rawKeys = Object.keys(data.raw);
    const srcLabel = data.source === "comfyui" ? "ComfyUI" : data.source === "a1111" ? "A1111" : "no generation data";
    const rowsHTML = rows.map((r, i) => `
        <div class="ib-meta-row">
          <div class="ib-meta-k">${escapeHTML(r.label)}</div>
          <div class="ib-meta-v">${escapeHTML(r.value)}</div>
          <button type="button" class="ib-meta-copy" data-copy-row="${i}">Copy</button>
        </div>`).join("");
    const emptyHTML = rows.length ? "" : `<div class="ib-meta-empty">${rawKeys.length ? "No recognised generation parameters." : "No generation metadata found."}</div>`;
    const rawJSON = JSON.stringify(data.raw, null, 2);
    const rawHTML = rawKeys.length ? `
        <details class="ib-meta-raw">
          <summary>Raw metadata (${rawKeys.length} key${rawKeys.length === 1 ? "" : "s"})</summary>
          <pre>${escapeHTML(rawJSON)}</pre>
          <button type="button" class="ib-meta-copy" data-copy-raw>Copy JSON</button>
        </details>` : "";
    const noteHTML = data.truncated ? `<div class="ib-meta-note">Some values were truncated by the server.</div>` : "";
    const copyAll = rows.length ? `<button type="button" class="cmp-ov-btn cmp-ov-primary" data-copy-all>Copy all</button>` : "";
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ib-meta-body">
        <div class="ib-meta-src">${escapeHTML(srcLabel)}${data.format ? `<span class="ib-meta-fmt">${escapeHTML(data.format)}</span>` : ""}</div>
        ${emptyHTML}
        ${rowsHTML}
        ${noteHTML}
        ${rawHTML}
      </div>
      <div class="cmp-ov-actions">
        ${copyAll}
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    for (const btn of ov.card.querySelectorAll("[data-copy-row]")) {
      const row = rows[Number(btn.dataset.copyRow)];
      const label = btn.textContent || "Copy";
      if (row)
        btn.addEventListener("click", () => copyInto(btn, row.value, label));
    }
    const rawBtn = ov.card.querySelector("[data-copy-raw]");
    const rawLabel = rawBtn?.textContent || "Copy JSON";
    rawBtn?.addEventListener("click", () => copyInto(rawBtn, rawJSON, rawLabel));
    const allBtn = ov.card.querySelector("[data-copy-all]");
    const allLabel = allBtn?.textContent || "Copy all";
    allBtn?.addEventListener("click", () => copyInto(allBtn, metaClipboardText(rows), allLabel));
  }
  async function onDelete(f) {
    const ok = await confirmInShell(modal, {
      title: "Delete file?",
      message: `Permanently delete "${f.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok)
      return;
    const pin = filePinItem(f);
    try {
      await deleteFile(fileType(f), fileSub(f), f.name);
      await followPins([{ from: pin, to: null }]);
      state.files = state.files.filter((x) => x !== f);
      renderGrid();
    } catch (e) {
      reportError("Delete failed", e);
    }
  }
  async function onRename(f) {
    const name = f.name;
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    const newName = await promptInShell(modal, {
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
    const from = filePinItem(f);
    try {
      await renameFile(fileType(f), fileSub(f), name, newName);
      await followPins([{ from, to: { ...from, name: newName } }]);
      f.name = newName;
      renderGrid();
    } catch (e) {
      reportError("Rename failed", e);
    }
  }
  async function onMove(f) {
    const dest = await pickDestination(modal, {
      type: fileType(f),
      subfolder: fileSub(f)
    });
    if (!dest)
      return;
    const from = filePinItem(f);
    try {
      await moveFile(fileType(f), fileSub(f), f.name, dest.type, dest.subfolder);
      saveDest(dest);
      await followPins([
        { from, to: { kind: "file", type: dest.type, subfolder: dest.subfolder, name: f.name } }
      ]);
      state.files = state.files.filter((x) => x !== f);
      renderGrid();
      notify({
        severity: "success",
        summary: "Moved",
        detail: `"${f.name}" → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
      });
    } catch (e) {
      reportError("Move failed", e);
    }
  }
  function refreshPinButtons() {
    for (const [i, c] of fileCards().entries()) {
      const f = renderedFiles[i];
      const btn = c.querySelector('[data-action="pin"]');
      if (!f || !btn)
        continue;
      const on = isPinned(filePinItem(f));
      btn.classList.toggle("is-pinned", on);
      btn.title = on ? "Unpin this file" : "Pin this file";
    }
  }
  async function refreshPinnedUI() {
    if (isPinnedView()) {
      await loadAndRender({ preserveScroll: true });
      return;
    }
    renderPins();
    refreshPinButtons();
  }
  async function toggleFolderPinHere() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const item = { kind: "dir", type: state.type, subfolder: state.subfolder };
    const pinned = isPinned(item);
    try {
      setPinCache((await postPinDelta(pinned ? "remove" : "add", item)).pins);
      renderPins();
    } catch (e) {
      reportError(pinned ? "Unpin failed" : "Pin failed", e);
    }
  }
  async function unpinFolder(item) {
    try {
      setPinCache((await postPinDelta("remove", item)).pins);
      renderPins();
    } catch (e) {
      reportError("Unpin failed", e);
    }
  }
  async function toggleFilePin(f) {
    if (!canWriteFile(f))
      return;
    const item = filePinItem(f);
    const pinned = isPinned(item);
    try {
      setPinCache((await postPinDelta(pinned ? "remove" : "add", item)).pins);
      await refreshPinnedUI();
    } catch (e) {
      reportError(pinned ? "Unpin failed" : "Pin failed", e);
    }
  }
  async function doPinSelected() {
    const items = collectSelectedOrFocused();
    if (items.length === 0)
      return;
    let added = 0;
    const failures = new Set;
    for (const it of items) {
      try {
        const res = await postPinDelta("add", {
          kind: "file",
          type: it.type,
          subfolder: it.subfolder,
          name: it.name
        });
        setPinCache(res.pins);
        added++;
      } catch (e) {
        failures.add(e instanceof Error ? e.message : String(e));
      }
    }
    await refreshPinnedUI();
    if (failures.size > 0) {
      reportError(`Pinned ${added}, ${items.length - added} failed`, new Error(Array.from(failures).join("; ")));
      return;
    }
    notify({ severity: "success", summary: "Pinned", detail: `${added} file(s)` });
  }
  async function onPruneMissing() {
    const before = pinEntries.length;
    try {
      const res = await postPinDelta("prune");
      const removed = before - res.pins.length;
      setPinCache(res.pins);
      await refreshPinnedUI();
      notify({
        severity: "success",
        summary: "Pins pruned",
        detail: `${removed} missing pin(s) removed`
      });
    } catch (e) {
      reportError("Prune failed", e);
    }
  }
  async function followPins(changes) {
    const live = changes.filter((c) => isPinned(c.from));
    if (live.length === 0)
      return;
    try {
      for (const c of live) {
        setPinCache((await postPinDelta("remove", c.from)).pins);
        if (c.to)
          setPinCache((await postPinDelta("add", c.to)).pins);
      }
      renderPins();
    } catch (e) {
      reportError("Pin list not updated for this change", e);
    }
  }
  function renderTabs() {
    for (const b of tabsEl.querySelectorAll(".ib-tab")) {
      b.classList.toggle("is-active", b.dataset.type === state.type);
    }
    const canWrite = SANDBOXED_TYPES.includes(state.type);
    selectToggleEl.style.display = canSelectHere() ? "" : "none";
    newFolderEl.style.display = canWrite ? "" : "none";
    viewToggleEl.style.display = canWrite ? "" : "none";
    viewToggleEl.classList.toggle("is-active", isFlat());
    viewToggleEl.title = isFlat() ? "Folder view" : "Flat view (all subfolders)";
    for (const b of filterGroupEl.querySelectorAll(".ib-filter-seg")) {
      b.classList.toggle("is-active", b.dataset.filter === state.typeFilter);
    }
  }
  function renderPins() {
    const pins = folderPins();
    const canPin = SANDBOXED_TYPES.includes(state.type);
    pinToggleEl.style.display = canPin ? "" : "none";
    const herePinned = canPin && isPinned({ kind: "dir", type: state.type, subfolder: state.subfolder });
    pinToggleEl.classList.toggle("is-active", herePinned);
    pinToggleEl.title = herePinned ? "Unpin this folder" : "Pin this folder";
    pruneEl.style.display = isPinnedView() && pinEntries.some((p) => p.exists === false) ? "" : "none";
    pinsEl.innerHTML = "";
    pinsEl.style.display = pins.length ? "" : "none";
    for (const p of pins) {
      const chip = document.createElement("span");
      chip.className = "ib-pin-chip";
      chip.dataset.pinType = p.type;
      chip.dataset.pinSub = p.subfolder;
      if (p.type === state.type && p.subfolder === state.subfolder)
        chip.classList.add("is-current");
      const go = document.createElement("button");
      go.type = "button";
      go.className = "ib-pin-go";
      go.title = `Go to ${pinLabel(p)}`;
      go.textContent = `\uD83D\uDCCC ${pinLabel(p)}`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ib-pin-x";
      x.title = `Unpin ${pinLabel(p)}`;
      x.textContent = "✕";
      chip.append(go, x);
      pinsEl.appendChild(chip);
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
  async function loadAndRender(opts) {
    focusIndex = 0;
    visualMode = false;
    modal.dialog.classList.remove("is-visual");
    clearPending();
    const here = locationKey();
    if (revealLocation !== here) {
      revealed.clear();
      revealLocation = here;
      scanPollsLeft = SCAN_POLL_MAX;
    }
    renderTabs();
    renderCrumbs();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    markFlatPending(isFlat());
    const safeCfg = readSafeViewConfig();
    renderSafeToggle(safeCfg);
    try {
      if (isPinnedView()) {
        const res = await fetchPins();
        setPinCache(res.pins);
        state.dirs = [];
        state.files = narrowByKind(pinsToFiles(res.pins), state.typeFilter);
        if (safeCfg.hide) {
          state.files = state.files.filter((f) => !isSensitive(safeTargetOf(f), safeCfg));
        }
        renderScanPill(0);
        modal.setStatus(res.pins.length ? "" : "Nothing pinned yet.");
      } else {
        const data = await fetchListing({
          type: state.type,
          subfolder: state.subfolder,
          path: state.absPath,
          recursive: isFlat(),
          kind: state.typeFilter,
          safeHide: safeCfg.hide,
          safeKeywords: safeCfg.keywords,
          safePrompt: safeCfg.matchPrompt
        });
        state.dirs = data.dirs || [];
        state.files = data.files || [];
        renderScanPill(data.safe_unscanned ?? 0);
        modal.setStatus(data.exists ? "" : "Directory not found.");
        if (data.truncated) {
          notify({
            severity: "warn",
            summary: `Showing the newest ${state.files.length}`,
            detail: "This folder's subtree has more files than the flat view returns; older ones are not listed."
          });
        }
      }
    } catch (e) {
      reportError(isPinnedView() ? "Failed to load pins" : "Failed to load directory", e);
      modal.setStatus(`Error: ${e.message}`);
      state.dirs = [];
      state.files = [];
      renderScanPill(0);
    }
    modal.setBusy(false);
    renderPins();
    renderGrid({
      scrollTo: opts?.preserveScroll ? undefined : scrollMemory.get(locationKey()) ?? 0
    });
    markFlatPending(false);
  }
  function narrowByKind(files, filter) {
    if (filter === "all")
      return files;
    const want = filter === "images" ? IMG_EXTS : VIDEO_EXTS;
    return files.filter((f) => want.has((f.ext || "").toLowerCase()));
  }
  function thumbForFile(f) {
    if (f.pinExists === false)
      return { kind: "icon", text: "⚠" };
    const ext = (f.ext || "").toLowerCase();
    const sub = fileSub(f);
    const type = fileType(f);
    if (IMG_EXTS.has(ext)) {
      return {
        kind: "img",
        src: imageThumbURL(type, sub, f.name, state.absPath, thumbVersion(f.mtime, f.size))
      };
    }
    if (VIDEO_EXTS.has(ext)) {
      return {
        kind: "video",
        src: videoSrcURL(type, sub, f.name, state.absPath)
      };
    }
    return { kind: "icon", text: "\uD83D\uDCC4" };
  }
  function renderGrid(opts) {
    const q = state.query;
    const targetScrollTop = opts?.scrollTo ?? currentScrollTop();
    const safeCfg = readSafeViewConfig();
    const safeKeyword = sensitiveKeyword(safeCfg);
    renderSafeToggle(safeCfg);
    gridEl.innerHTML = "";
    const canWrite = SANDBOXED_TYPES.includes(state.type);
    const flat = isFlat();
    const pinnedView = isPinnedView();
    const showUp = !flat && canGoUp();
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ib-card is-up";
      up.innerHTML = `<div class="ib-thumb ib-thumb-icon">↑</div><div class="ib-name">..</div>`;
      gridEl.appendChild(up);
    }
    if (!flat) {
      for (const d of state.dirs) {
        if (q && !d.name.toLowerCase().includes(q))
          continue;
        const c = document.createElement("div");
        c.className = "ib-card is-dir";
        c.dataset.name = d.name;
        const dirBtns = canWrite ? `<button type="button" class="ib-dir-move" data-action="movedir" title="Move folder">⇄</button>` + `<button type="button" class="ib-dir-del" data-action="rmdir" title="Delete folder">\uD83D\uDDD1</button>` : "";
        c.innerHTML = `<div class="ib-thumb ib-thumb-icon">\uD83D\uDCC1</div><div class="ib-name" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</div>${dirBtns}`;
        gridEl.appendChild(c);
        if (isSensitive({ name: d.name }, safeCfg)) {
          c.classList.add("is-safe-hidden");
          const icon = c.querySelector(".ib-thumb");
          if (icon)
            setBlurred(icon, true);
          if (safeCfg.blurNames) {
            const nameEl = c.querySelector(".ib-name");
            if (nameEl)
              setSpoilered(nameEl, true);
          }
        }
      }
    }
    let files = state.files;
    if (q) {
      const scored = [];
      for (const f of files) {
        const hay = flat && f.subpath ? `${f.subpath}/${f.name}` : f.name;
        const r = fuzzyScore(q, hay);
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
      const canWriteThis = canWriteFile(f);
      const hidden = isCardHidden(f, safeCfg);
      const spoilNames = hidden && safeCfg.blurNames;
      const missing = f.pinExists === false;
      if (flat || pinnedView)
        c.classList.add("is-flat");
      if (missing)
        c.classList.add("is-missing");
      if (fi === focusIndex)
        c.classList.add("is-focused");
      if (isSelected(f))
        c.classList.add("is-selected");
      c.dataset.name = f.name;
      c.dataset.ext = (f.ext || "").toLowerCase();
      c.dataset.idx = String(fi);
      const t = thumbForFile(f);
      const dims = f.width && f.height ? `${f.width}×${f.height}` : "";
      const when = new Date(f.mtime * 1000).toLocaleString();
      const titleText = dims ? `${f.name}
${dims}
${when}` : `${f.name}
${when}`;
      const thumbInner = t.kind === "img" ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">` : t.kind === "video" ? `<video muted playsinline preload="none" data-src="${t.src}"></video>` : `<div class="ib-thumb-icon">${t.text}</div>`;
      const hasMeta = META_EXTS.has((f.ext || "").toLowerCase());
      const metaBtn = hasMeta ? `<button type="button" class="ib-act" data-action="meta" title="Metadata (i)">ⓘ</button>` : "";
      const wfBtn = hasMeta ? `<button type="button" class="ib-act" data-action="workflow" title="Load workflow (w)">⤓</button>` : "";
      const moveBtn = canWriteThis ? `<button type="button" class="ib-act" data-action="move" title="Move">⇄</button>` : "";
      const writeBtns = canWriteThis ? `<button type="button" class="ib-act" data-action="rename" title="Rename">✎</button>
           ${moveBtn}
           <button type="button" class="ib-act ib-act-danger" data-action="delete" title="Delete">\uD83D\uDDD1</button>` : "";
      const isFilePinned = canWriteThis && isPinned(filePinItem(f));
      const pinBtn = canWriteThis ? `<button type="button" class="ib-act ib-act-pin${isFilePinned ? " is-pinned" : ""}" data-action="pin" title="${isFilePinned ? "Unpin this file" : "Pin this file"}">\uD83D\uDCCC</button>` : "";
      const markBtn = canWriteThis && !missing && safeKeyword ? markSensitiveHTML("ib", safeKeyword, hasSensitiveTag(f, safeKeyword)) : "";
      const starsRow = canWriteThis ? starsHTML("ib", ratingOf(f)) : ratingOf(f) ? `<div class="ib-stars is-ro" data-rating="${ratingOf(f)}">${"★".repeat(ratingOf(f))}</div>` : "";
      const checkBtn = canWriteThis ? `<button type="button" class="ib-check" data-check aria-label="${spoilNames ? "Select hidden item" : `Select ${escapeHTML(f.name)}`}">✓</button>` : "";
      const subLabel = pinnedView ? `<button type="button" class="ib-subpath" data-pin-type="${escapeHTML(fileType(f))}" data-sub="${escapeHTML(fileSub(f))}" title="Go to ${escapeHTML(pinLabel(filePinItem(f)))}">${escapeHTML(`${fileType(f)}/${fileSub(f) ? `${fileSub(f)}/` : ""}`)}</button>` : flat ? f.subpath ? `<button type="button" class="ib-subpath" data-sub="${escapeHTML(fileSub(f))}" title="Go to ${escapeHTML(f.subpath)}">${escapeHTML(f.subpath)}</button>` : `<div class="ib-subpath is-root" title="Top level">/</div>` : "";
      c.innerHTML = missing ? `
        ${subLabel}
        <div class="ib-thumb">${thumbInner}</div>
        <div class="ib-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</div>
        <div class="ib-meta">missing</div>
        <div class="ib-actions">${pinBtn}</div>` : `
        ${subLabel}
        ${checkBtn}
        <div class="ib-thumb">${thumbInner}</div>
        <div class="ib-name" title="${escapeHTML(titleText)}">${escapeHTML(f.name)}</div>
        ${dims ? `<div class="ib-meta">${dims}</div>` : ""}
        ${starsRow}
        <div class="ib-actions">
          <button type="button" class="ib-act" data-action="open" title="Open full size">↗</button>
          ${metaBtn}
          ${wfBtn}
          ${pinBtn}
          ${markBtn}
          ${writeBtns}
        </div>`;
      gridEl.appendChild(c);
      if (hidden)
        applySafeView(c, f, spoilNames);
      visible++;
    }
    if (!visible && !state.dirs.length && !showUp) {
      const el = document.createElement("div");
      el.className = "ib-empty";
      el.textContent = pinnedView ? "No pinned files. Tap \uD83D\uDCCC on a card to add one." : "No matching files in this folder.";
      gridEl.appendChild(el);
    }
    setCount(visible, state.files.length);
    restoreScroll(targetScrollTop);
    installLazyThumbs(gridEl);
  }
  function applySafeView(card, f, spoilNames) {
    card.classList.add("is-safe-hidden");
    const thumb = card.querySelector(".ib-thumb");
    if (thumb)
      setBlurred(thumb, true);
    if (spoilNames) {
      for (const sel of [".ib-name", ".ib-subpath"]) {
        const el = card.querySelector(sel);
        if (el)
          setSpoilered(el, true);
      }
    }
    card.appendChild(makeRevealButton({
      onReveal: () => {
        revealed.reveal(fileType(f), fileSub(f), f.name);
        renderGrid();
      }
    }));
  }
  let disposeLazyThumbs = null;
  function installLazyThumbs(rootEl) {
    disposeLazyThumbs?.();
    disposeLazyThumbs = installLazyMedia(rootEl, { root: scrollHost, rootMargin: "300px" });
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
    if (!canWriteFile(f))
      return false;
    return selected.has(selectionKey(fileType(f), fileSub(f), f.name));
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
    cancelScrollRestore();
    focused?.scrollIntoView({ block: "nearest", inline: "nearest" });
    liveScrollTop = scrollHost.scrollTop;
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
    selBar.classList.toggle("is-visible", n > 0);
    selBarCount.textContent = `${n} selected`;
  }
  function setSelectMode(on) {
    if (on && !canSelectHere())
      return;
    selectMode = on;
    selectToggleEl.classList.toggle("is-active", on);
    modal.dialog.classList.toggle("is-selecting", on);
  }
  function selectFile(f) {
    const sub = fileSub(f);
    selected.set(selectionKey(fileType(f), sub, f.name), {
      file: f,
      type: fileType(f),
      subfolder: sub
    });
  }
  function toggleSelectionAt(i) {
    const f = renderedFiles[i];
    if (!f || !canWriteFile(f))
      return;
    const key = selectionKey(fileType(f), fileSub(f), f.name);
    if (selected.has(key))
      selected.delete(key);
    else
      selectFile(f);
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function setSelectedRange(a, b, on) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo;i <= hi; i++) {
      const f = renderedFiles[i];
      if (!f || !canWriteFile(f))
        continue;
      if (on)
        selectFile(f);
      else
        selected.delete(selectionKey(fileType(f), fileSub(f), f.name));
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function extendSelectionTo(i) {
    const lo = Math.min(visualAnchor, i);
    const hi = Math.max(visualAnchor, i);
    for (let k = lo;k <= hi; k++) {
      const f = renderedFiles[k];
      if (!f || !canWriteFile(f))
        continue;
      selectFile(f);
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }
  function selectAllVisible() {
    for (const f of renderedFiles) {
      if (!canWriteFile(f))
        continue;
      selectFile(f);
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
    if (!canSelectHere())
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
    if (!f || !canWriteFile(f))
      return [];
    return [{ type: fileType(f), subfolder: fileSub(f), name: f.name }];
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
    const items = collectSelectedOrFocused();
    if (items.length === 0)
      return;
    const count = items.length;
    const ok = await confirmInShell(modal, {
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
      const succeeded = new Set(items.filter((it) => !errored.has(it.name)).map((it) => selectionKey(it.type, it.subfolder, it.name)));
      state.files = state.files.filter((f) => !succeeded.has(selectionKey(fileType(f), fileSub(f), f.name)));
      for (const it of items) {
        if (!errored.has(it.name))
          selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      await followPins(items.filter((it) => !errored.has(it.name)).map((it) => ({
        from: { kind: "file", type: it.type, subfolder: it.subfolder, name: it.name },
        to: null
      })));
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
  async function doMoveSelected() {
    const items = collectSelectedOrFocused();
    if (items.length === 0)
      return;
    const dest = await pickDestination(modal, {
      type: state.type,
      subfolder: state.subfolder
    });
    if (!dest)
      return;
    try {
      const result = await moveMany(items, dest.type, dest.subfolder);
      const errored = new Set((result.errors ?? []).map((er) => er.name));
      for (const it of items) {
        if (!errored.has(it.name))
          selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      updateSelectedCount();
      if (result.moved > 0)
        saveDest(dest);
      await followPins(items.filter((it) => !errored.has(it.name)).map((it) => ({
        from: { kind: "file", type: it.type, subfolder: it.subfolder, name: it.name },
        to: {
          kind: "file",
          type: dest.type,
          subfolder: dest.subfolder,
          name: it.name
        }
      })));
      if (isFlat() || isPinnedView() || dest.type === state.type && dest.subfolder === state.subfolder) {
        await loadAndRender({ preserveScroll: true });
      } else {
        const succeeded = new Set(items.filter((it) => !errored.has(it.name)).map((it) => selectionKey(it.type, it.subfolder, it.name)));
        state.files = state.files.filter((f) => !succeeded.has(selectionKey(fileType(f), fileSub(f), f.name)));
        renderGrid();
      }
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((er) => er.name).join(", ");
        reportError(`Moved ${result.moved}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify({
          severity: "success",
          summary: "Moved",
          detail: `${result.moved} file(s) → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
        });
      }
    } catch (e) {
      reportError("Move failed", e);
    }
  }
  async function onNewFolder() {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const existing = new Set(state.dirs.map((d) => d.name));
    const name = await promptInShell(modal, {
      title: "New folder",
      label: `Create in ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`,
      value: "",
      confirmLabel: "Create",
      validate: (v) => {
        if (!v)
          return "Folder name required";
        if (v.includes("/") || v.includes("\\"))
          return "No slashes allowed";
        if (v === "." || v === "..")
          return "Invalid name";
        if (existing.has(v))
          return "A folder with that name already exists";
        return null;
      }
    });
    if (!name)
      return;
    try {
      await makeDir(state.type, state.subfolder, name);
      await loadAndRender({ preserveScroll: true });
      notify({ severity: "success", summary: "Folder created", detail: `"${name}"` });
    } catch (e) {
      reportError("Create folder failed", e);
    }
  }
  async function onMoveDir(name) {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const srcSub = state.subfolder ? `${state.subfolder}/${name}` : name;
    const dest = await pickDestination(modal, { type: state.type, subfolder: state.subfolder }, { type: state.type, subfolder: srcSub });
    if (!dest)
      return;
    try {
      const result = await moveDir(state.type, state.subfolder, name, dest.type, dest.subfolder);
      saveDest(dest);
      const conflicts = result.errors ?? [];
      if (conflicts.length > 0) {
        await loadAndRender({ preserveScroll: true });
        reportError(`Folder merged, ${conflicts.length} item(s) left in place`, new Error(conflicts.map((c) => c.name).join(", ")));
        return;
      }
      state.dirs = state.dirs.filter((d) => d.name !== name);
      await followPins(pinsUnder(state.type, srcSub).map((from) => ({ from, to: null })));
      renderPins();
      renderGrid();
      notify({
        severity: "success",
        summary: result.merged ? "Folder merged" : "Folder moved",
        detail: `"${name}" → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`
      });
    } catch (e) {
      reportError("Move folder failed", e);
    }
  }
  async function onDeleteDir(name) {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    try {
      const res = await removeDir(state.type, state.subfolder, name, false);
      if (res.status === "not_empty") {
        const parts = [`${res.files} file${res.files === 1 ? "" : "s"}`];
        if (res.dirs > 0)
          parts.push(`${res.dirs} subfolder${res.dirs === 1 ? "" : "s"}`);
        const ok = await confirmInShell(modal, {
          title: "Delete folder and contents?",
          message: `"${name}" contains ${parts.join(" and ")}. Permanently delete everything inside? This cannot be undone.`,
          confirmLabel: `Delete ${res.files} file${res.files === 1 ? "" : "s"}`,
          danger: true
        });
        if (!ok)
          return;
        await removeDir(state.type, state.subfolder, name, true);
      }
      state.dirs = state.dirs.filter((d) => d.name !== name);
      const gone = state.subfolder ? `${state.subfolder}/${name}` : name;
      await followPins(pinsUnder(state.type, gone).map((from) => ({ from, to: null })));
      renderPins();
      renderGrid();
      notify({
        severity: "success",
        summary: "Folder deleted",
        detail: res.status === "not_empty" ? `"${name}" (${res.files} files)` : `"${name}" (empty)`
      });
    } catch (e) {
      reportError("Delete folder failed", e);
    }
  }
  function doYank() {
    if (!canSelectHere())
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
      const landed = yanked.filter((it) => !result.errors?.some((e) => e.name === it.name));
      for (const it of landed)
        selected.delete(selectionKey(it.type, it.subfolder, it.name));
      await followPins(landed.map((it) => ({
        from: { kind: "file", type: it.type, subfolder: it.subfolder, name: it.name },
        to: {
          kind: "file",
          type: state.type,
          subfolder: state.subfolder,
          name: it.name
        }
      })));
      yanked = null;
      updateSelectedCount();
      if (result.moved > 0)
        saveDest({ type: state.type, subfolder: state.subfolder });
      await loadAndRender({ preserveScroll: true });
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
    rememberScroll();
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
    const ov = openShellOverlay(modal);
    ov.card.classList.add("ib-help-card");
    ov.card.innerHTML = `
      <div class="cmp-ov-title">Keyboard shortcuts</div>
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
            <dt>long-press</dt><dd>select mode (touch)</dd>
            <dt>drag ✓</dt><dd>range select (touch)</dd>
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
            <dt>m</dt><dd>move selected…</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Other</div>
          <dl>
            <dt>Enter / o</dt><dd>open preview</dd>
            <dt>i</dt><dd>metadata</dd>
            <dt>w</dt><dd>load workflow</dd>
            <dt>b</dt><dd>safe view on/off</dd>
            <dt>/</dt><dd>focus search</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>Esc</dt><dd>close (priority)</dd>
          </dl>
        </div>
      </div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn cmp-ov-primary" data-help-close>Close</button>
      </div>`;
    const closeBtn = ov.card.querySelector("[data-help-close]");
    closeBtn?.addEventListener("click", () => ov.close());
  }
  function onWindowKey(e) {
    if (modal.dialog.querySelector(".cmp-ov-backdrop"))
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
      } else if (selectMode || selected.size > 0) {
        setSelectMode(false);
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
          openFull(f);
        break;
      case "w":
        e.preventDefault();
        e.stopPropagation();
        if (f && META_EXTS.has((f.ext || "").toLowerCase()))
          loadWorkflow(f);
        break;
      case "i":
        e.preventDefault();
        e.stopPropagation();
        if (f && META_EXTS.has((f.ext || "").toLowerCase()))
          openMetadata(f);
        break;
      case "b":
        e.preventDefault();
        e.stopPropagation();
        toggleSafeView();
        break;
      case "r":
        if (f && canWriteFile(f)) {
          e.preventDefault();
          e.stopPropagation();
          onRename(f);
        }
        break;
      case "m":
        if (selected.size > 0 || f && canWriteFile(f)) {
          e.preventDefault();
          e.stopPropagation();
          doMoveSelected();
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
  async function initPins() {
    try {
      await migrateLocalPins();
      setPinCache((await fetchPins()).pins);
      renderPins();
      refreshPinButtons();
    } catch (e) {
      console.warn(`[${EXT_NAME}] pin list unavailable`, e);
    }
  }
  initPins();
  loadAndRender();
  if (savedView.recovered) {
    notify({
      severity: "warn",
      summary: "Reopened in folder view",
      detail: "The last flat-view load didn't finish, so the browser fell back to folder view."
    });
  }
  return modal;
}
function pickDestination(modal, start, exclude) {
  return new Promise((resolve) => {
    const ov = openShellOverlay(modal, { onDismiss: () => resolve(null) });
    ov.card.classList.add("ib-move-card");
    const excludeParent = exclude ? exclude.subfolder.includes("/") ? exclude.subfolder.slice(0, exclude.subfolder.lastIndexOf("/")) : "" : "";
    const inExcluded = (type, sub) => exclude !== undefined && type === exclude.type && (sub === exclude.subfolder || sub.startsWith(`${exclude.subfolder}/`));
    const remembered = loadSavedDest();
    const cur = remembered ?? {
      type: SANDBOXED_TYPES.includes(start.type) ? start.type : "output",
      subfolder: start.subfolder
    };
    const title = document.createElement("div");
    title.className = "cmp-ov-title";
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
    status.className = "cmp-ov-msg";
    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const moveHere = document.createElement("button");
    moveHere.type = "button";
    moveHere.className = "cmp-ov-btn cmp-ov-primary";
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
      const noop = exclude !== undefined && cur.type === exclude.type && cur.subfolder === excludeParent;
      moveHere.disabled = noop || inExcluded(cur.type, cur.subfolder);
      list.innerHTML = "";
      status.textContent = "Loading…";
      try {
        const data = await fetchListing({ type: cur.type, subfolder: cur.subfolder });
        if (!data.exists && cur.subfolder) {
          cur.subfolder = "";
          return load();
        }
        status.textContent = "";
        for (const p of folderPins()) {
          if (p.type === cur.type && p.subfolder === cur.subfolder)
            continue;
          if (inExcluded(p.type, p.subfolder))
            continue;
          const r = document.createElement("button");
          r.type = "button";
          r.className = "ib-move-row is-pin";
          r.dataset.pinType = p.type;
          r.dataset.pinSub = p.subfolder;
          r.textContent = `\uD83D\uDCCC ${pinLabel(p)}`;
          list.appendChild(r);
        }
        if (cur.subfolder) {
          const up = document.createElement("button");
          up.type = "button";
          up.className = "ib-move-row is-up";
          up.textContent = "↑ ..";
          list.appendChild(up);
        }
        if (!data.dirs.length && !cur.subfolder) {
          const none = document.createElement("div");
          none.className = "cmp-ov-msg";
          none.textContent = "No subfolders — move into the root above.";
          list.appendChild(none);
        }
        for (const d of data.dirs) {
          const childSub = cur.subfolder ? `${cur.subfolder}/${d.name}` : d.name;
          if (inExcluded(cur.type, childSub))
            continue;
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
      const pin = e.target.closest(".is-pin");
      if (pin) {
        const t = pin.dataset.pinType;
        if (!SANDBOXED_TYPES.includes(t))
          return;
        cur.type = t;
        cur.subfolder = pin.dataset.pinSub || "";
        load();
        return;
      }
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
var BROWSER_CSS = `
.ib-dialog {
    width: 100vw !important; height: 100vh !important; max-height: 100vh !important;
    /* Full-bleed: pin to the top-left instead of the shell's 50%/-50% centering.
       On Android, 100vh is the LARGE viewport (URL bar hidden) — while the URL
       bar is visible the dialog is taller than the visible area and centering
       shoves the header off the top of the screen. */
    top: 0 !important; left: 0 !important; transform: none !important;
    border-radius: 0;
    /* Keep the header/footer clear of notches + gesture bars in fullscreen. */
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
}
@supports (height: 100dvh) {
    /* Track the dynamic viewport (URL bar show/hide) where supported. */
    .ib-dialog { height: 100dvh !important; max-height: 100dvh !important; }
}
.image-browser-body { display: block; }
/* The pill look is shared by the root tabs and the media-type filter. Shared as
   a comma selector rather than by giving the filter segments the .ib-tab class:
   several tests count .ib-tab dialog-wide and select .ib-tab[data-type=…], so
   reusing the class would make "four tabs" quietly stop meaning four tabs. */
.ib-tabs, .ib-filter-group {
    display: flex; flex-wrap: wrap; gap: 2px; align-items: center;
    background: #1a1a22; border: 1px solid #2a2a32; border-radius: 4px; padding: 2px;
}
.ib-tab, .ib-filter-seg {
    background: transparent; color: #8a8a92; border: 0; border-radius: 3px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
    text-transform: capitalize; min-height: 32px;
}
.ib-tab:hover, .ib-filter-seg:hover { background: #2a2a36; color: #e0e0e4; }
.ib-tab.is-active, .ib-filter-seg.is-active { background: #2f3a52; color: #9ec6ff; }
/* The filter's own full-width toolbar row. The row and the pill must be two
   elements: flex-basis:100% is what breaks the line, and putting it on the pill
   would stretch its border across the whole toolbar instead of hugging the
   three segments. order:10 places it below the crumbs row (order:9 on phones)
   and above the pins row (order:11). */
.ib-filter { order: 10; flex-basis: 100%; display: flex; }
.ib-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; flex: 1; min-width: 0; }
@media (max-width: 700px) {
    /* Narrow screens: crumbs get their own full-width toolbar row. Squeezed to
       the flex leftovers, the crumb buttons overflow their container and paint
       underneath the sort dropdown. */
    .ib-crumbs { order: 9; flex-basis: 100%; }
}
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
    /* Anchor for the corner overlays (selection check / folder delete); the
       text-selection + touch-callout suppression keeps long-press clean. */
    position: relative;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
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
/* Flat-view folder label above the thumbnail — a tap jumps to that folder. */
.ib-subpath {
    display: block; width: 100%; text-align: left; box-sizing: border-box;
    padding: 5px 8px; font-size: 10px; line-height: 1.3; min-height: 26px;
    color: #8a9bb5; background: transparent; border: 0;
    border-bottom: 1px solid #2a2a32;
    white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; cursor: pointer;
}
.ib-subpath:hover { color: #9ec6ff; background: #23232e; }
.ib-subpath.is-root { color: #555; cursor: default; }
.ib-subpath.is-root:hover { background: transparent; color: #555; }
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
/* "Move here" is disabled on a folder's own parent/subtree (a no-op or illegal
   destination) — dim it so the reason for the dead button is legible. */
.ib-move-card .cmp-ov-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.cmp-match { color: #ffd866; font-weight: 700; }
.ib-card.is-focused { outline: 2px solid #6ba6ff; outline-offset: -2px; z-index: 1; }
.ib-card.is-selected { border-color: #ffd866; background: #2a2a1f; }
.ib-card.is-selected.is-focused { outline-color: #ffd866; }
/* Selection checkbox — the touch affordance for multi-select. Hidden until
   hover on fine pointers; always visible on touch, in select mode, and on
   already-selected cards. touch-action:none makes a drag starting here a
   range-select instead of a scroll. */
.ib-check {
    position: absolute; top: 4px; left: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.7); background: rgba(0, 0, 0, 0.45);
    color: transparent; font-size: 16px; line-height: 1; cursor: pointer;
    display: none; align-items: center; justify-content: center;
    touch-action: none;
}
.ib-card:hover .ib-check,
.ib-card.is-selected .ib-check,
.ib-dialog.is-selecting .ib-check { display: flex; }
@media (pointer: coarse) { .ib-check { display: flex; } }
.ib-check:hover { border-color: #ffd866; color: rgba(255, 255, 255, 0.85); }
.ib-card.is-selected .ib-check { background: #ffd866; border-color: #ffd866; color: #1a1a22; }
.ib-select-toggle.is-active { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.ib-view-toggle.is-active { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
/* Keep the selection checkbox over the thumbnail corner, below the subpath row. */
.ib-card.is-flat .ib-check { top: 30px; }
.ib-pin-toggle.is-active { background: #52452f; color: #ffd866; border-color: #78683a; }
/* Safe View's toolbar toggle. Deliberately NOT the blue "a mode is on" tint the
   flat/select toggles use — this one says "content is being withheld", and
   reading it at a glance is the whole point of having it in the toolbar rather
   than only in the settings dialog. */
.ib-safe-toggle.is-active { background: #2f3a2f; color: #8fd38f; border-color: #3f5a3f; }
/* The reveal \uD83D\uDC41 is a child of the CARD, not of the blurred thumbnail — the blur
   is a filter on .ib-thumb and would otherwise blur its own escape hatch. It
   shares the checkbox's corner, so it sits on the opposite side; both drop
   below the subpath row on flat/pinned cards for the same reason. */
.ib-card .cmk-sv-reveal { left: auto; right: 4px; }
.ib-card.is-flat .cmk-sv-reveal { top: 30px; }
/* A hidden card must not read as a hover target for its own name. */
.ib-card.is-safe-hidden .ib-name, .ib-card.is-safe-hidden .ib-subpath { cursor: default; }
/* Pinned-folder chips — a full-width toolbar row of one-tap destinations.
   order:11 keeps them last when the toolbar wraps on phones, below both the
   crumbs row (order:9) and the media-type filter row (order:10). */
.ib-pins {
    order: 11; flex-basis: 100%;
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
}
.ib-pin-chip { display: inline-flex; align-items: stretch; }
.ib-pin-go {
    background: #23283a; color: #9ec6ff; border: 1px solid #3a4560; border-right: 0;
    border-radius: 4px 0 0 4px; padding: 6px 8px; font-size: 12px; cursor: pointer;
    font-family: inherit; min-height: 32px; max-width: 45vw;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ib-pin-go:hover { background: #2f3a52; color: #fff; }
.ib-pin-chip.is-current .ib-pin-go { color: #ffd866; border-color: #78683a; }
.ib-pin-chip.is-current .ib-pin-x { border-color: #78683a; }
.ib-pin-x {
    background: #23283a; color: #667; border: 1px solid #3a4560;
    border-radius: 0 4px 4px 0; padding: 6px 8px; font-size: 11px; cursor: pointer;
    font-family: inherit; min-height: 32px; min-width: 28px;
}
.ib-pin-x:hover { background: #5c2a3c; color: #ff9eb0; }
.ib-move-row.is-pin { color: #9ec6ff; }
/* Per-card \uD83D\uDCCC — filled while the file is pinned, matching the toolbar toggle's
   active look so "pinned" reads the same in both places. */
.ib-act-pin.is-pinned { background: #52452f; color: #ffd866; border-color: #78683a; }
/* Per-card \uD83D\uDE48 — filled while the file carries the keyword, same "this state is
   on" language as \uD83D\uDCCC above, in the warning hue the Safe View toggle uses.
   It lives in .ib-actions, a SIBLING of .ib-thumb, so the blur applied to a
   matched thumbnail never reaches it — marking a file must not blur the control
   that unmarks it. A class rule with no min()/calc(), so getComputedStyle can
   read it in jsdom. */
.ib-act-mark.is-marked { background: #4a2530; color: #ff9eb0; border-color: #7a4a58; }
.ib-act-mark:disabled { cursor: progress; opacity: 0.5; }
/* A pin whose target is gone. Dimmed rather than hidden: "the file moved" and
   "you never pinned it" are different facts, so the card stays — with only its
   unpin affordance — until it is pruned. */
.ib-card.is-missing { opacity: 0.45; }
.ib-card.is-missing:hover { border-color: #78384a; transform: none; }
.ib-card.is-missing .ib-meta { color: #c07a8a; font-style: italic; }
.ib-prune { white-space: nowrap; }
.ib-scan-pill { white-space: nowrap; color: #c8b06a; border-color: #4a4230; }
/* Folder delete — corner overlay on dir cards (write-gated). */
.ib-dir-del {
    position: absolute; top: 4px; right: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.45);
    color: #b8b8c0; font-size: 14px; line-height: 1; cursor: pointer;
}
.ib-dir-del:hover { background: #5c2a3c; color: #ff9eb0; }
/* Folder move — corner overlay on dir cards, mirroring the delete button on the
   opposite side (write-gated). */
.ib-dir-move {
    position: absolute; top: 4px; left: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.45);
    color: #b8b8c0; font-size: 14px; line-height: 1; cursor: pointer;
}
.ib-dir-move:hover { background: #3a3a4a; color: #fff; }
/* Floating batch-action bar — appears while a selection exists. */
.ib-selbar {
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: calc(52px + env(safe-area-inset-bottom, 0px));
    z-index: 4; display: none; align-items: center; gap: 8px;
    max-width: calc(100% - 16px); white-space: nowrap;
    background: #1c1c24; border: 1px solid #3a3a44; border-radius: 24px;
    padding: 8px 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.ib-selbar.is-visible { display: flex; }
.ib-selbar-count { font-size: 12.5px; font-weight: 600; color: #9ec6ff; padding: 0 4px; }
.ib-selbar-btn {
    background: #2a2a36; color: #d8d8dc; border: 1px solid #3a3a44; border-radius: 16px;
    padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: inherit; min-height: 38px;
}
.ib-selbar-btn:hover { background: #3a3a4a; color: #fff; }
.ib-selbar-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.ib-selbar-danger:hover { background: #5c2a3c; color: #fff; }
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
/* Metadata overlay (the ⓘ card). The ib-meta-* namespace is distinct from the
   card's own .ib-meta dimensions line — class selectors match whole tokens, so
   .ib-meta never catches .ib-meta-row and vice versa. */
.ib-meta-card { width: min(680px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ib-meta-body {
    display: flex; flex-direction: column; gap: 8px;
    overflow-y: auto; padding: 8px 0; -webkit-overflow-scrolling: touch;
}
.ib-meta-status { padding: 14px 2px; font-size: 12.5px; color: #888; font-style: italic; }
.ib-meta-src {
    display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; color: #9ec6ff;
    text-transform: uppercase; letter-spacing: 0.5px;
}
.ib-meta-fmt { color: #777; text-transform: none; letter-spacing: 0; }
.ib-meta-row { display: grid; grid-template-columns: 84px 1fr auto; gap: 8px; align-items: start; }
.ib-meta-k {
    padding-top: 7px; font-size: 11px; color: #8a8a92;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.ib-meta-v {
    /* A long positive prompt scrolls inside its own box instead of pushing the
       Copy buttons and the overlay actions off the card. Selectable: the card is
       a reading surface, unlike the grid (which suppresses selection for
       long-press). */
    max-height: 7.5em; overflow-y: auto;
    padding: 6px 8px; font-size: 12px; line-height: 1.45; color: #d8d8dc;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
.ib-meta-copy {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 0 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-meta-copy:hover { background: #3a3a4a; color: #fff; }
.ib-meta-copy.is-copied { background: #25402f; color: #8fe0a8; border-color: #37624a; }
.ib-meta-empty { padding: 16px 2px; font-size: 12.5px; color: #777; font-style: italic; }
.ib-meta-note { font-size: 11.5px; color: #c8a95c; }
.ib-meta-raw > summary {
    padding: 7px 0; font-size: 12px; color: #9ec6ff; cursor: pointer; min-height: 32px;
}
.ib-meta-raw pre {
    margin: 4px 0 8px; padding: 8px; max-height: 30vh; overflow: auto;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-size: 11px; color: #b8b8c0; white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
@media (max-width: 600px) {
    /* Stack the label above the value — an 84px gutter leaves the prompt column
       unreadably narrow on a phone. */
    .ib-meta-row { grid-template-columns: 1fr auto; }
    .ib-meta-k { grid-column: 1 / -1; padding-top: 0; }
}
`;

// src/rating-cache.ts
var RATINGS_URL = "/image_browser/ratings";
var MAX_BATCH = 200;
var ratingCache = new Map;
var requested = new Set;
function clearRatingState() {
  ratingCache.clear();
  requested.clear();
}
function addressKey(a) {
  return `${a.type} ${a.subfolder} ${a.name}`;
}
function parseAssetAddress(src) {
  if (!src)
    return null;
  let url;
  try {
    url = new URL(src, "http://localhost");
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/api/view"))
    return null;
  const name = url.searchParams.get("filename");
  if (!name)
    return null;
  const type = url.searchParams.get("type") || "input";
  if (!SANDBOXED_TYPES.includes(type))
    return null;
  return { type, subfolder: url.searchParams.get("subfolder") || "", name, absDir: "" };
}
async function fetchRatings(addrs) {
  const res = await fetch(RATINGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: addrs.map((a) => ({ type: a.type, subfolder: a.subfolder, name: a.name }))
    })
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.ratings))
    throw new Error(data.error || "bad response");
  return data.ratings;
}

// src/lightbox-actions.ts
var STYLE_ID6 = "ib-lightbox-actions-style";
var BAR_CLASS = "ibl-bar";
var ROW_CLASS = "ibl-stars";
var DEL_CLASS = "ibl-del";
var KEY_ATTR = "data-ibl";
var SETTLE_MS = 80;
var LIGHTBOX_SELECTOR = '[role="dialog"][aria-modal="true"][data-mask]';
var deleted = new Set;
var readToken = 0;
var REVEAL_CLASS = "ibl-reveal";
var lightboxRevealed = new Set;
function activeAddress(dialog) {
  for (const el of dialog.querySelectorAll("img, video, audio, source")) {
    const addr = parseAssetAddress(el.getAttribute("src"));
    if (addr)
      return addr;
  }
  return null;
}
function hasMultipleItems(dialog) {
  return !!dialog.querySelector('[class*="chevron-right"]');
}
function sendKey(dialog, key) {
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}
function confirmInLightbox(dialog, name) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "ibl-ov";
    backdrop.innerHTML = `
<div class="ibl-ov-card">
  <div class="ibl-ov-title">Delete file?</div>
  <div class="ibl-ov-msg"></div>
  <div class="ibl-ov-actions">
    <button type="button" class="ibl-ov-btn" data-act="cancel">Cancel</button>
    <button type="button" class="ibl-ov-btn ibl-ov-danger" data-act="ok">Delete</button>
  </div>
</div>`;
    const msg = backdrop.querySelector(".ibl-ov-msg");
    msg.textContent = `${name} will be permanently deleted from disk. This cannot be undone.`;
    let done = false;
    const finish = (v) => {
      if (done)
        return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    };
    backdrop.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.getAttribute("data-act");
      if (act) {
        e.stopPropagation();
        finish(act === "ok");
      } else if (e.target === backdrop) {
        finish(false);
      }
    });
    document.addEventListener("keydown", onKey, true);
    dialog.appendChild(backdrop);
    backdrop.querySelector('[data-act="ok"]')?.focus();
  });
}
async function runDelete(dialog, addr) {
  if (!await confirmInLightbox(dialog, addr.name))
    return;
  const advance = hasMultipleItems(dialog);
  try {
    await deleteFile(addr.type, addr.subfolder, addr.name);
  } catch (err) {
    notify({
      severity: "error",
      summary: "Delete failed",
      detail: `${addr.name}: ${err instanceof Error ? err.message : String(err)}`
    });
    return;
  }
  const key = addressKey(addr);
  deleted.add(key);
  ratingCache.delete(key);
  notify({ severity: "success", summary: "Deleted", detail: addr.name });
  sendKey(dialog, advance ? "ArrowRight" : "Escape");
}
function installLightboxActions() {
  ensureStyleOnce(STYLE_ID6, `
.${BAR_CLASS} {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 10; display: flex; align-items: center; gap: 18px;
  padding: 8px 14px; border-radius: 999px;
  background: rgba(20, 20, 26, 0.82); border: 1px solid #33333f;
  backdrop-filter: blur(6px); user-select: none; touch-action: manipulation;
}
.${ROW_CLASS} { display: flex; gap: 2px; }
.${ROW_CLASS} button {
  background: none; border: 0; padding: 2px 4px; cursor: pointer; line-height: 1;
  /* Deliberately larger than the sidebar's 13px row: this is the tap target
     you use one-handed while flicking through a batch. */
  font-size: 26px; min-width: 34px; min-height: 34px; color: #55555f;
}
.${ROW_CLASS} button.is-on { color: #ffb02e; }
.${ROW_CLASS} button:hover { color: #ffc95e; }
.${DEL_CLASS} {
  background: #4a2230; border: 1px solid #78384a; color: #ff9eb0;
  font: inherit; font-size: 15px; border-radius: 8px; cursor: pointer;
  min-width: 44px; min-height: 34px; padding: 0 12px;
}
.${DEL_CLASS}:hover { background: #5c2a3c; color: #fff; }
.ibl-note { color: #b8b8c0; font-size: 13px; padding: 0 6px; }
.ibl-ov {
  position: absolute; inset: 0; z-index: 20; display: flex;
  align-items: center; justify-content: center; padding: 16px;
  background: rgba(0, 0, 0, 0.6); touch-action: manipulation;
}
.ibl-ov-card {
  background: #1c1c24; border: 1px solid #33333f; border-radius: 10px;
  padding: 18px; width: min(460px, calc(100% - 24px));
  display: flex; flex-direction: column; gap: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.ibl-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.ibl-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.ibl-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ibl-ov-btn {
  font-size: 13px; padding: 9px 16px; border-radius: 6px; min-height: 38px;
  border: 1px solid #3a3a44; background: #2a2a36; color: #d8d8dc;
  cursor: pointer; font-family: inherit;
}
.ibl-ov-btn:hover { background: #3a3a4a; color: #fff; }
.ibl-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.ibl-ov-danger:hover { background: #5c2a3c; color: #fff; }
`);
  let timer = null;
  let disposed = false;
  const onClick = (e) => {
    const target = e.target;
    const bar = target?.closest?.(`.${BAR_CLASS}`);
    if (!bar)
      return;
    const dialog = bar.closest(LIGHTBOX_SELECTOR);
    const addr = dialog ? activeAddress(dialog) : null;
    if (!dialog || !addr || deleted.has(addressKey(addr)))
      return;
    if (target?.closest(`.${DEL_CLASS}`)) {
      e.preventDefault();
      e.stopPropagation();
      runDelete(dialog, addr);
      return;
    }
    const star = target?.closest(`.${ROW_CLASS} [data-val]`);
    const row = bar.querySelector(`.${ROW_CLASS}`);
    if (!star || !row)
      return;
    e.preventDefault();
    e.stopPropagation();
    const prev = Number(row.dataset.rating || "0");
    const next = nextRating(prev, Number(star.dataset.val));
    applyStars(row, next);
    postRating(RATING_URL, addr, next).then((confirmed) => {
      ratingCache.set(addressKey(addr), confirmed);
      applyStars(row, confirmed);
    }).catch((err) => {
      ratingCache.set(addressKey(addr), prev);
      applyStars(row, prev);
      notify({
        severity: "error",
        summary: "Rating failed",
        detail: `${addr.name}: ${err instanceof Error ? err.message : String(err)}`
      });
    });
  };
  document.addEventListener("click", onClick, true);
  function paint() {
    const dialog = document.querySelector(LIGHTBOX_SELECTOR);
    if (!dialog)
      return;
    const addr = activeAddress(dialog);
    applySafeView(dialog, addr);
    const existing = dialog.querySelector(`.${BAR_CLASS}`);
    if (!addr) {
      existing?.remove();
      return;
    }
    const key = addressKey(addr);
    let bar = existing;
    if (bar && bar.getAttribute(KEY_ATTR) === key) {
      const known = ratingCache.get(key);
      const row2 = bar.querySelector(`.${ROW_CLASS}`);
      if (row2 && typeof known === "number")
        applyStars(row2, known);
      return;
    }
    bar?.remove();
    bar = document.createElement("div");
    bar.className = BAR_CLASS;
    bar.setAttribute(KEY_ATTR, key);
    bar.setAttribute("draggable", "false");
    if (deleted.has(key)) {
      const note = document.createElement("div");
      note.className = "ibl-note";
      note.textContent = "Deleted — reopen the sidebar to refresh this list";
      bar.appendChild(note);
      dialog.appendChild(bar);
      return;
    }
    const holder = document.createElement("div");
    holder.innerHTML = starsHTML("ibl", ratingCache.get(key) ?? 0);
    const row = holder.firstElementChild;
    if (!row)
      return;
    row.classList.add(ROW_CLASS);
    const del = document.createElement("button");
    del.type = "button";
    del.className = DEL_CLASS;
    del.title = "Delete this file from disk";
    del.setAttribute("aria-label", "Delete file");
    del.textContent = "\uD83D\uDDD1";
    bar.append(row, del);
    dialog.appendChild(bar);
    const token = ++readToken;
    fetchRatings([addr]).then(([r]) => {
      if (disposed || token !== readToken)
        return;
      if (typeof r !== "number")
        return;
      ratingCache.set(key, r);
      const live = document.querySelector(`${LIGHTBOX_SELECTOR} .${BAR_CLASS}[${KEY_ATTR}="${CSS.escape(key)}"] .${ROW_CLASS}`);
      if (live)
        applyStars(live, r);
    }).catch((err) => {
      console.warn(`[${EXT_NAME}] lightbox rating read failed`, err);
    });
  }
  function applySafeView(dialog, addr) {
    for (const el of dialog.querySelectorAll(`.${SAFE_VIEW_BLUR_CLASS}`))
      setBlurred(el, false);
    for (const el of dialog.querySelectorAll(`.${REVEAL_CLASS}`))
      el.remove();
    if (!addr)
      return;
    const key = addressKey(addr);
    if (lightboxRevealed.has(key))
      return;
    const cfg = readSafeViewConfig();
    if (!isSensitive({ name: addr.name, path: `${addr.type}/${addr.subfolder}` }, cfg))
      return;
    for (const el of dialog.querySelectorAll("img, video"))
      setBlurred(el, true);
    const btn = makeRevealButton({
      onReveal: () => {
        lightboxRevealed.add(key);
        applySafeView(dialog, addr);
      }
    });
    btn.classList.add(REVEAL_CLASS);
    dialog.appendChild(btn);
  }
  function schedule() {
    if (disposed)
      return;
    if (timer !== null)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        paint();
      } catch (err) {
        console.warn(`[${EXT_NAME}] lightbox pass failed`, err);
      }
    }, SETTLE_MS);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"]
  });
  const disposeSafeView = onSafeViewChange(schedule);
  schedule();
  return () => {
    disposed = true;
    if (timer !== null)
      clearTimeout(timer);
    observer.disconnect();
    disposeSafeView();
    document.removeEventListener("click", onClick, true);
    for (const el of document.querySelectorAll(`.${BAR_CLASS}, .ibl-ov, .${REVEAL_CLASS}`)) {
      el.remove();
    }
    for (const el of document.querySelectorAll(`.${SAFE_VIEW_BLUR_CLASS}`))
      setBlurred(el, false);
  };
}

// src/scan-warm.ts
import { app as app2 } from "/scripts/app.js";
var MEDIA_KEYS = ["images", "video"];
function itemsFromExecuted(detail) {
  const output = detail?.output;
  if (!output || typeof output !== "object")
    return [];
  const out = [];
  const seen = new Set;
  for (const key of MEDIA_KEYS) {
    const arr = output[key];
    if (!Array.isArray(arr))
      continue;
    for (const raw of arr) {
      const item = raw;
      const filename = item?.filename;
      const type = item?.type;
      if (typeof filename !== "string" || filename === "")
        continue;
      if (typeof type !== "string" || !SANDBOXED_TYPES.includes(type))
        continue;
      const subfolder = typeof item?.subfolder === "string" ? item.subfolder : "";
      const id = `${type}:${subfolder}:${filename}`;
      if (seen.has(id))
        continue;
      seen.add(id);
      out.push({ type, subfolder, name: filename });
    }
  }
  return out;
}
function installScanWarm(host) {
  const api = app2.api;
  if (!api || typeof api.addEventListener !== "function")
    return () => {};
  const onExecuted = (event) => {
    const cfg = host ? readSafeViewConfig(host) : readSafeViewConfig();
    if (!cfg.matchPrompt)
      return;
    const items = itemsFromExecuted(event.detail);
    if (items.length === 0)
      return;
    warmSafeView(items).catch((e) => {
      console.warn(`[${EXT_NAME}] ${SAFE_VIEW_SETTINGS.matchPrompt} warm failed`, e);
    });
  };
  api.addEventListener("executed", onExecuted);
  return () => api.removeEventListener("executed", onExecuted);
}

// src/sidebar-stars.ts
var STYLE_ID7 = "ib-sidebar-stars-style";
var ROW_CLASS2 = "ibs-stars";
var DONE_ATTR = "data-ibs";
var SETTLE_MS2 = 120;
var CARD_SELECTOR = "[data-selected]";
function cardRootOf(img) {
  return img.closest(CARD_SELECTOR);
}
var SAFE_CARD_CLASS = "ibs-safe-hidden";
function applyCardSafeView(card, addr, cfg) {
  for (const el of card.querySelectorAll(`.${SAFE_VIEW_SPOILER_CLASS}`))
    setSpoilered(el, false);
  for (const el of card.querySelectorAll(`.${SAFE_VIEW_BLUR_CLASS}`))
    setBlurred(el, false);
  card.classList.remove(SAFE_CARD_CLASS);
  if (!isSensitive({ name: addr.name, path: `${addr.type}/${addr.subfolder}` }, cfg))
    return;
  card.classList.add(SAFE_CARD_CLASS);
  for (const el of card.querySelectorAll("img, video"))
    setBlurred(el, true);
  if (!cfg.blurNames)
    return;
  for (const el of card.querySelectorAll("*")) {
    if (el.textContent?.trim() === addr.name && !el.querySelector("*"))
      setSpoilered(el, true);
  }
}
function installSidebarStars() {
  clearRatingState();
  ensureStyleOnce(STYLE_ID7, `
.${ROW_CLASS2} { display: flex; gap: 1px; justify-content: center; padding: 2px 0 0; }
.${ROW_CLASS2} button {
  background: none; border: 0; padding: 0 1px; cursor: pointer; line-height: 1;
  /* Big enough to hit on a phone without stretching the stock card's row. */
  font-size: 13px; min-width: 16px; color: #55555f;
}
.${ROW_CLASS2} button.is-on { color: #ffb02e; }
.${ROW_CLASS2} button:hover { color: #ffc95e; }
/* The stock card sets draggable=true; a drag started on a star must not
   detach the card, and the row must never become a drag handle. */
.${ROW_CLASS2} { -webkit-user-drag: none; user-select: none; touch-action: manipulation; }
`);
  let timer = null;
  let disposed = false;
  const onClick = (e) => {
    const target = e.target;
    const star = target?.closest?.(`.${ROW_CLASS2} [data-val]`);
    if (!star)
      return;
    const row = star.closest(`.${ROW_CLASS2}`);
    const card = row ? cardRootOf(row) : null;
    const img = card?.querySelector("img");
    const addr = parseAssetAddress(img?.getAttribute("src"));
    if (!row || !addr)
      return;
    e.preventDefault();
    e.stopPropagation();
    const prev = Number(row.dataset.rating || "0");
    const next = nextRating(prev, Number(star.dataset.val));
    applyStars(row, next);
    postRating(RATING_URL, addr, next).then((confirmed) => {
      ratingCache.set(addressKey(addr), confirmed);
      applyStars(row, confirmed);
    }).catch((err) => {
      ratingCache.set(addressKey(addr), prev);
      applyStars(row, prev);
      notify({
        severity: "error",
        summary: "Rating failed",
        detail: `${addr.name}: ${err instanceof Error ? err.message : String(err)}`
      });
    });
  };
  document.addEventListener("click", onClick, true);
  function paint() {
    const pending = [];
    const safeCfg = readSafeViewConfig();
    for (const img of document.querySelectorAll(`${CARD_SELECTOR} img`)) {
      const addr = parseAssetAddress(img.getAttribute("src"));
      if (!addr)
        continue;
      const card = cardRootOf(img);
      if (!card)
        continue;
      applyCardSafeView(card, addr, safeCfg);
      const key = addressKey(addr);
      const known = ratingCache.get(key);
      let row = card.querySelector(`.${ROW_CLASS2}`);
      if (row && card.getAttribute(DONE_ATTR) !== key) {
        row.remove();
        row = null;
      }
      if (!row) {
        const holder = document.createElement("div");
        holder.innerHTML = starsHTML("ibs", known ?? 0);
        row = holder.firstElementChild;
        if (!row)
          continue;
        row.classList.add(ROW_CLASS2);
        row.setAttribute("draggable", "false");
        card.appendChild(row);
        card.setAttribute(DONE_ATTR, key);
      }
      if (known === undefined) {
        if (!requested.has(key) && pending.length < MAX_BATCH) {
          requested.add(key);
          pending.push(addr);
        }
      } else {
        applyStars(row, known);
      }
    }
    if (!pending.length)
      return;
    fetchRatings(pending).then((ratings) => {
      pending.forEach((addr, i) => {
        const r = ratings[i];
        if (typeof r === "number")
          ratingCache.set(addressKey(addr), r);
        else
          requested.delete(addressKey(addr));
      });
      if (!disposed)
        schedule();
    }).catch((err) => {
      for (const a of pending)
        requested.delete(addressKey(a));
      console.warn(`[${EXT_NAME}] sidebar rating read failed`, err);
    });
  }
  function schedule() {
    if (disposed)
      return;
    if (timer !== null)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        paint();
      } catch (err) {
        console.warn(`[${EXT_NAME}] sidebar star pass failed`, err);
      }
    }, SETTLE_MS2);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"]
  });
  const disposeSafeView = onSafeViewChange(schedule);
  schedule();
  return () => {
    disposed = true;
    if (timer !== null)
      clearTimeout(timer);
    observer.disconnect();
    disposeSafeView();
    document.removeEventListener("click", onClick, true);
    for (const row of document.querySelectorAll(`.${ROW_CLASS2}`))
      row.remove();
    for (const card of document.querySelectorAll(`[${DONE_ATTR}]`))
      card.removeAttribute(DONE_ATTR);
    for (const el of document.querySelectorAll(`.${SAFE_VIEW_SPOILER_CLASS}`)) {
      setSpoilered(el, false);
    }
    for (const el of document.querySelectorAll(`.${SAFE_VIEW_BLUR_CLASS}`))
      setBlurred(el, false);
    for (const el of document.querySelectorAll(`.${SAFE_CARD_CLASS}`)) {
      el.classList.remove(SAFE_CARD_CLASS);
    }
  };
}

// src/index.ts
function openShell() {
  return openImageBrowser();
}
var uninstallSidebarStars = null;
var uninstallLightboxActions = null;
var entry = makeHubEntry({
  id: "image-browser.open",
  label: "Image Browser",
  icon: "pi pi-images",
  tooltip: "Browse & manage input/output images",
  description: "Browse & manage input/output images",
  failSummary: "Image Browser failed to open",
  open: openImageBrowser,
  priority: 10
});
app3.registerExtension({
  name: "comfy.image-browser",
  settings: [
    ...safeViewSettings(),
    {
      id: "ImageBrowser.SidebarStars",
      category: ["Touch Tools", "Image Browser", "Star ratings"],
      sortOrder: 100,
      name: "Star ratings on stock Media Assets cards",
      tooltip: "Adds a 0–5 star row to ComfyUI's own Media Assets sidebar cards, written to the image's XMP — the same rating the Image Browser shows. Injected into stock UI (ComfyUI exposes no extension point for asset cards), so switch this off if a frontend update makes it misbehave.",
      type: "boolean",
      defaultValue: true,
      onChange: (value) => {
        if (value && !uninstallSidebarStars) {
          uninstallSidebarStars = installSidebarStars();
        } else if (!value && uninstallSidebarStars) {
          uninstallSidebarStars();
          uninstallSidebarStars = null;
        }
      }
    },
    {
      id: "ImageBrowser.LightboxActions",
      category: ["Touch Tools", "Image Browser", "Lightbox actions"],
      sortOrder: 90,
      name: "Rate & delete in the asset lightbox",
      tooltip: "Adds a star row and a delete button to ComfyUI's full-screen asset viewer (Media Assets sidebar → Inspect asset), so you can arrow through fresh generations and rate or bin each one. Deleting advances to the next item; the sidebar's own list only drops the deleted entry when it reloads. Injected into stock UI (ComfyUI exposes no extension point for the lightbox), so switch this off if a frontend update makes it misbehave.",
      type: "boolean",
      defaultValue: true,
      onChange: (value) => {
        if (value && !uninstallLightboxActions) {
          uninstallLightboxActions = installLightboxActions();
        } else if (!value && uninstallLightboxActions) {
          uninstallLightboxActions();
          uninstallLightboxActions = null;
        }
      }
    }
  ],
  ...entry,
  ...installHubButton(),
  setup() {
    registerHubEntry(entry.hubEntry);
    registerSafeViewHubToggle();
    installScanWarm();
  }
});
export {
  openShell
};
