// @vitest-environment jsdom
//
// Legible progress while a listing loads (issue #42).
//
// The first recursive /list after a ComfyUI restart opens every returned file
// on a cold page cache, measured at ~30 s on a real install, while the modal
// said "Loading…" with nothing else. The backend answers in one response, so
// there is no real progress to report; what the modal CAN say is how long it
// has been waiting and why a first load is slow. Two pieces:
//
//   - the status text gains an elapsed counter once a load passes a second;
//   - a full-width note explains the cold-cache cost once it passes a few.
//
// Only setInterval/clearInterval/Date are faked: vi.waitFor and the grid's own
// scheduling keep real setTimeout, so the open path behaves as in the other
// jsdom suites. The listing response is held on a deferred so a test decides
// exactly when the load finishes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOAD_NOTE_MS, loadingStatusText } from "../../src/browser.ts";
import { openShell } from "../../src/index.ts";

const PNG = { name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 };

function listingBody() {
  return {
    ok: true,
    type: "output",
    subfolder: "",
    path: "/out",
    dirs: [],
    files: [PNG],
    exists: true,
    truncated: false,
  };
}

/** Each /list request parks here until the test resolves it. */
let pendingLists = [];

function stubFetch() {
  pendingLists = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => {
      const s = String(url);
      if (init?.method === "POST")
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      if (s.includes("/image_browser/pins"))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, max: 200, pins: [] }),
        });
      if (s.includes("/image_browser/list")) {
        return new Promise((resolve) => {
          pendingLists.push({
            url: s,
            resolve: () => resolve({ ok: true, status: 200, json: async () => listingBody() }),
          });
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }),
  );
}

function stubSettings() {
  globalThis.app = {
    extensionManager: { setting: { get: () => undefined, set: () => {} } },
  };
}

const statusOf = (modal) => modal.statusEl.textContent;
const noteOf = (modal) => modal.dialog.querySelector(".ib-load-note");

async function waitForListRequest(n) {
  await vi.waitFor(() => {
    if (pendingLists.length < n) throw new Error(`waiting for /list #${n}`);
  });
}

async function resolveList(modal, i) {
  pendingLists[i].resolve();
  await vi.waitFor(() => {
    if (modal.bodyEl.classList.contains("is-busy")) throw new Error("still busy");
  });
}

beforeEach(() => {
  localStorage.clear();
  stubSettings();
  stubFetch();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("loadingStatusText", () => {
  it("stays a bare Loading… under a second, then counts whole seconds", () => {
    expect(loadingStatusText(0)).toBe("Loading…");
    expect(loadingStatusText(999)).toBe("Loading…");
    expect(loadingStatusText(1000)).toBe("Loading… 1s");
    expect(loadingStatusText(12_900)).toBe("Loading… 12s");
  });
});

describe("a slow load says how long and why", () => {
  it("counts up in the status and shows the note only once the load is slow", async () => {
    const modal = openShell();
    await waitForListRequest(1);

    expect(statusOf(modal)).toBe("Loading…");
    expect(noteOf(modal).hidden).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(statusOf(modal)).toBe("Loading… 1s");
    // Both directions on the note in one test: hidden before the threshold,
    // shown after it — an always-shown or never-shown note fails one half.
    expect(noteOf(modal).hidden).toBe(true);

    vi.advanceTimersByTime(LOAD_NOTE_MS);
    expect(statusOf(modal)).toMatch(/^Loading… \d+s$/);
    expect(noteOf(modal).hidden).toBe(false);
    expect(noteOf(modal).textContent).toMatch(/reads every file from disk/);

    await resolveList(modal, 0);
    expect(statusOf(modal)).toBe("");
    expect(noteOf(modal).hidden).toBe(true);
    modal.close();
  });

  it("stops ticking once the listing lands, so the counter cannot overwrite the result", async () => {
    const modal = openShell();
    await waitForListRequest(1);
    vi.advanceTimersByTime(2000);
    await resolveList(modal, 0);
    expect(statusOf(modal)).toBe("");

    vi.advanceTimersByTime(5000);
    expect(statusOf(modal)).toBe("");
    expect(noteOf(modal).hidden).toBe(true);
    modal.close();
  });

  it("names the flat view's whole-tree cost when the slow load is flat", async () => {
    const modal = openShell();
    await waitForListRequest(1);
    await resolveList(modal, 0);

    modal.dialog.querySelector(".ib-view-toggle").click();
    await waitForListRequest(2);
    expect(pendingLists[1].url).toContain("recursive=1");
    vi.advanceTimersByTime(LOAD_NOTE_MS);
    expect(noteOf(modal).textContent).toMatch(/flat listing/);

    await resolveList(modal, 1);
    modal.close();
  });

  it("does not name the flat view on a folder listing", async () => {
    const modal = openShell();
    await waitForListRequest(1);
    vi.advanceTimersByTime(LOAD_NOTE_MS);
    expect(noteOf(modal).hidden).toBe(false);
    expect(noteOf(modal).textContent).not.toMatch(/flat listing/);
    await resolveList(modal, 0);
    modal.close();
  });

  it("closing mid-load leaves no ticker running", async () => {
    const modal = openShell();
    await waitForListRequest(1);
    vi.advanceTimersByTime(LOAD_NOTE_MS);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    modal.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an older load finishing does not stop the newer load's counter", async () => {
    const modal = openShell();
    await waitForListRequest(1);
    // A second load while the first is still out: the refresh button.
    modal.dialog.querySelector('button[title="Refresh"]').click();
    await waitForListRequest(2);

    // The FIRST request lands while the second is still pending.
    pendingLists[0].resolve();
    await vi.waitFor(() => {
      if (modal.bodyEl.querySelector(".ib-card.is-file") === null) throw new Error("no grid");
    });
    vi.advanceTimersByTime(LOAD_NOTE_MS);
    expect(statusOf(modal)).toMatch(/^Loading… \d+s$/);
    expect(noteOf(modal).hidden).toBe(false);

    // Not resolveList(): load A already cleared the busy flag, so "not busy"
    // is true before load B lands. Wait on B's own effect instead.
    pendingLists[1].resolve();
    await vi.waitFor(() => {
      if (statusOf(modal) !== "") throw new Error("load B not landed");
    });
    expect(noteOf(modal).hidden).toBe(true);
    modal.close();
  });
});
