// @vitest-environment jsdom
//
// The arbitrary-path read opt-in (ImageBrowser.AllowAbsolutePathReads), on the
// frontend side.
//
// /image_browser/file is off by default now, so a type=path VIDEO card cannot
// play and a type=path full-size open cannot work. The failure this suite pins
// is the silent one: a <video> whose source 403s renders a permanently blank
// tile with nothing to click and no explanation, which reads as "the pack is
// broken" rather than "a switch is off".
//
// Every assertion here is TWO-SIDED on the same listing: the opt-in on and the
// opt-in off, with nothing else changed. A suite asserting only the locked tile
// passes identically against a grid that never renders a <video> at all — which
// would break video preview on the sandboxed roots too, where the opt-in has no
// business reaching.
//
// fetchBasePaths caches its answer in a module-level variable, so each test
// re-imports the modules through vi.resetModules(). Sharing them would let the
// first test's opt-in state decide every later one's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PATH_LISTING = {
  ok: true,
  type: "path",
  subfolder: "",
  path: "/srv/renders",
  dirs: [],
  files: [
    { name: "clip.mp4", ext: ".mp4", mtime: 1_700_000_000, size: 10 },
    { name: "still.png", ext: ".png", mtime: 1_700_000_001, size: 10, width: 4, height: 4 },
  ],
  exists: true,
};

/** Stub the endpoints the modal touches; `allowPathReads` is the variable. */
function stubFetch(allowPathReads) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/image_browser/pins")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
      }
      if (s.includes("/image_browser/base")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            base_path: "/srv",
            input_dir: "/srv/in",
            output_dir: "/srv/out",
            temp_dir: "/srv/tmp",
            allow_path_reads: allowPathReads,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => PATH_LISTING };
    }),
  );
}

/** Open the browser on the browse…/path tab and wait for the listing to paint. */
async function openOnPathTab(openShell) {
  const modal = openShell();
  const tab = modal.dialog.querySelector('.ib-tab[data-type="path"]');
  if (!tab) throw new Error("browse… tab not found");
  tab.click();
  // The listing is fetched, so the grid is not painted synchronously. Flushing
  // matters: asserting straight after the click runs against an EMPTY grid, and
  // "no <video> element" would then be trivially true either way.
  await vi.waitFor(() => {
    if (!modal.dialog.querySelector(".ib-card.is-file")) throw new Error("grid not painted");
  });
  return modal;
}

function videoCard(modal) {
  return modal.dialog.querySelector('.ib-card[data-ext=".mp4"]');
}

async function load(allowPathReads) {
  vi.resetModules();
  stubFetch(allowPathReads);
  const api = await import("../../src/api.ts");
  const { openShell } = await import("../../src/index.ts");
  return { api, modal: await openOnPathTab(openShell) };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("pathReadsAllowed reflects what the backend reported", () => {
  it("is true when /base says so and false when it does not", async () => {
    const on = await load(true);
    expect(on.api.pathReadsAllowed()).toBe(true);
    on.modal.close();

    const off = await load(false);
    expect(off.api.pathReadsAllowed()).toBe(false);
    off.modal.close();
  });

  it("is false when the key is ABSENT, not undefined-y", async () => {
    // An older backend sends no key at all. "Absent" must read as off, not as
    // unknown-so-try-anyway: offering a control that 403s is worse than saying
    // it is switched off. Paired with the `true` arm above so this cannot pass
    // against a helper hard-wired to false.
    vi.resetModules();
    stubFetch(undefined);
    const api = await import("../../src/api.ts");
    await api.fetchBasePaths();
    expect(api.pathReadsAllowed()).toBe(false);
  });
});

describe("a type=path video card", () => {
  it("mounts a <video> when the opt-in is ON and a locked tile when it is OFF", async () => {
    // The whole two-sided control, on one listing. The ON arm is what tells
    // "the tile explains the refusal" from "the grid stopped rendering video".
    const on = await load(true);
    const playable = videoCard(on.modal);
    expect(playable).not.toBeNull();
    expect(playable.querySelector("video")).not.toBeNull();
    expect(playable.querySelector(".ib-thumb-icon")).toBeNull();
    on.modal.close();

    const off = await load(false);
    const locked = videoCard(off.modal);
    expect(locked).not.toBeNull();
    expect(locked.querySelector("video")).toBeNull();
    const icon = locked.querySelector(".ib-thumb-icon");
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("title")).toBe(off.api.PATH_READS_DISABLED_MSG);
    off.modal.close();
  });

  it("names the settings path in the message, so the refusal is actionable", async () => {
    const { api, modal } = await load(false);
    // A mute 🔒 is a silent failure with extra steps. Assert the message says
    // where the switch is, not merely that some message exists.
    expect(api.PATH_READS_DISABLED_MSG).toContain("Settings");
    expect(api.PATH_READS_DISABLED_MSG).toContain("Image Browser");
    expect(api.PATH_READS_DISABLED_MSG).toContain("Allow absolute-path file reads");
    modal.close();
  });

  it("leaves a type=path IMAGE card alone in both states", async () => {
    // The opt-in gates /file, never /thumb — thumbnails, listings and metadata
    // on the browse… tab keep working because none of them returns a file's
    // bytes. An over-broad gate would take the whole tab out, and that is the
    // regression this pins.
    for (const allowed of [true, false]) {
      const { modal } = await load(allowed);
      const card = modal.dialog.querySelector('.ib-card[data-ext=".png"]');
      expect(card).not.toBeNull();
      expect(card.querySelector("img")).not.toBeNull();
      expect(card.querySelector(".ib-thumb-icon")).toBeNull();
      modal.close();
    }
  });
});

describe("opening a type=path file full-size", () => {
  it("opens a tab when the opt-in is ON and warns instead when it is OFF", async () => {
    const on = await load(true);
    const opener = vi.fn();
    vi.stubGlobal("open", opener);
    videoCard(on.modal).click();
    await vi.waitFor(() => {
      if (opener.mock.calls.length === 0) throw new Error("no open yet");
    });
    expect(String(opener.mock.calls[0][0])).toContain("/image_browser/file");
    on.modal.close();

    const off = await load(false);
    const blocked = vi.fn();
    vi.stubGlobal("open", blocked);
    videoCard(off.modal).click();
    // Nothing to wait for on the refusal path, so give the click's own async
    // work a turn before asserting the absence — otherwise "no open yet" is
    // true simply because nothing has run.
    await Promise.resolve();
    expect(blocked).not.toHaveBeenCalled();
    off.modal.close();
  });
});
