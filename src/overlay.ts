// overlay.ts — lightweight in-dialog overlays (confirm / text prompt / custom).
//
// The modal-kit shell enforces single-modal discipline: opening a second
// openModalShell would dismiss the browser. So secondary prompts (delete
// confirm, rename input, the move-destination picker) render as an absolutely
// positioned overlay INSIDE the browser dialog element, self-contained and
// touch-first (16px inputs, big tap targets).

import type { ModalShellController } from "@laurigates/comfy-modal-kit";

interface OverlayHandle {
  /** The card element to append custom content into. */
  card: HTMLElement;
  /** Tear down the overlay. */
  close: () => void;
}

// Opens a bare overlay over the shell's dialog and returns its content card + a
// closer. ESC and a backdrop tap both invoke onDismiss (if given) then close.
//
// While the overlay is up we SUSPEND the shell's own ESC handler: the shell
// binds `document` keydown in the capture phase at open time, so it would
// otherwise fire first and close the whole browser instead of just the overlay.
// We remove it on open and restore it on close.
export function openOverlay(modal: ModalShellController, onDismiss?: () => void): OverlayHandle {
  const host = modal.dialog;
  const backdrop = document.createElement("div");
  backdrop.className = "ib-ov-backdrop";

  const card = document.createElement("div");
  card.className = "ib-ov-card";
  backdrop.appendChild(card);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };

  function close(): void {
    document.removeEventListener("keydown", onKey, true);
    // Restore the shell's ESC handler (it was the only other capture listener).
    document.addEventListener("keydown", modal._onKey, true);
    backdrop.remove();
  }
  function dismiss(): void {
    onDismiss?.();
    close();
  }

  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.removeEventListener("keydown", modal._onKey, true);
  document.addEventListener("keydown", onKey, true);

  host.appendChild(backdrop);
  return { card, close };
}

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function confirmAction(modal: ModalShellController, opts: ConfirmOpts): Promise<boolean> {
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

interface PromptOpts {
  title: string;
  label?: string;
  value?: string;
  confirmLabel?: string;
  /** Return an error string to block submit, or null when valid. */
  validate?: (v: string) => string | null;
}

export function promptText(modal: ModalShellController, opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const ov = openOverlay(modal, () => resolve(null));
    const h = document.createElement("div");
    h.className = "ib-ov-title";
    h.textContent = opts.title;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "ib-ov-input";
    input.value = opts.value || "";
    if (opts.label) input.setAttribute("aria-label", opts.label);

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

    function submit(): void {
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

export const OVERLAY_CSS = `
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
