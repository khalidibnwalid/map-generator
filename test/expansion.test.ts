import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { Simulation } from "../src/game/sim/Simulation";
import { bandCount, conquestPeriods, CORE, everyYears, expansionOf, expansionShades, lightness, LOST, NONE, normalizeBounds, paletteColors, smartPalette, smartPeriods, SMART_MAX, type Expansion } from "../src/ui/ExpansionPoster";

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
  const exp = expansionOf(world, sim, best.i)!; // default: a period every 10 years
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
  expect(exp.step).toEqual({ asked: 10, used: 10 });
  for (let k = 0; k < exp.periods.length; k++) {
    const p = exp.periods[k];
    expect(p.from).toBeLessThanOrEqual(p.to);
    if (k === 0 || k === exp.periods.length - 1) expect(p.cells).toBeGreaterThan(0); // empty ends are dropped
    else expect(p.to - p.from + 1).toBe(10);
    if (k > 0) expect(p.from).toBe(exp.periods[k - 1].to + 1);
  }
  expect(exp.periods[0].from).toBeGreaterThanOrEqual(exp.startYear + 1);
  expect(exp.periods[exp.periods.length - 1].to).toBeLessThanOrEqual(exp.endYear);

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
  const early = expansionOf(world, sim, best.i, { endYear: mid, split: { kind: "bands", count: 4 } })!;
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

test("period shades: evenly lighter, never black or white, for mid, pale and dark realm colors", () => {
  for (const color of ["#b03a2e", "#f3d9e2", "#1d2a55", "#6f8f3a", "#808080"]) {
    for (const periods of [1, 2, 5, 6, 8, 12]) {
      const shades = expansionShades(color, periods);
      expect(shades.length).toBe(periods + 1);
      const L = shades.map(lightness);
      expect(L[0]).toBeGreaterThan(0.28);
      expect(L[L.length - 1]).toBeLessThan(0.94);
      // A slightly smaller step is fine past 6 periods
      for (let k = 1; k < L.length; k++) expect(L[k] - L[k - 1]).toBeGreaterThan(periods > 6 ? 0.045 : 0.06);
      expect(shades.every((c) => c.some((v) => v < 250))).toBe(true);
    }
  }
});

// Every land cell held at the end and first taken after the start sits in exactly one period
function checkPeriods(exp: Expansion) {
  const sum = new Array(exp.periods.length).fill(0);
  for (let i = 0; i < exp.cls.length; i++) {
    const c = exp.cls[i];
    if (c >= 1) {
      expect(c).toBeLessThanOrEqual(exp.periods.length);
      sum[c - 1]++;
    } else if (c === NONE) expect(exp.firstHeld[i]).toBe(-1);
  }
  expect(exp.periods.map((p) => p.cells)).toEqual(sum);
  expect(exp.counts.core + exp.counts.lost + sum.reduce((a, b) => a + b, 0)).toBe(exp.counts.everHeld);
  for (let k = 1; k < exp.periods.length; k++) expect(exp.periods[k].from).toBe(exp.periods[k - 1].to + 1);
}

test("periods every N years: 10 by default, 12.5 alternates 13 and 12, no limit on how many", () => {
  const ten = everyYears(0, 120, 10);
  expect(ten.used).toBe(10);
  expect(ten.bounds.map((b) => [b.from, b.to])).toEqual(Array.from({ length: 12 }, (_, k) => [k * 10 + 1, k * 10 + 10]));
  const half = everyYears(0, 100, 12.5);
  const spans = half.bounds.slice(0, -1).map((b) => b.to - b.from + 1);
  expect(spans).toEqual([13, 12, 13, 12, 13, 12, 13]);
  expect(half.bounds[half.bounds.length - 1].to).toBe(100);
  const many = everyYears(0, 500, 10);
  expect(many.bounds.length).toBe(50);
  expect(many.used).toBe(10);
  expect(many.bounds[0].from).toBe(1);
  expect(many.bounds[many.bounds.length - 1].to).toBe(500);
  // Bands are whole, at least one, no upper limit
  expect([bandCount(4.6), bandCount(0), bandCount(30)]).toEqual([5, 1, 30]);
});

test("custom periods: sorted, clamped, gaps and overlaps snapped, names kept", () => {
  const n = normalizeBounds(
    [
      { from: 60, to: 2000, name: "  The Late Wars " },
      { from: -50, to: 20, name: "Founding" },
      { from: 31, to: 70 },
      { from: 900, to: 950 },
    ],
    0,
    120,
  );
  expect(n.bounds).toEqual([
    { from: 1, to: 20, name: "Founding" },
    { from: 21, to: 70 }, // the gap 21-30 snapped
    { from: 71, to: 120, name: "The Late Wars" }, // overlap snapped, clamped to the end
  ]);
  expect(n.notes.length).toBeGreaterThanOrEqual(4);
  expect(normalizeBounds([], 0, 50).bounds).toEqual([{ from: 1, to: 50 }]);
  const lots = normalizeBounds(Array.from({ length: 20 }, (_, k) => ({ from: k * 5 + 1, to: k * 5 + 5 })), 0, 100);
  expect(lots.bounds.length).toBe(20);
  expect(lots.bounds[19].to).toBe(100);
});

test("every split classifies each conquest once: years, 12.5 years, bands of 1 and 12, custom with names", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin("0.1");
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 90; i++) sim.step();
  const wins = new Map<string, number>();
  for (const b of sim.battles) wins.set(b.winner, (wins.get(b.winner) ?? 0) + b.size);
  const idx = world.nations.map((n, i) => ({ i, w: wins.get(n.name) ?? 0 })).sort((a, b) => b.w - a.w)[0].i;

  const years = expansionOf(world, sim, idx, { split: { kind: "years", every: 12.5 } })!;
  checkPeriods(years);
  expect(years.step).toEqual({ asked: 12.5, used: 12.5 });
  const inner = years.periods.slice(1, -1).map((p) => p.to - p.from + 1);
  for (const span of inner) expect([12, 13]).toContain(span);

  const capped = expansionOf(world, sim, idx, { split: { kind: "years", every: 1 } })!;
  checkPeriods(capped);
  expect(capped.step).toEqual({ asked: 1, used: 1 });

  const one = expansionOf(world, sim, idx, { split: { kind: "bands", count: 1 } })!;
  checkPeriods(one);
  expect(one.periods.length).toBe(1);
  expect(one.step).toBeNull();
  const twelve = expansionOf(world, sim, idx, { split: { kind: "bands", count: 12 } })!;
  checkPeriods(twelve);
  expect(twelve.periods.length).toBeGreaterThan(1);
  expect(twelve.periods.length).toBeLessThanOrEqual(12); // bands can merge where little was taken

  // Custom: a gap (31-40) and land past the last period fall into the nearest one
  const custom = expansionOf(world, sim, idx, {
    split: {
      kind: "custom",
      bounds: [
        { from: -10, to: 30, name: "The Founding Wars" },
        { from: 41, to: 60 },
        { from: 55, to: 9999, name: "Reign of Idris II" },
      ],
    },
  })!;
  checkPeriods(custom);
  expect(custom.periods.map((p) => [p.from, p.to, p.name])).toEqual([
    [custom.startYear + 1, 30, "The Founding Wars"],
    [31, 60, undefined],
    [61, custom.endYear, "Reign of Idris II"],
  ]);
  // Unsnapped rows (as typed, before the editor fixes them): gains in the gap go to the nearest period
  const gapped = expansionOf(world, sim, idx, { split: { kind: "custom", bounds: [{ from: 1, to: 20 }, { from: 61, to: custom.endYear }] } })!;
  checkPeriods(gapped);
  for (let i = 0; i < gapped.cls.length; i++) {
    if (gapped.cls[i] < 1) continue;
    const y = gapped.firstHeld[i];
    const p = gapped.periods[gapped.cls[i] - 1];
    expect(y >= p.from && y <= p.to).toBe(true); // snapped: 21-60 joined the second period
  }
  // Periods ending before the end year: later conquests fall into the nearest (last) one
  const short = expansionOf(world, sim, idx, { split: { kind: "custom", bounds: [{ from: 1, to: 20 }, { from: 21, to: 40 }] } })!;
  checkPeriods(short);
  let late = 0;
  for (let i = 0; i < short.cls.length; i++) {
    if (short.cls[i] < 1 || short.firstHeld[i] <= 40) continue;
    late++;
    expect(short.cls[i]).toBe(2);
  }
  expect(late).toBeGreaterThan(0);
}, 300_000);

test("every palette orders the core and periods from dark to light, the core its own color", () => {
  for (const kind of ["realm", "spectrum", "distinct", "custom", "smart"] as const)
    for (const periods of [1, 3, 6, 10]) {
      const c = paletteColors({ kind, from: "#3a1c5c", to: "#f6e27a" }, "#b03a2e", periods);
      expect(c.length).toBe(periods + 1);
      const L = c.map(lightness);
      for (let k = 1; k < L.length; k++) expect(L[k]).toBeGreaterThan(L[k - 1]);
      // The land it started with never shares a color with a period
      for (let k = 1; k < c.length; k++) expect(c[k].join()).not.toBe(c[0].join());
    }
  expect(smartPalette(3)).toBe("realm");
  expect(smartPalette(6)).toBe("spectrum");
  expect(smartPalette(12)).toBe("distinct");
});

test("smart periods follow the waves of conquest and cut in the quiet years", () => {
  // Three waves: 10-20, 60-70 and 150-160, quiet between
  const gains = new Map<number, number>();
  for (const [a, b] of [[10, 20], [60, 70], [150, 160]]) for (let y = a; y <= b; y++) gains.set(y, 5);
  const p = smartPeriods(gains, 0, 200);
  expect(p.length).toBe(3);
  expect(p[0].from).toBe(1);
  expect(p[p.length - 1].to).toBe(200);
  for (let k = 1; k < p.length; k++) expect(p[k].from).toBe(p[k - 1].to + 1);
  // Each wave inside its own period, each cut in the quiet stretch
  expect(p[0].to).toBeGreaterThanOrEqual(20);
  expect(p[0].to).toBeLessThan(60);
  expect(p[1].from).toBeLessThanOrEqual(60);
  expect(p[1].to).toBeGreaterThanOrEqual(70);
  expect(p[2].from).toBeLessThanOrEqual(150);

  // Many waves merge down to at most SMART_MAX; one steady wave splits into a few
  const many = new Map<number, number>();
  for (let w = 0; w < 20; w++) for (let y = w * 20 + 1; y <= w * 20 + 3; y++) many.set(y, 3);
  expect(smartPeriods(many, 0, 400).length).toBeLessThanOrEqual(SMART_MAX);
  const steady = new Map<number, number>();
  for (let y = 1; y <= 100; y++) steady.set(y, 2);
  expect(smartPeriods(steady, 0, 100).length).toBeGreaterThanOrEqual(2);
});

test("decline: the land still held is the core, every lost cell sits in the period it was lost", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin("0.1");
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 120; i++) sim.step();
  // The realm that lost the most land it once held
  let best = -1;
  let most = -1;
  for (let i = 0; i < world.nations.length; i++) {
    const e = expansionOf(world, sim, i);
    if (e && e.counts.lost > most) {
      most = e.counts.lost;
      best = i;
    }
  }
  const d = expansionOf(world, sim, best, { view: "decline", split: { kind: "smart" } })!;
  expect(d.view).toBe("decline");
  let core = 0;
  for (let i = 0; i < d.cls.length; i++) {
    const c = d.cls[i];
    if (c === CORE) core++;
    expect(c).not.toBe(LOST);
    if (c >= 1) {
      const p = d.periods[c - 1];
      const y = d.lostAt[i] >= 0 ? d.lostAt[i] : d.endYear;
      // In its period, or the nearest one when it fell in a gap
      if (y >= d.periods[0].from && y <= d.periods[d.periods.length - 1].to) {
        expect(y).toBeGreaterThanOrEqual(p.from);
        expect(y).toBeLessThanOrEqual(p.to);
      }
    }
  }
  expect(core).toBe(d.counts.core);
  expect(d.counts.core + d.periods.reduce((s, p) => s + p.cells, 0)).toBe(d.counts.everHeld);
}, 300_000);
