import { describe, expect, test } from "vitest";
import { emblemSpec } from "../src/game/emblem";
import { FLAG_CHARGES, FLAG_LAYOUTS, LEGACY_CHARGES, chargeCenter, generateFlag, normalizeCharge, regionAt, renderFlag, type FlagSpec } from "../src/game/flags";
import type { Culture } from "../src/game/WorldData";

const FAMILIES = ["Desert", "Eastern", "Slavic", "Germanic", "Nordic", "Latin", "Celtic", "Other"];
const COLORS = ["#c0392b", "#2e86c1", "#28b463", "#d4ac0d", "#8e44ad", "#a04000", "#17a589"];

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
};

// Culture emblems and default flags (with and without a culture hint)
function sample(version: string) {
  const out: unknown[] = [];
  for (let i = 0; i < 600; i++) {
    const family = FAMILIES[i % FAMILIES.length];
    const color = COLORS[i % COLORS.length];
    const c = { id: i, name: `Realm${i}`, color, centerX: 0, centerY: 0, logoSeed: i % 3 ? i : undefined } as Culture;
    const e = emblemSpec(c, family, version);
    const hint = { color, charge: e.charge };
    out.push(e, generateFlag(c.name, color, family, 0, hint, version), generateFlag(c.name, color, family, i % 5, undefined, version));
  }
  return out;
}

// Just enough of a canvas for drawing code to run in Node
function fakeCanvas() {
  const ctx: object = new Proxy(
    {},
    {
      get: (_, k) => (k === "createImageData" ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}),
      set: () => true,
    },
  );
  return { width: 0, height: 0, getContext: () => ctx };
}

describe("flags", () => {
  test("0.1 flags and emblems are as they were, a retired emblem aside", () => {
    // Hash of the 0.1 output from before the emblem set grew, with the retired
    // emblem read as the sun that now takes its slot
    const s = JSON.stringify(sample("0.1"));
    expect(s.length).toBe(303068);
    expect(fnv(s)).toBe("57e5b53f");
  });

  test("0.2 flags and emblems draw from the full set, and only from it", () => {
    const used = new Set<string>();
    for (const x of sample("0.2")) used.add((x as FlagSpec).charge);
    for (const c of used) expect(FLAG_CHARGES).toContain(c);
    expect(used.has("wheel")).toBe(false);
    const fresh = FLAG_CHARGES.filter((c) => !LEGACY_CHARGES.includes(c));
    expect(fresh.length).toBeGreaterThanOrEqual(8);
    expect(fresh.filter((c) => used.has(c)).length).toBe(fresh.length);
  });

  test("layout-fitted emblem spots sit on a single field", () => {
    for (const layout of FLAG_LAYOUTS)
      for (const pos of ["center", "hoist", "canton"] as const) {
        const [x, y, k] = chargeCenter(pos, 1.5, 1, layout);
        const [px, py] = chargeCenter(pos, 1.5, 1);
        // Unfitted spots keep the plain anchor; the sunburst hub is meant to straddle
        if ((x === px && y === py) || layout === "rays") continue;
        const r0 = regionAt(layout, x / 1.5, y);
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          expect(regionAt(layout, (x + Math.cos(a) * k * 0.8) / 1.5, y + Math.sin(a) * k * 0.8), `${layout} ${pos}`).toBe(r0);
        }
      }
  });

  test("saved charges are normalized", () => {
    expect(normalizeCharge("wheel")).toBe("sun");
    expect(normalizeCharge("anchor")).toBe("anchor");
    expect(normalizeCharge("nonsense")).toBe("none");
  });

  test("every charge, and a retired one, draws without throwing", () => {
    const g = globalThis as { document?: unknown };
    const had = g.document;
    g.document = { createElement: fakeCanvas };
    try {
      const base = generateFlag("Test", "#2e86c1", "Latin");
      for (const charge of [...FLAG_CHARGES, "wheel"])
        for (const chargePos of ["center", "hoist", "canton"] as const)
          expect(() => renderFlag({ ...base, charge: charge as FlagSpec["charge"], chargePos }, 30, 20)).not.toThrow();
    } finally {
      g.document = had;
    }
  });
});
