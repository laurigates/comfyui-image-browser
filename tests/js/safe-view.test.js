// @vitest-environment jsdom
//
// Safe View — the family's sensitive-content filter, as this pack wires it.
//
// WHAT THIS TIER CAN AND CANNOT ASSERT (see .claude/rules/modal-pack-test-tiers.md)
//
// The blur and the spoiler arrive through a CLASS RULE in the stylesheet the
// kit injects, never through `el.style`. jsdom DOES resolve those rules, so
// `getComputedStyle(el).filter` is a real assertion here — measured returning
// "blur(18px)" — while `el.style.filter` reads "" whether the code works or
// not, and a test written that way would pass against the bug.
//
// What this tier still cannot see: whether the blur is wide enough to defeat a
// glance, whether the reveal button is reachable by thumb at a phone viewport,
// and whether the blurred thumbnail leaks a readable silhouette at its rim.
// Those are browser-tier questions and none of them are asserted anywhere —
// they are live-smoke checks, listed in the PR body rather than faked here.

import {
  ensureSafeViewStyle,
  getHubEntries,
  getHubToggles,
  notifySafeViewChange,
  SAFE_VIEW_BLUR_CLASS,
  SAFE_VIEW_SETTINGS,
  SAFE_VIEW_SPOILER_CLASS,
} from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "/scripts/app.js";
import { openShell } from "../../src/index.ts";
import { installLightboxActions } from "../../src/lightbox-actions.ts";
import { installScanWarm } from "../../src/scan-warm.ts";
import { installSidebarStars } from "../../src/sidebar-stars.ts";

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

/**
 * A stand-in for ComfyUI's setting store.
 *
 * `set` fires the kit's change bus, which is what the real store does via each
 * setting's registered `onChange`. Emulating that here is what makes the toggle
 * tests END TO END: a test whose `set` only wrote to a Map would pass even if
 * the pack never subscribed to the bus, which is the whole mechanism that keeps
 * two packs' open surfaces in step.
 */
function stubSettings(values = {}) {
  const store = new Map(Object.entries(values));
  const host = {
    get: (id) => store.get(id),
    set: (id, value) => {
      store.set(id, value);
      notifySafeViewChange();
    },
    // Test-only handle for asserting what got written.
    _store: store,
  };
  globalThis.app = { extensionManager: { setting: host } };
  return host;
}

const PNG = { ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 };

/**
 * Fetch stub. `listings` maps a subfolder to its `{dirs, files}`; every /list
 * request URL is recorded so a test can assert on the query string.
 */
function stubFetch(listings, calls = [], posts = []) {
  const fn = vi.fn(async (url, init) => {
    const s = String(url);
    calls.push(s);
    if (init?.method === "POST") {
      posts.push({ url: s, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, scanned: 0 }) };
    }
    if (s.includes("/image_browser/pins")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
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
    if (s.includes("/image_browser/list")) {
      const sub = new URL(s, "http://localhost").searchParams.get("subfolder") ?? "";
      const entry = listings[sub] ?? { dirs: [], files: [] };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "output",
          subfolder: sub,
          path: "/out",
          dirs: entry.dirs ?? [],
          files: entry.files ?? [],
          exists: true,
          truncated: false,
          // The prompt tier's progress count. Passed through from the fixture so
          // a test can drive the "scanning N" pill without a second stub.
          ...(entry.unscanned === undefined ? {} : { safe_unscanned: entry.unscanned }),
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Open the modal and wait for the first listing to paint. */
async function open() {
  const modal = openShell();
  await vi.waitFor(() => {
    if (!modal.bodyEl.querySelector(".ib-card")) throw new Error("grid not rendered");
  });
  return modal;
}

/** The file card for `name`, or null. */
function card(modal, name) {
  for (const c of modal.bodyEl.querySelectorAll(".ib-card.is-file")) {
    if (c.dataset.name === name) return c;
  }
  return null;
}

/** Whether a card's thumbnail is actually blurred, read from the CASCADE. */
function isBlurred(cardEl) {
  const thumb = cardEl.querySelector(".ib-thumb");
  return getComputedStyle(thumb).filter === "blur(18px)";
}

/** Press `b` on window, where the pack's capture-phase listener lives. */
function pressB() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true }));
}

// The extension registers ONCE, at module import — captured here rather than in
// a beforeEach, which would run after that and find nothing (and clearing the
// array would destroy the only copy).
const EXTENSION = app.registrations.find((r) => r.name === "comfy.image-browser");

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  // A fresh event bus per test. `app.api` is MODULE-level state shared by every
  // test in this file, and the registration suite's `EXTENSION.setup()` installs
  // a permanent `executed` listener that nothing tears down — correct in
  // production (setup runs once per page load) and a cross-test leak here.
  // Without this reset, a later "stopped listening" assertion sees a post made
  // by somebody else's listener and fails for a reason that is not the code's.
  app.api = new EventTarget();
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.app = undefined;
  for (const d of document.querySelectorAll(".cmp-backdrop, .cmp-dialog")) d.remove();
  document.body.innerHTML = "";
});

// --------------------------------------------------------------------------

describe("harness self-check", () => {
  it("jsdom resolves `filter` from an injected CLASS rule", () => {
    // EVERY blur assertion in this file depends on this, and the dependency is
    // invisible from the assertions themselves. If a jsdom upgrade stopped
    // resolving `filter`, the positive assertions would fail with a confusing
    // "expected false to be true" that reads as a code bug — and the NEGATIVE
    // ones would quietly stop testing anything at all while staying green.
    // This fails first, and says why.
    ensureSafeViewStyle();
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.classList.add(SAFE_VIEW_BLUR_CLASS);
    expect(getComputedStyle(el).filter).toBe("blur(18px)");
    el.remove();
  });
});

describe("Safe View — matching in the grid", () => {
  const FILES = [
    { name: "holiday.png", ...PNG },
    { name: "my_nsfw_pic.png", ...PNG },
    { name: "nsfwish.png", ...PNG },
    { name: "classic.png", ...PNG },
  ];

  it("blurs a file whose name carries the keyword as a whole token", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(true);
  });

  it("leaves a non-matching file alone", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "holiday.png"))).toBe(false);
  });

  // ---- The two controls. A substring matcher passes every positive test
  // ---- above and fails only these, so a sweep without them asserts nothing.

  it("CONTROL: `nsfw` does not match `nsfwish.png`", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "nsfwish.png"))).toBe(false);
    // The positive case, asserted in the SAME test: a filter that blurred
    // nothing at all would satisfy the negative above on its own, so the
    // control only discriminates while paired with a match it must catch.
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(true);
  });

  it("CONTROL: `ass` does not match `assets/` in the path", async () => {
    // The FOLDER is the haystack here — the file name is innocent either way,
    // so this fails only if the path is matched as a substring.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "ass, nsfw" });
    stubFetch({ "": { dirs: [{ name: "assets" }] }, assets: { files: FILES } });
    const modal = await open();
    modal.bodyEl.querySelector(".ib-card.is-dir").click();
    await vi.waitFor(() => {
      if (!card(modal, "classic.png")) throw new Error("subfolder not rendered");
    });
    expect(isBlurred(card(modal, "classic.png"))).toBe(false);
    // Paired positive: the second keyword must still match inside the very
    // same listing, so "nothing is blurred here" cannot pass this test.
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(true);
  });

  it("matches every folder segment above the file, not just its name", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({
      "": { dirs: [{ name: "nsfw" }] },
      nsfw: { files: [{ name: "plain.png", ...PNG }] },
    });
    const modal = await open();
    modal.bodyEl.querySelector(".ib-card.is-dir").click();
    await vi.waitFor(() => {
      if (!card(modal, "plain.png")) throw new Error("subfolder not rendered");
    });
    expect(isBlurred(card(modal, "plain.png"))).toBe(true);
  });

  it("matches the ROOT segment, which the bare subfolder would drop", async () => {
    // fileSub() returns the subfolder ONLY, so the obvious implementation
    // silently makes a keyword naming a root match nothing at all. The backend
    // builds the same `${root}/${subfolder}` string; if the two disagree, a
    // file is hidden on one surface and plain on another.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "output" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "holiday.png"))).toBe(true);
  });

  it("filters nothing when the keyword list is empty", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(false);
  });

  it("filters nothing when Safe View is switched off", async () => {
    stubSettings({
      [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
      [SAFE_VIEW_SETTINGS.enabled]: false,
    });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(false);
  });
});

describe("Safe View — the name must not escape through a second channel", () => {
  const FILES = [{ name: "my_nsfw_pic.png", ...PNG }];

  async function hiddenCard() {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    return card(modal, "my_nsfw_pic.png");
  }

  it("blocks out the visible name", async () => {
    const c = await hiddenCard();
    expect(c.querySelector(".ib-name").classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(true);
  });

  it("REMOVES the name's title attribute rather than styling it", async () => {
    // A native tooltip renders the filename in full on hover regardless of any
    // CSS painted over the text, so absence is the only correct assertion —
    // and it must be absence, not emptiness: title="" still has the attribute
    // and a future edit could refill it without any test noticing.
    const c = await hiddenCard();
    expect(c.querySelector(".ib-name").hasAttribute("title")).toBe(false);
  });

  it("keeps the filename out of the checkbox's accessible name", async () => {
    // The third channel, and the only one CSS cannot touch: a spoiler that
    // paints a block while a screen reader announces "Select my_nsfw_pic.png"
    // has hidden nothing.
    const c = await hiddenCard();
    const label = c.querySelector("[data-check]").getAttribute("aria-label");
    expect(label).not.toContain("nsfw");
    expect(label).toBe("Select hidden item");
  });

  it("leaves the name readable when 'block out names' is off", async () => {
    stubSettings({
      [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
      [SAFE_VIEW_SETTINGS.blurNames]: false,
    });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    const c = card(modal, "my_nsfw_pic.png");
    // The thumbnail is still blurred — that part is not optional.
    expect(isBlurred(c)).toBe(true);
    expect(c.querySelector(".ib-name").hasAttribute("title")).toBe(true);
    expect(c.querySelector("[data-check]").getAttribute("aria-label")).toContain("nsfw");
  });
});

describe("Safe View — reveal", () => {
  const FILES = [
    { name: "a_nsfw.png", ...PNG },
    { name: "b_nsfw.png", ...PNG },
  ];

  async function opened() {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES }, sub: { files: [{ name: "other.png", ...PNG }] } });
    return open();
  }

  /** Click the reveal control ON THE CARD — never on document. */
  function reveal(cardEl) {
    const btn = cardEl.querySelector(".cmk-sv-reveal");
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  it("gives every hidden card a reveal control", async () => {
    const modal = await opened();
    expect(card(modal, "a_nsfw.png").querySelector(".cmk-sv-reveal")).not.toBeNull();
  });

  it("keeps the reveal control OUTSIDE the blurred element", async () => {
    // CONTAINMENT, not a count — no count can see this. `filter` applies to the
    // whole subtree, so a reveal button moved inside `.ib-thumb` would be
    // blurred along with the image it exists to escape: the control is still
    // present, still clickable, still counted, and unreadable. The same trap
    // applies to the ✓ checkbox and the action row, so both are asserted here.
    const modal = await opened();
    const c = card(modal, "a_nsfw.png");
    const thumb = c.querySelector(".ib-thumb");
    expect(getComputedStyle(thumb).filter).toBe("blur(18px)");
    expect(thumb.contains(c.querySelector(".cmk-sv-reveal"))).toBe(false);
    expect(thumb.contains(c.querySelector("[data-check]"))).toBe(false);
    expect(thumb.contains(c.querySelector(".ib-actions"))).toBe(false);
  });

  it("un-blurs the card it was tapped on", async () => {
    const modal = await opened();
    reveal(card(modal, "a_nsfw.png"));
    expect(isBlurred(card(modal, "a_nsfw.png"))).toBe(false);
  });

  it("reveals ONE card, not the listing", async () => {
    const modal = await opened();
    reveal(card(modal, "a_nsfw.png"));
    expect(isBlurred(card(modal, "b_nsfw.png"))).toBe(true);
  });

  it("restores the name and its title on the revealed card", async () => {
    const modal = await opened();
    reveal(card(modal, "a_nsfw.png"));
    const nameEl = card(modal, "a_nsfw.png").querySelector(".ib-name");
    expect(nameEl.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(false);
    expect(nameEl.getAttribute("title")).toContain("a_nsfw.png");
  });

  it("repaints the grid IN PLACE — the modal is the same node afterwards", async () => {
    // Node IDENTITY, never a count. The reveal handler re-renders, and a count
    // of `.cmp-dialog` stays 1 whether the modal was kept or torn down and
    // rebuilt — the kit's setActiveModal dismisses the previous modal and
    // mounts a fresh one, so a rebuild also yields exactly one dialog. What the
    // user would lose is the scroll position, the focused card and the search
    // box, none of which a count can see.
    const modal = await opened();
    const before = document.querySelector(".ib-dialog");
    reveal(card(modal, "a_nsfw.png"));
    expect(document.querySelector(".ib-dialog")).toBe(before);
  });

  it("survives an in-place re-render (a sort change re-renders the grid)", async () => {
    const modal = await opened();
    reveal(card(modal, "a_nsfw.png"));
    const sortEl = modal.dialog.querySelector("select.ib-control");
    sortEl.value = "name:asc";
    sortEl.dispatchEvent(new Event("change", { bubbles: true }));
    expect(isBlurred(card(modal, "a_nsfw.png"))).toBe(false);
  });

  it("is CLEARED by navigating to a different folder and back", async () => {
    // Reveals are scoped to one location: walking away and returning must not
    // still be showing what was unblurred before the detour.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({
      "": { dirs: [{ name: "sub" }], files: FILES },
      sub: { files: [{ name: "other.png", ...PNG }] },
    });
    const modal = await open();
    reveal(card(modal, "a_nsfw.png"));
    expect(isBlurred(card(modal, "a_nsfw.png"))).toBe(false);

    modal.bodyEl.querySelector(".ib-card.is-dir").click();
    await vi.waitFor(() => {
      if (!card(modal, "other.png")) throw new Error("subfolder not rendered");
    });
    modal.bodyEl.querySelector(".ib-card.is-up").click();
    await vi.waitFor(() => {
      if (!card(modal, "a_nsfw.png")) throw new Error("parent not rendered");
    });
    expect(isBlurred(card(modal, "a_nsfw.png"))).toBe(true);
  });

  it("is NOT cleared by a refresh of the same folder", async () => {
    // The other half of the rule: an in-place reload (refresh, paste, a
    // settings repaint) is not a change of location and must keep the reveal.
    const modal = await opened();
    reveal(card(modal, "a_nsfw.png"));
    // Wait for the card NODE to be replaced, not merely to exist: renderGrid
    // rebuilds the grid's innerHTML, and the pre-refresh card satisfies a
    // "does it exist" wait instantly — so an earlier version of this test
    // asserted before the reload had rendered anything and passed against a
    // reveal set that WAS being cleared. `just mutation-check` is what caught
    // that; keep the identity comparison.
    const before = card(modal, "a_nsfw.png");
    modal.dialog.querySelector(".ib-icon[title='Refresh']").click();
    await vi.waitFor(() => {
      if (card(modal, "a_nsfw.png") === before) throw new Error("not re-rendered yet");
    });
    expect(isBlurred(card(modal, "a_nsfw.png"))).toBe(false);
  });
});

describe("Safe View — folder cards", () => {
  it("blurs and blocks out a matching folder, by NAME ONLY", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { dirs: [{ name: "nsfw" }, { name: "holiday" }] } });
    const modal = await open();
    const dirs = [...modal.bodyEl.querySelectorAll(".ib-card.is-dir")];
    const hidden = dirs.find((d) => d.dataset.name === "nsfw");
    const plain = dirs.find((d) => d.dataset.name === "holiday");
    expect(getComputedStyle(hidden.querySelector(".ib-thumb")).filter).toBe("blur(18px)");
    expect(hidden.querySelector(".ib-name").classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(true);
    expect(getComputedStyle(plain.querySelector(".ib-thumb")).filter).not.toBe("blur(18px)");
  });

  it("gives a folder no reveal control — tapping it descends, which IS the reveal", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { dirs: [{ name: "nsfw" }] } });
    const modal = await open();
    const dir = modal.bodyEl.querySelector(".ib-card.is-dir");
    expect(dir.querySelector(".cmk-sv-reveal")).toBeNull();
  });
});

describe("Safe View — the toolbar toggle", () => {
  const FILES = [{ name: "my_nsfw_pic.png", ...PNG }];

  it("shows the ON glyph while filtering is in force", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    const btn = modal.dialog.querySelector(".ib-safe-toggle");
    expect(btn.textContent).toBe("🙈");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the OFF glyph when there are no keywords, since nothing is filtered", async () => {
    // Claiming 🙈 with an empty keyword list would advertise a protection that
    // is not in force — the filter is a no-op with nothing to match.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    const btn = modal.dialog.querySelector(".ib-safe-toggle");
    expect(btn.textContent).toBe("👁");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("writes the setting and the grid un-blurs, through the kit's change bus", async () => {
    const host = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(true);

    modal.dialog.querySelector(".ib-safe-toggle").click();
    expect(host._store.get(SAFE_VIEW_SETTINGS.enabled)).toBe(false);
    await vi.waitFor(() => {
      if (isBlurred(card(modal, "my_nsfw_pic.png"))) throw new Error("still blurred");
    });
  });

  it("the `b` key does the same", async () => {
    const host = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    await open();
    // The shell AUTOFOCUSES the search box, so a key dispatched without this
    // blur is swallowed by the in-a-text-field guard — and the negative test
    // below would then pass for the wrong reason, against any implementation.
    document.activeElement?.blur?.();
    pressB();
    expect(host._store.get(SAFE_VIEW_SETTINGS.enabled)).toBe(false);
  });

  it("`b` is inert while typing in the search box", async () => {
    const host = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    // Explicit, not inherited from the shell's autofocus: the sibling test
    // above proves this assertion can fail, which is the only thing that makes
    // it evidence of the guard rather than of the harness.
    modal.searchEl.focus();
    pressB();
    expect(host._store.has(SAFE_VIEW_SETTINGS.enabled)).toBe(false);
  });
});

describe("Safe View — the /list request", () => {
  const FILES = [{ name: "my_nsfw_pic.png", ...PNG }];

  function listURLs(calls) {
    return calls.filter((c) => c.includes("/image_browser/list"));
  }

  it("sends NOTHING when hiding is off, so the default URL is unchanged", async () => {
    const calls = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } }, calls);
    await open();
    const url = listURLs(calls)[0];
    expect(url).not.toContain("safe_kw");
    expect(url).not.toContain("safe_hide");
  });

  it("sends the keywords and the flag when hiding is on", async () => {
    const calls = [];
    stubSettings({
      [SAFE_VIEW_SETTINGS.keywords]: "nsfw, private",
      [SAFE_VIEW_SETTINGS.hide]: true,
    });
    stubFetch({ "": { files: [{ name: "holiday.png", ...PNG }] } }, calls);
    await open();
    const url = listURLs(calls)[0];
    // Normalized by the kit's parseKeywords before it is sent, so the backend
    // re-parsing it cannot disagree about the token set.
    expect(url).toContain("safe_kw=nsfw%2Cprivate");
    expect(url).toContain("safe_hide=1");
  });

  it("sends nothing when hiding is on but no keywords are configured", async () => {
    // The backend also refuses to filter on an empty list, so sending the flag
    // alone would be a request that believes it asked for something it did not.
    const calls = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "", [SAFE_VIEW_SETTINGS.hide]: true });
    stubFetch({ "": { files: FILES } }, calls);
    await open();
    expect(listURLs(calls)[0]).not.toContain("safe_hide");
  });
});

describe("Safe View — registration", () => {
  it("registers the kit's five settings under their frozen ids", async () => {
    // Spread from the kit, never hand-written: two copies drift, and a drifted
    // defaultValue between two packs registering the SAME id is invisible,
    // because whichever pack wins the import race decides.
    const ids = new Set(EXTENSION.settings.map((s) => s.id));
    for (const id of Object.values(SAFE_VIEW_SETTINGS)) expect(ids).toContain(id);
  });

  it("registers Safe View as a hub TOGGLE, keeping the one-tap launch intact", async () => {
    // A toggle registered as an ordinary HubEntry would make
    // getHubEntries().length === 2 for a user with only this pack installed,
    // costing them installHubButton's single-entry short-circuit — an extra tap
    // on every launch, taken back silently.
    await EXTENSION.setup();
    expect(getHubToggles().some((t) => t.id === "safe-view.toggle")).toBe(true);
    expect(getHubEntries().some((e) => e.id === "safe-view.toggle")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// The two stock-UI injectors
// --------------------------------------------------------------------------

/** A stand-in for one stock MediaAssetCard: the card root plus its <img>. */
function stockCard(name, subfolder = "") {
  const el = document.createElement("div");
  el.setAttribute("data-selected", "false");
  const img = document.createElement("img");
  img.setAttribute(
    "src",
    `/api/view?filename=${name}&type=output&subfolder=${encodeURIComponent(subfolder)}`,
  );
  const label = document.createElement("span");
  label.textContent = name;
  el.append(img, label);
  document.body.appendChild(el);
  return { el, img, label };
}

describe("Safe View — the Media Assets sidebar injector", () => {
  let uninstall = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("blurs a matching stock card and blocks out its name", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { el, img, label } = stockCard("my_nsfw_pic.png");
    uninstall = installSidebarStars();
    await vi.waitFor(() => {
      if (!img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("not blurred");
    });
    expect(getComputedStyle(img).filter).toBe("blur(18px)");
    expect(label.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(true);
    expect(el.classList.contains("ibs-safe-hidden")).toBe(true);
  });

  it("injects NO toggle into ComfyUI's own chrome", async () => {
    // Nothing in the stock UI advertises that this filter exists — the controls
    // live in our modal, the settings dialog and the Touch Tools chooser.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { el, img } = stockCard("my_nsfw_pic.png");
    uninstall = installSidebarStars();
    await vi.waitFor(() => {
      if (!img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("not blurred");
    });
    expect(el.querySelector(".cmk-sv-reveal")).toBeNull();
  });

  it("CLEARS the blur when the virtualizer recycles the node onto another file", async () => {
    // The card grid recycles DOM nodes between files. A blur left bound to the
    // node would become a permanent smear on whatever scrolled through that
    // slot — the same class of bug as a stale star row, and the reason nothing
    // in that module binds state to an element.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { img, label } = stockCard("my_nsfw_pic.png");
    uninstall = installSidebarStars();
    await vi.waitFor(() => {
      if (!img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("not blurred");
    });

    img.setAttribute("src", "/api/view?filename=holiday.png&type=output&subfolder=");
    label.textContent = "holiday.png";
    await vi.waitFor(() => {
      if (img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("still blurred");
    });
    expect(label.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(false);
  });

  it("leaves the stock cards untouched when the injector is switched off", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { el, img, label } = stockCard("my_nsfw_pic.png");
    const off = installSidebarStars();
    await vi.waitFor(() => {
      if (!img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("not blurred");
    });
    off();
    expect(img.classList.contains(SAFE_VIEW_BLUR_CLASS)).toBe(false);
    expect(label.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(false);
    expect(el.classList.contains("ibs-safe-hidden")).toBe(false);
    // And the name it was hiding is readable again.
    expect(getComputedStyle(label).color).not.toBe("rgba(0, 0, 0, 0)");
  });
});

describe("Safe View — the asset lightbox injector", () => {
  let uninstall = null;

  // The lightbox's reveal set is module-level and SESSION-scoped by design (a
  // reveal survives closing and reopening the viewer on the same item), so each
  // test below addresses a DIFFERENT file — sharing one would let an earlier
  // test's reveal silently satisfy a later blur assertion.

  function stockLightbox(name) {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("data-mask", "");
    const img = document.createElement("img");
    img.setAttribute("src", `/api/view?filename=${name}&type=output&subfolder=`);
    dialog.appendChild(img);
    document.body.appendChild(dialog);
    return { dialog, img };
  }

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("blurs the viewed media when it matches", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { img } = stockLightbox("one_nsfw.png");
    uninstall = installLightboxActions();
    await vi.waitFor(() => {
      if (!img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("not blurred");
    });
    expect(getComputedStyle(img).filter).toBe("blur(18px)");
  });

  it("offers a per-item reveal, so the viewer is not a dead end", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { dialog, img } = stockLightbox("two_nsfw.png");
    uninstall = installLightboxActions();
    await vi.waitFor(() => {
      if (!dialog.querySelector(".cmk-sv-reveal")) throw new Error("no reveal");
    });
    // Dispatched on the button, where a real tap lands — a listener bound below
    // document never sees a document-level dispatch, and such a test would pass
    // with the handler removed entirely.
    dialog
      .querySelector(".cmk-sv-reveal")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(img.classList.contains(SAFE_VIEW_BLUR_CLASS)).toBe(false);
    expect(dialog.querySelector(".cmk-sv-reveal")).toBeNull();
  });

  it("CLEARS the blur when navigating to a harmless item in the same dialog", async () => {
    // One dialog element outlives many items — navigating swaps the src in
    // place. A blur bound to the element would follow the user onto the next
    // image, which reads as the stock viewer having broken.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({});
    const { dialog, img } = stockLightbox("three_nsfw.png");
    uninstall = installLightboxActions();
    await vi.waitFor(() => {
      if (!img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("not blurred");
    });

    img.setAttribute("src", "/api/view?filename=holiday.png&type=output&subfolder=");
    await vi.waitFor(() => {
      if (img.classList.contains(SAFE_VIEW_BLUR_CLASS)) throw new Error("still blurred");
    });
    expect(dialog.querySelector(".cmk-sv-reveal")).toBeNull();
  });
});

// --------------------------------------------------------------------------
// The opt-in prompt tier
// --------------------------------------------------------------------------
//
// WHAT THIS TIER CAN ASSERT HERE. The verdict arrives as a field on the listing
// row, so jsdom sees the whole decision path: request flag -> response field ->
// isSensitive -> the resolved blur class. What it CANNOT see is whether the
// backend's cache actually holds the right text — that is tests/test_helpers.py's
// TestSafeViewPromptTier, driven against real embedded metadata.
//
// THE FOUR STATES ARE THE POINT. `true` and `false` are the easy half. The two
// that matter are `"unscanned"` (participates, no verdict yet -> blurred,
// fail-safe) and ABSENT (outside the tier -> never blurred). Collapsing them in
// either direction is a shipped bug: default-absent-to-unscanned blurs every
// folder card and every unreadable container the moment the tier comes on, and
// default-unscanned-to-false shows a sensitive render in the clear on a cold
// cache. Both directions are asserted below.

describe("Safe View — the prompt tier's four states", () => {
  const ON = {
    [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
    [SAFE_VIEW_SETTINGS.matchPrompt]: true,
  };
  // Innocent name, innocent folder: nothing but the verdict can blur these.
  const MATCHED = { name: "holiday_a.png", ...PNG, prompt_match: true };
  const CLEAR = { name: "holiday_b.png", ...PNG, prompt_match: false };
  const UNSCANNED = { name: "holiday_c.png", ...PNG, prompt_match: "unscanned" };
  // No `prompt_match` key at all — a container the backend has no reader for.
  const OUTSIDE = { name: "holiday_d.avi", ...PNG, ext: ".avi" };
  const ALL = [MATCHED, CLEAR, UNSCANNED, OUTSIDE];

  it("blurs a file whose cached prompt matched, on an innocent name and path", async () => {
    stubSettings(ON);
    stubFetch({ "": { files: ALL } });
    const modal = await open();
    expect(isBlurred(card(modal, "holiday_a.png"))).toBe(true);
    // Paired negative in the SAME listing: a tier that blurred everything would
    // satisfy the positive on its own.
    expect(isBlurred(card(modal, "holiday_b.png"))).toBe(false);
  });

  it("COLD CACHE: `unscanned` is blurred — the fail-safe reading of an unknown", async () => {
    // BOTH DIRECTIONS, same listing. The positive alone passes against a tier
    // that blurs EVERYTHING — which is exactly what a wrong default here does,
    // and it would look identical to a working fail-safe on a cold cache. The
    // scanned-and-clean card is what tells them apart.
    stubSettings(ON);
    stubFetch({ "": { files: ALL } });
    const modal = await open();
    expect(isBlurred(card(modal, "holiday_c.png"))).toBe(true);
    expect(isBlurred(card(modal, "holiday_b.png"))).toBe(false);
  });

  it("CONTROL: a row with NO verdict is never blurred by this tier", async () => {
    // The other half of the four-state contract. `undefined` means "does not
    // participate", not "not scanned yet"; treating it as unscanned would blur
    // every unreadable container — and every card in the pinned view, which
    // carries no verdicts at all.
    stubSettings(ON);
    stubFetch({ "": { files: ALL } });
    const modal = await open();
    expect(isBlurred(card(modal, "holiday_d.avi"))).toBe(false);
    // Paired positive: the same listing must still blur the unscanned row, so
    // "the tier is off" cannot satisfy this test.
    expect(isBlurred(card(modal, "holiday_c.png"))).toBe(true);
  });

  it("CONTROL: a FOLDER card is never blurred by this tier", async () => {
    // A folder has no generation metadata to read, so it is outside the tier by
    // construction — and it is the case where a wrong default is most visible,
    // because every doorway in the grid would blur at once.
    stubSettings(ON);
    stubFetch({ "": { dirs: [{ name: "holiday" }], files: [UNSCANNED] } });
    const modal = await open();
    const dir = modal.bodyEl.querySelector(".ib-card.is-dir");
    expect(getComputedStyle(dir.querySelector(".ib-thumb")).filter).not.toBe("blur(18px)");
    expect(isBlurred(card(modal, "holiday_c.png"))).toBe(true);
  });

  it("consults no verdict while the tier is SWITCHED OFF", async () => {
    // A stale `"unscanned"` left on a row must not blur anything once the user
    // turns the tier back off — the kit gates the whole check on matchPrompt.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: [...ALL, { name: "my_nsfw_pic.png", ...PNG }] } });
    const modal = await open();
    expect(isBlurred(card(modal, "holiday_c.png"))).toBe(false);
    expect(isBlurred(card(modal, "holiday_a.png"))).toBe(false);
    // Paired positive: Safe View ITSELF is still on, so the name match must
    // still blur. Without it, "nothing is blurred" passes against a filter that
    // has been switched off entirely rather than one tier being skipped.
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(true);
  });

  it("asks for the tier only when it is on AND there are keywords", async () => {
    const calls = [];
    stubSettings(ON);
    stubFetch({ "": { files: ALL } }, calls);
    await open();
    expect(calls.some((u) => u.includes("/list") && u.includes("safe_prompt=1"))).toBe(true);
  });

  it("does NOT ask for the tier when it is off (the default URL is unchanged)", async () => {
    const calls = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: ALL } }, calls);
    await open();
    // A listing must have happened, or "no safe_prompt anywhere" is trivially
    // true against a browser that never asked for anything.
    expect(calls.some((u) => u.includes("/image_browser/list"))).toBe(true);
    expect(calls.some((u) => u.includes("safe_prompt"))).toBe(false);
  });

  it("does NOT ask for the tier with an empty keyword list", async () => {
    // The backend refuses to run it without keywords, so sending the flag alone
    // would ask for a filter it will not get.
    const calls = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "", [SAFE_VIEW_SETTINGS.matchPrompt]: true });
    stubFetch({ "": { files: ALL } }, calls);
    await open();
    expect(calls.some((u) => u.includes("/image_browser/list"))).toBe(true);
    expect(calls.some((u) => u.includes("safe_prompt"))).toBe(false);
  });
});

describe("Safe View — the scanning pill", () => {
  const ON = {
    [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
    [SAFE_VIEW_SETTINGS.matchPrompt]: true,
  };
  const FILES = [{ name: "holiday.png", ...PNG, prompt_match: "unscanned" }];

  function pill(modal) {
    return modal.dialog.querySelector(".ib-scan-pill");
  }

  it("reports the count, then hides once the listing is fully scanned", async () => {
    // ONE test, both directions, driven by a real navigation. Asserting only
    // that the pill appears passes against a pill that is always visible;
    // asserting only that it hides passes against one that never shows. The
    // descent into a fully-scanned folder is what makes each half falsifiable.
    stubSettings(ON);
    stubFetch({
      "": { dirs: [{ name: "done" }], files: FILES, unscanned: 7 },
      done: { files: [{ name: "scanned.png", ...PNG, prompt_match: false }], unscanned: 0 },
    });
    const modal = await open();
    expect(pill(modal).style.display).not.toBe("none");
    expect(pill(modal).textContent).toContain("7");

    modal.bodyEl.querySelector(".ib-card.is-dir").click();
    await vi.waitFor(() => {
      if (!card(modal, "scanned.png")) throw new Error("subfolder not rendered");
    });
    expect(pill(modal).style.display).toBe("none");
  });

  it("stays hidden when the tier is off, however the response is shaped", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES } });
    const modal = await open();
    expect(pill(modal).style.display).toBe("none");
  });
});

describe("Safe View — the executed cache warmer", () => {
  const ON = {
    [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
    [SAFE_VIEW_SETTINGS.matchPrompt]: true,
  };
  let uninstall = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  /**
   * Dispatch an `executed` message where a real one lands: at `app.api`, the
   * EventTarget ComfyUI's own `dispatchCustomEvent` fires on. `installScanWarm`
   * binds to the MODULE's `app`, not to `globalThis.app` (which stubSettings
   * owns), so this must be the same object the module imported — dispatching
   * anywhere else would pass with the listener removed entirely.
   */
  function fireExecuted(output) {
    app.api.dispatchEvent(
      new CustomEvent("executed", { detail: { node: "9", prompt_id: "p", output } }),
    );
  }

  it("posts the images AND the videos a render produced", async () => {
    // `video` is the half the original plan missed. This pack lists videos and
    // the backend reads MP4/WebM, so skipping them would leave every fresh clip
    // permanently unscanned — and therefore permanently blurred.
    const posts = [];
    stubSettings(ON);
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({
      images: [{ filename: "a.png", subfolder: "d", type: "output" }],
      video: [{ filename: "b.mp4", subfolder: "", type: "output" }],
    });
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no warm posted");
    });
    expect(posts[0].url).toContain("/image_browser/safeview_warm");
    expect(posts[0].body.items).toEqual([
      { type: "output", subfolder: "d", name: "a.png" },
      { type: "output", subfolder: "", name: "b.mp4" },
    ]);
  });

  it("SKIPS an item with no filename rather than posting a bogus address", async () => {
    // zResultItem marks every field optional. Destructuring blind builds
    // `undefined` into an address and posts it — which is how a warm request
    // ends up scanning something that is not the file.
    const posts = [];
    stubSettings(ON);
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({
      images: [
        { subfolder: "d", type: "output" },
        { filename: "real.png", type: "output" },
      ],
    });
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no warm posted");
    });
    expect(posts[0].body.items).toEqual([{ type: "output", subfolder: "", name: "real.png" }]);
  });

  it("does not post AUDIO, while still posting the image beside it", async () => {
    // One assertion, both directions. `posts === []` on an audio-only payload
    // passes against a warmer that never posts anything — so the image has to
    // be in the same payload and has to come through.
    const posts = [];
    stubSettings(ON);
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({
      audio: [{ filename: "a.flac", type: "output" }],
      images: [{ filename: "b.png", type: "output" }],
    });
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no warm posted");
    });
    expect(posts[0].body.items).toEqual([{ type: "output", subfolder: "", name: "b.png" }]);
  });

  it("posts nothing while the tier is off, and starts the moment it is on", async () => {
    // The setting is read per EVENT, so both directions fit in one test — and
    // they have to: "no posts" alone passes against a warmer that never posts,
    // which is indistinguishable from one correctly held back by the setting.
    const posts = [];
    const host = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({ images: [{ filename: "a.png", type: "output" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]);

    host.set(SAFE_VIEW_SETTINGS.matchPrompt, true);
    fireExecuted({ images: [{ filename: "b.png", type: "output" }] });
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no warm posted after enabling");
    });
    expect(posts[0].body.items).toEqual([{ type: "output", subfolder: "", name: "b.png" }]);
  });

  it("stops listening after teardown", async () => {
    // Fire once BEFORE tearing down. Without that half, "no posts after
    // teardown" is satisfied by a listener that was never installed — the one
    // outcome a teardown test must not be able to mistake for success.
    const posts = [];
    stubSettings(ON);
    stubFetch({}, [], posts);
    const stop = installScanWarm();
    fireExecuted({ images: [{ filename: "a.png", type: "output" }] });
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no warm posted while installed");
    });

    stop();
    fireExecuted({ images: [{ filename: "b.png", type: "output" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts.map((p) => p.body.items[0].name)).toEqual(["a.png"]);
  });
});

// --------------------------------------------------------------------------
// The dc:subject tag tier — matching on a file's keywords, and the 🙈 control
// that writes them.
// --------------------------------------------------------------------------

/**
 * Fetch stub for the tag tests.
 *
 * Distinct from `stubFetch` above because a /tag POST has to answer with a
 * `tags` array, and because these tests need to control what the SERVER says
 * was stored independently of what was sent — the whole point of the repaint
 * assertion. `tagReply` receives the parsed request body and returns the list
 * the server claims to hold afterwards.
 */
function stubTagFetch(files, posts = [], tagReply = (body) => (body.present ? [body.tag] : [])) {
  const fn = vi.fn(async (url, init) => {
    const s = String(url);
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push({ url: s, body });
      if (s.includes("/image_browser/tag")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, tags: tagReply(body) }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (s.includes("/image_browser/pins")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
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
    if (s.includes("/image_browser/list")) {
      const type = new URL(s, "http://localhost").searchParams.get("type") ?? "output";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type,
          subfolder: "",
          path: "/out",
          dirs: [],
          files,
          exists: true,
          truncated: false,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The 🙈 control on `name`'s card, or null when it was not rendered. */
function markBtn(modal, name) {
  return card(modal, name)?.querySelector('[data-action="marksensitive"]') ?? null;
}

describe("Safe View — the dc:subject tag tier", () => {
  const TAGGED = [
    { name: "a.png", ...PNG, tags: ["nsfw"] },
    { name: "b.png", ...PNG, tags: [] },
  ];

  it("blurs a file whose TAGS carry the keyword and leaves an untagged one alone", async () => {
    // BOTH DIRECTIONS, one test. "A tagged file is blurred" alone is satisfied
    // by a tier that blurs everything; "an untagged file is not" alone by a tier
    // that blurs nothing. Both names are innocent and both sit in the same
    // innocent folder, so nothing but the keywords can decide either card.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubTagFetch(TAGGED);
    const modal = await open();
    expect(isBlurred(card(modal, "a.png"))).toBe(true);
    expect(isBlurred(card(modal, "b.png"))).toBe(false);
  });

  it("CONTROL: a tag is TOKENIZED, not compared whole", async () => {
    // `nsfw art` must match `nsfw`; `assets` must not match `ass`. The positive
    // alone passes against a substring matcher, the negative alone against an
    // inert one — and a whole-tag `===` comparison fails the positive. This is
    // the assertion that keeps this pack agreeing with comfyui-gallery-loader
    // about the same file on the same disk.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw, ass" });
    stubTagFetch([
      { name: "a.png", ...PNG, tags: ["nsfw art"] },
      { name: "b.png", ...PNG, tags: ["assets"] },
    ]);
    const modal = await open();
    expect(isBlurred(card(modal, "a.png"))).toBe(true);
    expect(isBlurred(card(modal, "b.png"))).toBe(false);
  });

  it("a row with NO tags key is not treated as a match", async () => {
    // An older backend sends no `tags` at all. Absent must read as "no
    // keywords", never as an unknown to fail safe on — this tier's four-state
    // trap belongs to `prompt_match`, not here, and blurring every card against
    // a backend that predates the field would be indistinguishable from the
    // feature simply being broken.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubTagFetch([
      { name: "a.png", ...PNG },
      { name: "my_nsfw_pic.png", ...PNG },
    ]);
    const modal = await open();
    expect(isBlurred(card(modal, "a.png"))).toBe(false);
    // Paired positive: the name tier must still work on the same listing, or
    // this passes against a grid that blurs nothing at all.
    expect(isBlurred(card(modal, "my_nsfw_pic.png"))).toBe(true);
  });
});

describe("Safe View — the 🙈 mark-sensitive control", () => {
  const FILES = [
    { name: "a.png", ...PNG, tags: [] },
    { name: "marked.png", ...PNG, tags: ["nsfw"] },
  ];

  it("renders on a sandboxed card and NOT on the browse…/path tab", async () => {
    // A tag write is a WRITE, so it rides the per-card canWriteFile mirror:
    // /image_browser/tag rejects type=path, and a control that 400s is worse
    // than no control. Both halves in one test — asserting only the absence
    // passes against a build that never renders the button anywhere.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubTagFetch(FILES);
    const modal = await open();
    expect(markBtn(modal, "a.png")).not.toBeNull();

    modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
    await vi.waitFor(() => {
      if (markBtn(modal, "a.png")) throw new Error("still rendered on the path tab");
    });
    // …and the grid really did repaint, so the absence above is not just an
    // empty grid.
    expect(card(modal, "a.png")).not.toBeNull();
  });

  it("is not offered at all when the keyword list is empty", async () => {
    // There is no packaged fallback: writing `nsfw` into a file whose owner
    // filters on something else produces a file that says "marked" and is not
    // hidden — the one outcome a discretion feature must never have.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "" });
    stubTagFetch(FILES);
    const modal = await open();
    expect(markBtn(modal, "a.png")).toBeNull();
    // Paired: with a keyword configured, the same card DOES get the control.
    modal.close();
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    const modal2 = await open();
    expect(markBtn(modal2, "a.png")).not.toBeNull();
  });

  it("reflects whether the file already carries EXACTLY the keyword", async () => {
    // `aria-pressed` decides which way the next tap writes. Exact, not "would
    // the filter match it": a file tagged `nsfw art` is hidden by `nsfw` but
    // does not carry it, and offering to REMOVE a keyword that is not on the
    // file would be a tap that does nothing.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubTagFetch([...FILES, { name: "phrase.png", ...PNG, tags: ["nsfw art"] }]);
    const modal = await open();
    expect(markBtn(modal, "marked.png").getAttribute("aria-pressed")).toBe("true");
    expect(markBtn(modal, "a.png").getAttribute("aria-pressed")).toBe("false");
    expect(markBtn(modal, "phrase.png").getAttribute("aria-pressed")).toBe("false");
  });

  it("POSTs the card's own address and does NOT open the file", async () => {
    // The second half is the trap the gallery-loader implementation already
    // solved: the mark button sits inside the card, so a handler that did not
    // consume the tap would ALSO run the card's own click — which here opens
    // the file in a new tab.
    //
    // BOTH DIRECTIONS. "window.open was not called" is trivially satisfied by a
    // build where the card handler is broken outright, so the same test then
    // taps the card body and requires that one to open.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    const posts = [];
    stubTagFetch(FILES, posts);
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const modal = await open();

    markBtn(modal, "a.png").click();
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no tag POST");
    });
    expect(posts[0].url).toContain("/image_browser/tag");
    expect(posts[0].body).toEqual({
      type: "output",
      subfolder: "",
      name: "a.png",
      tag: "nsfw",
      present: true,
    });
    expect(opened).not.toHaveBeenCalled();

    card(modal, "a.png").querySelector(".ib-name").click();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("repaints from what the SERVER stored, not from the local guess", async () => {
    // `postTag` resolves to the keywords read back OFF THE FILE after the
    // write, and that answer is authoritative — it can disagree with what the
    // tap assumed. Here the server accepts the request and reports that the
    // keyword is NOT on the file (a concurrent unmark from the other pack, a
    // write that landed in a sidecar the reader then refused): the truthful
    // repaint is unmarked and unblurred.
    //
    // This is the assertion an optimistic `f.tags = next ? [keyword] : []`
    // fails and every weaker one passes. Asserting the marked case alone does
    // NOT discriminate — the guess and the truth agree whenever the write lands,
    // which is the common case — so the second card below is the pair: same
    // request shape, a server that confirms, and the opposite expectation.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    const posts = [];
    stubTagFetch(
      [
        { name: "refused.png", ...PNG, tags: [] },
        { name: "ok.png", ...PNG, tags: [] },
      ],
      posts,
      (body) => (body.name === "refused.png" ? [] : ["NSFW", "holiday"]),
    );
    const modal = await open();

    markBtn(modal, "refused.png").click();
    markBtn(modal, "ok.png").click();
    await vi.waitFor(() => {
      if (posts.length < 2) throw new Error("both taps not posted");
      if (markBtn(modal, "ok.png")?.getAttribute("aria-pressed") !== "true") {
        throw new Error("confirmed card not repainted as marked");
      }
    });
    // The server said the keyword is not there — so the card is not marked and
    // not blurred, however the tap was meant.
    expect(markBtn(modal, "refused.png").getAttribute("aria-pressed")).toBe("false");
    expect(isBlurred(card(modal, "refused.png"))).toBe(false);
    // …and the one it confirmed IS, including through a casing the request did
    // not send: `hasSensitiveTag` compares case-insensitively, so `NSFW` reads
    // as carrying `nsfw`.
    expect(isBlurred(card(modal, "ok.png"))).toBe(true);
  });

  it("surfaces a failed write instead of painting it as done", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    const fn = vi.fn(async (url, init) => {
      const s = String(url);
      if (init?.method === "POST" && s.includes("/image_browser/tag")) {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: "disk full" }) };
      }
      if (s.includes("/image_browser/pins")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
      }
      if (s.includes("/image_browser/list")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            type: "output",
            subfolder: "",
            path: "/out",
            dirs: [],
            files: [{ name: "a.png", ...PNG, tags: [] }],
            exists: true,
            truncated: false,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fn);
    const modal = await open();

    markBtn(modal, "a.png").click();
    await vi.waitFor(() => {
      if (!document.querySelector(".cmn-toast")) throw new Error("no toast");
    });
    // The card is still unmarked and still unblurred — the failure did not get
    // painted as a successful mark.
    expect(markBtn(modal, "a.png").getAttribute("aria-pressed")).toBe("false");
    expect(isBlurred(card(modal, "a.png"))).toBe(false);
  });
});

describe("Safe View — the tag tier on the pinned tab", () => {
  it("blurs a pinned file by its tags, and 🙈 shows its true pressed state there", async () => {
    // Pins span roots, so a pinned row is built by `pinsToFiles` rather than by
    // a /list response — a separate construction path that has to carry `tags`
    // of its own. It does not participate in the PROMPT tier (no verdict is
    // resolved for a pin), but the tag tier is not a second read: /pins builds
    // its row through the same `_scan_file_entry`, so the keywords are already
    // there.
    //
    // BOTH DIRECTIONS: a tagged pin blurred AND an untagged one left alone, so
    // neither an inert path nor a blur-everything one passes. The 🙈 assertion
    // is the second half of the same bug — dropping `tags` here would leave the
    // control reading "unmarked" on a file that IS marked, and the first tap
    // would try to add a keyword the file already carries.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    const fn = vi.fn(async (url, init) => {
      const s = String(url);
      if (init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ ok: true, tags: [] }) };
      }
      if (s.includes("/image_browser/pins")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            max: 200,
            pins: [
              {
                kind: "file",
                type: "output",
                subfolder: "",
                name: "marked.png",
                exists: true,
                ...PNG,
                tags: ["nsfw"],
              },
              {
                kind: "file",
                type: "output",
                subfolder: "",
                name: "plain.png",
                exists: true,
                ...PNG,
                tags: [],
              },
            ],
          }),
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
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "output",
          subfolder: "",
          path: "/out",
          dirs: [],
          files: [{ name: "seed.png", ...PNG, tags: [] }],
          exists: true,
          truncated: false,
        }),
      };
    });
    vi.stubGlobal("fetch", fn);
    const modal = await open();

    modal.dialog.querySelector('.ib-tab[data-type="pinned"]').click();
    await vi.waitFor(() => {
      if (!card(modal, "marked.png")) throw new Error("pinned grid not rendered");
    });

    expect(isBlurred(card(modal, "marked.png"))).toBe(true);
    expect(isBlurred(card(modal, "plain.png"))).toBe(false);
    expect(markBtn(modal, "marked.png").getAttribute("aria-pressed")).toBe("true");
    expect(markBtn(modal, "plain.png").getAttribute("aria-pressed")).toBe("false");
  });
});
