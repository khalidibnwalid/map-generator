import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { Simulation } from "../src/game/sim/Simulation";
import { conquestPeriods, CORE, expansionOf, expansionShades, lightness, LOST, NONE } from "../src/ui/ExpansionPoster";

test("a realm's expansion: every land cell it ever held is classified once, periods in order, its own battles", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin("0.1");
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 120; i++) sim.step();
  const frames = sim.history.frames;
  expect(frames.length).toBeGreaterThan(2);

  // The realm that grew the most by battle
  const wins = new Map<string, number>();
  for (const b of sim.battles) wins.set(b.winner, (wins.get(b.winner) ?? 0) + b.size);
  const best = world.nations.map((n, i) => ({ i, w: wins.get(n.name) ?? 0 })).sort((a, b) => b.w - a.w)[0];
  const exp = expansionOf(world, sim, best.i, { periods: 5 })!;
  expect(exp).not.toBeNull();
  expect(exp.startYear).toBe(frames[0].year);
  expect(exp.endYear).toBe(frames[frames.length - 1].year);

  // Who held each cell, year by year, rebuilt independently through the recorder
  const W = world.width;
  const N = W * world.height;
  const ever = new Uint8Array(N);
  const atStart = new Uint8Array(N);
  const atEnd = new Uint8Array(N);
  for (let f = 0; f < frames.length; f++) {
    const view = sim.history.view(f)!;
    const k = view.nations.findIndex((n) => n.uid === exp.uid);
    if (k < 0) continue;
    for (let i = 0; i < N; i++) {
      if (world.waterType[i] !== 0 || view.owner[i] !== k) continue;
      ever[i] = 1;
      if (f === 0) atStart[i] = 1;
      if (f === frames.length - 1) atEnd[i] = 1;
    }
  }

  let everHeld = 0;
  let core = 0;
  let lost = 0;
  const inPeriod = new Array(exp.periods.length).fill(0);
  for (let i = 0; i < N; i++) {
    const c = exp.cls[i];
    if (!ever[i]) {
      expect(c).toBe(NONE);
      continue;
    }
    everHeld++;
    // Exactly one class
    expect(c === CORE || c === LOST || (c >= 1 && c <= exp.periods.length)).toBe(true);
    if (!atEnd[i]) expect(c).toBe(LOST);
    else if (atStart[i]) expect(c).toBe(CORE);
    else {
      expect(c).toBeGreaterThanOrEqual(1);
      const p = exp.periods[c - 1];
      expect(exp.firstHeld[i]).toBeGreaterThanOrEqual(p.from);
      expect(exp.firstHeld[i]).toBeLessThanOrEqual(p.to);
    }
    if (c === CORE) core++;
    else if (c === LOST) lost++;
    else inPeriod[c - 1]++;
    // Vassal land is never land the realm held itself
    expect(exp.vassalCell[i]).toBe(-1);
  }
  expect(everHeld).toBeGreaterThan(0);
  expect(exp.counts.everHeld).toBe(everHeld);
  expect(core + lost + inPeriod.reduce((s, n) => s + n, 0)).toBe(everHeld);
  expect(exp.counts.core).toBe(core);
  expect(exp.counts.lost).toBe(lost);
  expect(exp.periods.map((p) => p.cells)).toEqual(inPeriod);
  // It grew: there are conquest periods, ordered and contiguous
  expect(exp.periods.length).toBeGreaterThan(0);
  expect(exp.periods.length).toBeLessThanOrEqual(5);
  for (let k = 0; k < exp.periods.length; k++) {
    const p = exp.periods[k];
    expect(p.from).toBeLessThanOrEqual(p.to);
    expect(p.cells).toBeGreaterThan(0);
    if (k > 0) expect(p.from).toBe(exp.periods[k - 1].to + 1);
  }
  expect(exp.periods[0].from).toBe(exp.startYear + 1);
  expect(exp.periods[exp.periods.length - 1].to).toBe(exp.endYear);

  // Greatest extent: no year had more of its land
  let peakMask = 0;
  for (let i = 0; i < N; i++) peakMask += exp.peak.mask[i];
  expect(peakMask).toBe(exp.peak.cells);
  expect(exp.peak.cells).toBeGreaterThanOrEqual(exp.counts.atEnd);

  // Its battles only, won and lost told apart
  const names = new Set(frames.flatMap((f) => f.nations.filter((n) => n.uid === exp.uid).map((n) => n.name)));
  expect(exp.battles.length).toBeGreaterThan(0);
  expect(exp.battles.length).toBeLessThanOrEqual(14);
  for (const b of exp.battles) {
    const src = sim.battles.find((s) => s.year === b.year && s.x === b.x && s.y === b.y)!;
    expect(src).toBeDefined();
    expect(names.has(src.winner) || names.has(src.loser)).toBe(true);
    expect(b.won).toBe(names.has(src.winner));
  }
  expect(exp.battleTotals.won + exp.battleTotals.lost).toBeGreaterThanOrEqual(exp.battles.length);

  // An earlier end year: the end is that year
  const mid = exp.startYear + 60;
  const early = expansionOf(world, sim, best.i, { endYear: mid, periods: 4 })!;
  expect(early.endYear).toBe(mid);
  expect(early.periods.every((p) => p.to <= mid)).toBe(true);
  expect(early.battles.every((b) => b.year <= mid)).toBe(true);
}, 300_000);

test("conquest periods split the gains into ordered, rounded, non-empty ranges", () => {
  const gains = new Map<number, number>();
  for (let y = 1; y <= 400; y++) gains.set(y, y < 100 ? 5 : y > 300 ? 1 : 2);
  const p = conquestPeriods(gains, 0, 400, 5);
  expect(p.length).toBe(5);
  expect(p[0].from).toBe(1);
  expect(p[p.length - 1].to).toBe(400);
  for (let k = 1; k < p.length; k++) {
    expect(p[k].from).toBe(p[k - 1].to + 1);
    expect(p[k].from % 10).toBe(0); // long histories split at round years
  }
  expect(p.reduce((s, q) => s + q.cells, 0)).toBe([...gains.values()].reduce((s, n) => s + n, 0));
  // Fewer distinct years than periods asked for
  expect(conquestPeriods(new Map([[7, 3]]), 0, 50, 5)).toEqual([{ from: 1, to: 50, cells: 3 }]);
  expect(conquestPeriods(new Map(), 0, 50, 5)).toEqual([]);
});

test("no recorded history, no expansion", async () => {
  const g = new MapGenerator(200, 120, 77);
  g.pin("0.1");
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  expect(expansionOf(world, sim, 0)).toBeNull();
});

test("at today's year the poster holds exactly the realm's land on the live map, edits included", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin("0.1");
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 60; i++) sim.step();
  const W = world.width;
  const N = W * world.height;
  const idx = world.nations.map((_, i) => i).sort((a, b) => count(b) - count(a))[0];
  function count(n: number) {
    let c = 0;
    for (let i = 0; i < N; i++) if (world.waterType[i] === 0 && world.grid[i % W][Math.floor(i / W)].nationIndex === n) c++;
    return c;
  }
  const heldAtEnd = (cls: number) => cls === CORE || cls >= 1;
  const check = () => {
    const exp = expansionOf(world, sim, idx)!;
    expect(exp.endYear).toBe(sim.year);
    for (let i = 0; i < N; i++) {
      if (world.waterType[i] !== 0) continue;
      const mine = world.grid[i % W][Math.floor(i / W)].nationIndex === idx;
      expect(heldAtEnd(exp.cls[i])).toBe(mine);
    }
    return exp;
  };
  check();

  // Land handed over after the last recorded year (painting, a transfer): on the
  // poster at once, in the last period when the realm never held it before
  const before = expansionOf(world, sim, idx)!;
  const moved: number[] = [];
  for (let i = 0; i < N && moved.length < 40; i++) {
    const c = world.grid[i % W][Math.floor(i / W)];
    if (world.waterType[i] !== 0 || c.nationIndex === undefined || c.nationIndex < 0 || c.nationIndex === idx || before.cls[i] !== NONE) continue;
    c.nationIndex = idx;
    moved.push(i);
  }
  expect(moved.length).toBe(40);
  const after = check();
  for (const i of moved) expect(after.cls[i]).toBe(after.periods.length);
  expect(after.peak.cells).toBeGreaterThanOrEqual(after.counts.atEnd);
}, 300_000);

test("period shades: one hue, evenly lighter, never black or white, for mid, pale and dark realm colors", () => {
  for (const color of ["#b03a2e", "#f3d9e2", "#1d2a55", "#6f8f3a", "#808080"]) {
    for (const periods of [5, 6]) {
      const shades = expansionShades(color, periods);
      expect(shades.length).toBe(periods + 1);
      const L = shades.map(lightness);
      expect(L[0]).toBeGreaterThan(0.34);
      expect(L[L.length - 1]).toBeLessThan(0.93);
      for (let k = 1; k < L.length; k++) expect(L[k] - L[k - 1]).toBeGreaterThan(0.06);
      expect(shades.every((c) => c.some((v) => v < 250))).toBe(true);
    }
  }
});
