// Pure-helper tier for src/label.ts. No DOM, no layout — these assert what the
// two spans CONTAIN. Where the ellipsis actually lands, and whether the tail's
// box stays inside the card, are rendered questions that only
// tests/e2e/selection.spec.js's tier can answer.
//
// Every fixture below is a REAL filename sampled from the reference install's
// output tree, not a name shaped to suit the assertion. That matters twice
// over: the counter turned out to have two on-disk spellings (`_00001_` and a
// bare `_00018`), and a whole class of names predates the naming convention
// entirely — both of which a hand-written fixture set would have missed.

import { describe, expect, it } from "vitest";
import { labelParts, splitTail, stripCounter } from "../../src/label.js";

// Sampled 2026-08-18 from /mnt/sabrent/comfyui-workspace/ComfyUI/output.
const CONVENTION = "105129_euler_flux2sched_s633110127082924_klein-snofs-i2i-pid4k_00001_.png";
const CONVENTION_NO_DESCRIPTOR = "192900_euler_ancestral_cfg_pp_beta57_s299049934664422_00001_.png";
const WRAPPER_VIDEO = "141151_unipc_unipc_s1490672225027_25steps_WanVideoWrapper_I2V_00074.png";
const LEGACY = "flux_kontext_00078_.png";
const LEGACY_SIBLING = "flux_kontext_00037_.png";

describe("stripCounter", () => {
  it("drops the trailing _00001_ counter and KEEPS the extension", () => {
    // The extension is kept on purpose: a thumbnail says "image" or "video",
    // never which container, and in this workspace .webm-vs-.mp4 decides
    // whether a clip is decodable by the graph that loads it.
    expect(stripCounter(CONVENTION)).toBe(
      "105129_euler_flux2sched_s633110127082924_klein-snofs-i2i-pid4k.png",
    );
  });

  it("drops a counter written WITHOUT a trailing underscore", () => {
    // kijai's WanVideoWrapper writes `_00074`, core SaveImage writes `_00001_`.
    // A pattern matching only the latter leaves a bare five-digit tail on every
    // video the wrapper produced — precisely the uninformative tail this module
    // exists to get rid of.
    expect(stripCounter(WRAPPER_VIDEO)).toBe(
      "141151_unipc_unipc_s1490672225027_25steps_WanVideoWrapper_I2V.png",
    );
  });

  it("KEEPS the counter on a name with no hhmmss prefix, where it is the identity", () => {
    // The two-sided half of this pair is the point. Stripping unconditionally
    // is a plausible reading of "the counter carries nothing", and it would
    // collapse these two distinct files onto one label.
    expect(stripCounter(LEGACY)).toBe(LEGACY);
    expect(stripCounter(LEGACY_SIBLING)).toBe(LEGACY_SIBLING);
    expect(stripCounter(LEGACY)).not.toBe(stripCounter(LEGACY_SIBLING));
  });

  it("never strips to empty", () => {
    expect(stripCounter(".png")).toBe(".png");
    expect(stripCounter("000123_.png")).toBe("000123_.png");
  });

  it("leaves a name with no counter untouched", () => {
    expect(stripCounter("2026-08-18")).toBe("2026-08-18");
    expect(stripCounter("_manifest.json")).toBe("_manifest.json");
    expect(stripCounter("notes.txt")).toBe("notes.txt");
  });
});

describe("splitTail", () => {
  it("holds back whole tokens, so the tail reads as a descriptor", () => {
    const { head, tail } = splitTail(
      "105129_euler_flux2sched_s633110127082924_klein-snofs-i2i-pid4k",
    );
    // Not "-snofs-i2i-pid4k" (16 chars): that exceeds the 14-char budget, so
    // the longest boundary-anchored run that FITS is taken.
    expect(tail).toBe("-i2i-pid4k");
    expect(head + tail).toBe("105129_euler_flux2sched_s633110127082924_klein-snofs-i2i-pid4k");
    // The head still opens with the time, which is what survives the ellipsis
    // and what makes a name-sorted grid readable.
    expect(head.startsWith("105129")).toBe(true);
  });

  it("returns a short name whole, with nothing to elide", () => {
    expect(splitTail("short.png")).toEqual({ head: "", tail: "short.png" });
  });

  it("falls back to a fixed cut when no boundary is in range", () => {
    // 30 unbroken characters: there is no _ or - to prefer, so the tail is
    // exactly minTail. Ugly, and still identifying.
    const { head, tail } = splitTail("abcdefghijklmnopqrstuvwxyz0123");
    expect(tail).toBe("wxyz0123");
    expect(head).toBe("abcdefghijklmnopqrstuv");
  });

  it("always reassembles to the input", () => {
    for (const n of [CONVENTION, WRAPPER_VIDEO, LEGACY, "a", "", "a_b", "x".repeat(200)]) {
      const { head, tail } = splitTail(n);
      expect(head + tail).toBe(n);
    }
  });

  it("honours explicit bounds", () => {
    const { tail } = splitTail("105129_euler_beta_s847362819384_klein-snofs", 4, 30);
    expect(tail.length).toBeLessThanOrEqual(30);
    // The LONGEST boundary-anchored run within 30, not the shortest.
    expect(tail).toBe("_s847362819384_klein-snofs");
  });
});

describe("labelParts", () => {
  it("shapes a name by default, keeping descriptor AND container in the tail", () => {
    const { head, tail } = labelParts(CONVENTION, false);
    expect(tail).toBe("-i2i-pid4k.png");
    expect(head).not.toBe("");
    // The head still opens with the time, which is what survives the ellipsis.
    expect(head.startsWith("105129")).toBe(true);
  });

  it("renders VERBATIM while a query is active, so matched characters stay visible", () => {
    // A user who typed `00001` must be able to see what they matched. Two-sided
    // against the shaped case above: an implementation that ignores `verbatim`
    // fails here, and one hard-wired to verbatim fails there.
    const { head, tail } = labelParts(CONVENTION, true);
    expect(head).toBe("");
    expect(tail).toBe(CONVENTION);
    expect(tail).toContain("00001");
  });

  it("keeps a no-descriptor name's seed as the tail, not its counter", () => {
    // This class has nothing but sampler/scheduler/seed after the time, so the
    // seed is the discriminator.
    const { head, tail } = labelParts(CONVENTION_NO_DESCRIPTOR, false);
    expect(tail).not.toContain("00001");
    expect(head + tail).toBe("192900_euler_ancestral_cfg_pp_beta57_s299049934664422.png");
  });

  it("distinguishes the two legacy siblings that a naive strip would merge", () => {
    const a = labelParts(LEGACY, false);
    const b = labelParts(LEGACY_SIBLING, false);
    expect(a.tail).not.toBe(b.tail);
  });

  it("leaves a short name whole, with no head to elide", () => {
    expect(labelParts("b.mp4", false)).toEqual({ head: "", tail: "b.mp4" });
  });
});
