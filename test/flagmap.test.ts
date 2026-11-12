import { describe, expect, it } from "vitest";
import { FLAG_ASPECT, layoutFlags } from "../src/ui/FlagMapRenderer";

// A W×H world of water with rectangles of land owned by nations
function world(W: number, H: number, blocks: [n: number, x0: number, y0: number, x1: number, y1: number, land?: boolean][]) {
  const water = new Uint8Array(W * H).fill(1);
  const owner = new Int32Array(W * H).fill(-1);
  for (const [n, x0, y0, x1, y1, land = true] of blocks)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * W + (((x % W) + W) % W);
        owner[i] = n;
        if (land) water[i] = 0;
      }
  return { water, owner };
}

describe("nations as flags: layout", () => {
  it("keeps a realm split by the date line under one flag", () => {
    const W = 40;
    const { water, owner } = world(W, 12, [[0, 37, 2, 42, 9]]); // columns 37..39 and 0..2
    const { placements, cells } = layoutFlags(W, 12, water, owner);
    expect(placements).toHaveLength(1);
    const p = placements[0];
    // Centered on the seam, not on the far side of the world
    const d = Math.min(p.cx, W - p.cx);
    expect(d).toBeLessThan(0.01);
    expect(p.w).toBeGreaterThanOrEqual(6);
    expect(p.h).toBeCloseTo(p.w / FLAG_ASPECT);
    expect(cells[5 * W + 0]).toBe(1);
    expect(cells[5 * W + 38]).toBe(1);
  });

  it("shares the flag with a nearby island and gives a far exclave its own copy", () => {
    const W = 80;
    const H = 30;
    const { water, owner } = world(W, H, [
      [0, 5, 5, 24, 20], // mainland
      [0, 27, 10, 28, 11], // island just off the coast
      [0, 60, 8, 66, 12], // far exclave
    ]);
    const { placements, cells } = layoutFlags(W, H, water, owner);
    expect(placements).toHaveLength(2);
    expect(cells[10 * W + 27]).toBe(cells[10 * W + 10]); // the island shows the matching part
    const far = placements[cells[10 * W + 62] - 1];
    expect(cells[10 * W + 62]).not.toBe(cells[10 * W + 10]);
    expect(far.cx).toBeCloseTo((60 + 66 + 1) / 2);
    // Cover fit, centered on the mainland box
    const main = placements[cells[10 * W + 10] - 1];
    expect(main.cx).toBeCloseTo((5 + 28 + 1) / 2);
    expect(main.w).toBeGreaterThanOrEqual(24);
  });

  it("shows a tiny realm's whole flag on its land", () => {
    const { water, owner } = world(20, 10, [[3, 7, 4, 8, 4]]); // two cells
    const { placements } = layoutFlags(20, 10, water, owner);
    expect(placements).toHaveLength(1);
    const p = placements[0];
    expect(p.nation).toBe(3);
    expect(p.cx).toBeCloseTo(8);
    expect(p.cy).toBeCloseTo(4.5);
    // Contained: no wider than the realm, no taller than it either
    expect(p.w).toBeLessThanOrEqual(2);
    expect(p.h).toBeLessThanOrEqual(1);
  });

  it("gives claimed waters the flag of the nearest land", () => {
    const W = 30;
    const { water, owner } = world(W, 10, [
      [0, 2, 2, 12, 7, false], // claim
      [0, 4, 3, 8, 6], // land inside it
      [1, 20, 2, 26, 7],
    ]);
    const { cells } = layoutFlags(W, 10, water, owner);
    expect(cells[2 * W + 2]).toBe(cells[4 * W + 5]);
    expect(cells[2 * W + 2]).toBeGreaterThan(0);
    expect(cells[0]).toBe(0); // unclaimed sea
    expect(cells[4 * W + 22]).not.toBe(cells[4 * W + 5]);
  });
});
