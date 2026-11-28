// dock.ts — side-panel ("docked") mode for the Image Browser (issue #112).
//
// The browser is a full-viewport modal that stands in for the canvas. Docked,
// the same shell parks at the right edge at a user-chosen width, its backdrop
// is hidden, and the canvas beside it stays live — so a desktop user can keep
// the workflow and the browser open together.
//
// Why dock the existing shell rather than mount into a ComfyUI sidebar tab:
// every overlay (confirm, rename, move picker, metadata, lightbox), the key
// handling and the scroll restore are built on the kit's ModalShellController,
// and the kit's openModalShell can only mount to <body>. A sidebar tab would
// need a container-mount option in @laurigates/comfy-modal-kit first.
//
// The one load-bearing behaviour is KEY OWNERSHIP. Both the shell's handler
// (Esc closes) and the browser's window handler (j/k, `d d` deletes) listen in
// the capture phase at document/window level, which is right for a modal that
// covers everything and wrong for a panel beside a live canvas: Esc pressed
// while working on the graph would close the browser, and `d d` would delete
// the focused card. So docked, the browser owns keys only while the user's
// last pointer landed inside it. Focus cannot decide this: re-rendering the
// grid after a click leaves document.activeElement on <body>.
//
// The shell's handler is gated by REPLACING `modal._onKey` with a wrapper.
// Every kit overlay hands the handler back by reading `shell._onKey` when it
// closes, so the wrapper is what they restore and the gate survives them. The
// kit's own teardown removes the ORIGINAL closure, not the property, which is
// why dispose() must remove the wrapper itself.
//
// The second thing docking has to defeat is the kit's POINTER GUARD: a
// window-level capture listener that dismisses the active modal on any
// pointerdown outside its `element`. Docked, every click on the canvas is
// outside the dialog, so the first one would close the browser. The guard
// reads `element` off the handle registered for this shell and nothing else
// does, so while docked that property answers the whole document. It is a
// getter, so a window narrowed below DOCK_QUERY (where the docked browser
// renders full-screen again) gets the ordinary outside-click behaviour back.
// Single-modal discipline is untouched: another kit modal opening still
// dismisses this one through the coordinator.

import { getActiveModal, type ModalShellController } from "@laurigates/comfy-modal-kit";

export const DOCK_STORAGE_KEY = "comfyui-image-browser:dock";

/** Docking applies at this viewport width and above; below it the browser is full-screen. */
const DOCK_QUERY = "(min-width: 900px)";

/** Narrowest useful panel: the phone layout the browser was built for. */
export const DOCK_MIN_WIDTH = 360;
const DOCK_DEFAULT_WIDTH = 480;
/** Canvas strip always left visible beside the panel. */
const DOCK_CANVAS_RESERVE = 320;

interface DockPref {
  docked: boolean;
  width: number;
}

export function clampDockWidth(px: number, viewport: number): number {
  if (!Number.isFinite(px)) return DOCK_MIN_WIDTH;
  const max = Math.max(DOCK_MIN_WIDTH, viewport - DOCK_CANVAS_RESERVE);
  return Math.round(Math.min(Math.max(px, DOCK_MIN_WIDTH), max));
}

function loadPref(): DockPref {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) || "null");
    if (raw && typeof raw === "object") {
      return {
        docked: raw.docked === true,
        width: typeof raw.width === "number" ? raw.width : DOCK_DEFAULT_WIDTH,
      };
    }
  } catch {
    /* corrupt or blocked storage — defaults below */
  }
  return { docked: false, width: DOCK_DEFAULT_WIDTH };
}

function savePref(p: DockPref): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* non-fatal */
  }
}

function wideEnough(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DOCK_QUERY).matches;
}

interface DockController {
  /** Docked AND on a viewport wide enough for it to render as a panel. */
  isDocked: () => boolean;
  /** False while docked and the user's last pointer landed outside the browser. */
  ownsKeys: () => boolean;
  dispose: () => void;
}

export function installDock(modal: ModalShellController): DockController {
  const pref = loadPref();
  const { dialog, backdrop } = modal;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ib-dock-toggle";
  const handle = document.createElement("div");
  handle.className = "ib-dock-handle";
  handle.setAttribute("aria-hidden", "true");
  dialog.appendChild(handle);
  modal.headerEl.insertBefore(btn, modal.headerEl.querySelector(".cmp-close"));

  function apply(): void {
    dialog.classList.toggle("is-docked", pref.docked);
    backdrop.classList.toggle("ib-dock-backdrop", pref.docked);
    dialog.style.setProperty("--ib-dock-w", `${clampDockWidth(pref.width, window.innerWidth)}px`);
    btn.textContent = pref.docked ? "⤢" : "⇥";
    btn.title = pref.docked ? "Full screen" : "Dock to the side (keep the canvas usable)";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(pref.docked));
  }
  apply();

  btn.addEventListener("click", () => {
    pref.docked = !pref.docked;
    savePref(pref);
    apply();
  });

  // Resize by dragging the panel's left edge. Saved on release, not per move.
  let dragFrom: { x: number; w: number } | null = null;
  handle.addEventListener("pointerdown", (e) => {
    dragFrom = { x: e.clientX, w: clampDockWidth(pref.width, window.innerWidth) };
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragFrom) return;
    pref.width = clampDockWidth(dragFrom.w + (dragFrom.x - e.clientX), window.innerWidth);
    dialog.style.setProperty("--ib-dock-w", `${pref.width}px`);
  });
  const endDrag = (): void => {
    if (!dragFrom) return;
    dragFrom = null;
    savePref(pref);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  const isDocked = (): boolean => pref.docked && wideEnough();

  // Whose keys: decided by where the last pointer landed. Capture phase, so
  // the shell's own stopPropagation on the dialog cannot hide it.
  let inside = true;
  const onPointer = (e: Event): void => {
    inside = dialog.contains(e.target as Node);
  };
  document.addEventListener("pointerdown", onPointer, true);

  const ownsKeys = (): boolean => !isDocked() || inside;

  // Only the handle this shell registered; anything else is not ours to bend.
  const active = getActiveModal();
  const modalHandle = active && active.element === dialog ? active : null;
  if (modalHandle) {
    Object.defineProperty(modalHandle, "element", {
      configurable: true,
      enumerable: true,
      get: () => (isDocked() ? document.documentElement : dialog),
    });
  }

  const original = modal._onKey;
  const gated = (e: KeyboardEvent): void => {
    if (ownsKeys()) original(e);
  };
  document.removeEventListener("keydown", original, true);
  modal._onKey = gated;
  document.addEventListener("keydown", gated, true);

  return {
    isDocked,
    ownsKeys,
    dispose() {
      if (modalHandle) {
        Object.defineProperty(modalHandle, "element", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: dialog,
        });
      }
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", gated, true);
      document.removeEventListener("keydown", original, true);
    },
  };
}

export const DOCK_CSS = `
.ib-dock-toggle, .ib-dock-handle { display: none; }
@media ${DOCK_QUERY} {
    .ib-dock-toggle {
        display: inline-flex; align-items: center; justify-content: center;
        width: 44px; height: 44px; flex-shrink: 0; margin-right: 6px;
        background: transparent; color: #aaa; border: 1px solid #3a3a44; border-radius: 4px;
        font-size: 18px; line-height: 1; cursor: pointer; font-family: inherit;
    }
    .ib-dock-toggle:hover { background: #2a2a32; color: #fff; }
    .ib-dock-toggle[aria-pressed="true"] { border-color: #6ba6ff; color: #fff; }
    .ib-dialog.is-docked {
        left: auto !important; right: 0 !important;
        width: var(--ib-dock-w, 480px) !important;
        box-sizing: border-box;
        border-left: 1px solid #3a3a44;
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.45);
    }
    .cmp-backdrop.ib-dock-backdrop { display: none; }
    .ib-dialog.is-docked .ib-dock-handle {
        display: block; position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
        cursor: ew-resize; z-index: 7; touch-action: none;
    }
    .ib-dialog.is-docked .ib-dock-handle:hover { background: rgba(107, 166, 255, 0.35); }
}
`;
