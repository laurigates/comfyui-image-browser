// @vitest-environment jsdom
//
// The toolbar ⬆︎ upload control (#105). Two things are asserted here:
//
// 1. The WRITE-GATE MIRROR. /image_browser/upload rejects type=path like every
//    other write (ADR-0002), so the control must be absent on browse…/path —
//    and on the pinned tab, which is not a directory at all. Each visibility
//    assertion is paired with the control being PRESENT on a sandboxed tab in
//    the same test: a "hidden" check alone passes against a control that never
//    renders anywhere.
// 2. The REQUEST CONTRACT the backend reads: multipart with `type` and
//    `subfolder` BEFORE the file parts, the X-Image-Browser-Upload header, and
//    NO hand-set Content-Type (the browser must write the multipart boundary;
//    a hand-set `multipart/form-data` without one is a body the server cannot
//    parse). tests/test_upload.py pins the server side of the same contract.
//
// jsdom cannot open a file picker, so selecting files is simulated the way the
// browser delivers them: the input's `files` list is set and `change` fires on
// the input itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openShell } from "../../src/index.ts";

const FILES = [{ name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 }];

function listResp(type = "output", subfolder = "") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      type,
      subfolder,
      path: `/${type}`,
      dirs: [],
      files: FILES,
      exists: true,
    }),
  };
}

/**
 * Fetch stub: /list and /base answer a populated folder, /upload answers
 * `uploadReply` (status + body). Every call is recorded.
 */
function uploadFetch(
  calls,
  uploadReply = { status: 200, body: { ok: true, uploaded: [], errors: [] } },
) {
  return vi.fn(async (url, init) => {
    const s = String(url);
    calls.push({ url: s, init });
    if (s.includes("/image_browser/upload")) {
      return {
        ok: uploadReply.status >= 200 && uploadReply.status < 300,
        status: uploadReply.status,
        json: async () => uploadReply.body,
      };
    }
    if (s.includes("/image_browser/base")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          base_path: "/",
          input_dir: "",
          output_dir: "",
          temp_dir: "",
        }),
      };
    }
    if (s.includes("/image_browser/pins")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
    }
    return listResp();
  });
}

async function openLoaded() {
  const modal = openShell();
  await vi.waitFor(() => {
    if (!modal.bodyEl.querySelector(".ib-card.is-file")) throw new Error("grid not rendered");
  });
  return modal;
}

function pick(modal, files) {
  const input = modal.dialog.querySelector(".ib-upload-input");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const listCalls = (calls) => calls.filter((c) => c.url.includes("/image_browser/list"));
const toastText = () =>
  Array.from(document.querySelectorAll(".cmn-toast"))
    .map((t) => t.textContent)
    .join("\n");

afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
  document.getElementById("cmn-notify-container")?.remove();
  await new Promise((r) => setTimeout(r, 20));
});

describe("upload control — write-gate mirror", () => {
  it("is present on a sandboxed tab, backed by a multi-file media picker", async () => {
    vi.stubGlobal("fetch", uploadFetch([]));
    const modal = await openLoaded();
    const btn = modal.dialog.querySelector(".ib-upload");
    expect(btn).not.toBeNull();
    expect(btn.style.display).not.toBe("none");
    const input = modal.dialog.querySelector(".ib-upload-input");
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe("image/*,video/*");
    modal.close();
  });

  it("is hidden on the browse…/path tab and shown again back on a sandboxed one", async () => {
    vi.stubGlobal("fetch", uploadFetch([]));
    const modal = await openLoaded();
    const btn = modal.dialog.querySelector(".ib-upload");
    expect(btn.style.display).not.toBe("none");

    modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
    await vi.waitFor(() => {
      if (btn.style.display !== "none") throw new Error("still visible on browse…");
    });

    modal.dialog.querySelector('.ib-tab[data-type="input"]').click();
    await vi.waitFor(() => {
      if (btn.style.display === "none") throw new Error("not restored on input");
    });
    modal.close();
  });

  it("is hidden on the pinned tab", async () => {
    vi.stubGlobal("fetch", uploadFetch([]));
    const modal = await openLoaded();
    const btn = modal.dialog.querySelector(".ib-upload");
    expect(btn.style.display).not.toBe("none");
    modal.dialog.querySelector('.ib-tab[data-type="pinned"]').click();
    await vi.waitFor(() => {
      if (btn.style.display !== "none") throw new Error("still visible on pinned");
    });
    modal.close();
  });

  it("opens the picker from the button", async () => {
    vi.stubGlobal("fetch", uploadFetch([]));
    const modal = await openLoaded();
    const input = modal.dialog.querySelector(".ib-upload-input");
    const clicked = vi.fn();
    input.addEventListener("click", clicked);
    modal.dialog.querySelector(".ib-upload").click();
    expect(clicked).toHaveBeenCalledTimes(1);
    modal.close();
  });
});

describe("upload control — request and outcome", () => {
  it("POSTs multipart to the CURRENT folder, destination fields first, then re-lists", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      uploadFetch(calls, {
        status: 200,
        body: { ok: true, uploaded: ["x.png", "y.mp4"], errors: [] },
      }),
    );
    const modal = await openLoaded();
    const listsBefore = listCalls(calls).length;

    const x = new File(["xx"], "x.png", { type: "image/png" });
    const y = new File(["yyy"], "y.mp4", { type: "video/mp4" });
    pick(modal, [x, y]);

    const up = await vi.waitFor(() => {
      const c = calls.find((k) => k.url.includes("/image_browser/upload"));
      if (!c) throw new Error("upload not posted");
      return c;
    });
    expect(up.init.method).toBe("POST");
    expect(up.init.headers["X-Image-Browser-Upload"]).toBe("1");
    // The browser writes Content-Type itself, boundary included.
    const headerNames = Object.keys(up.init.headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("content-type");

    const body = up.init.body;
    expect(body).toBeInstanceOf(FormData);
    expect([...body.keys()]).toEqual(["type", "subfolder", "file", "file"]);
    expect(body.get("type")).toBe("output");
    expect(body.get("subfolder")).toBe("");
    expect(body.getAll("file").map((f) => f.name)).toEqual(["x.png", "y.mp4"]);

    // Re-listed so the new files appear, and told the user it worked.
    await vi.waitFor(() => {
      if (listCalls(calls).length <= listsBefore) throw new Error("not re-listed");
    });
    await vi.waitFor(() => {
      if (!toastText().includes("Uploaded")) throw new Error("no success toast");
    });
    modal.close();
  });

  it("a partial failure lands the rest and names every failed file in a copyable error", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      uploadFetch(calls, {
        status: 200,
        body: {
          ok: true,
          uploaded: ["ok.png"],
          errors: [{ name: "IMG_1.HEIC", error: "unsupported file type", status: 400 }],
        },
      }),
    );
    const modal = await openLoaded();
    const listsBefore = listCalls(calls).length;
    pick(modal, [new File(["a"], "ok.png"), new File(["b"], "IMG_1.HEIC")]);

    await vi.waitFor(() => {
      const t = toastText();
      if (!t.includes("IMG_1.HEIC") || !t.includes("unsupported file type")) {
        throw new Error(`toast: ${t}`);
      }
    });
    expect(document.querySelector(".cmn-toast.cmn-error")).not.toBeNull();
    // Something landed, so the grid is refreshed.
    await vi.waitFor(() => {
      if (listCalls(calls).length <= listsBefore) throw new Error("not re-listed");
    });
    modal.close();
  });

  it("a collision (409) surfaces as an error naming the file, never a silent drop", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      uploadFetch(calls, {
        status: 409,
        body: {
          ok: false,
          error: '"taken.png" already exists',
          uploaded: [],
          errors: [{ name: "taken.png", error: '"taken.png" already exists', status: 409 }],
        },
      }),
    );
    const modal = await openLoaded();
    pick(modal, [new File(["a"], "taken.png")]);
    await vi.waitFor(() => {
      if (!toastText().includes("taken.png")) throw new Error("no toast naming the file");
    });
    expect(document.querySelector(".cmn-toast.cmn-error")).not.toBeNull();
    expect(toastText()).not.toContain("Uploaded 0");
    modal.close();
  });

  it("an empty selection posts nothing", async () => {
    const calls = [];
    vi.stubGlobal("fetch", uploadFetch(calls));
    const modal = await openLoaded();
    pick(modal, []);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.some((c) => c.url.includes("/image_browser/upload"))).toBe(false);
    modal.close();
  });
});
