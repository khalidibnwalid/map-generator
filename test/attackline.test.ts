import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { Simulation } from "../src/game/sim/Simulation";
import { lineTarget, sampleLine, simplifyLine, type LinePoint } from "../src/game/sim/frontLine";
import type { WorldData } from "../src/game/WorldData";

const ownerAt = (w: WorldData, i: number) => {
  const c = w.grid[i % w.width][Math.floor(i / w.width)];
  return c.isWater ? -1 : (c.nationIndex ?? -1);
};

// The two realms with the longest shared border, and that border's cells on
// the defender's side
function longestBorder(w: WorldData) {
  const W = w.width;
  const H = w.height;
  const cells = new Map<number, Set<number>>(); // a*4096+d -> d's cells touching a
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = ownerAt(w, i);
      if (d < 0) continue;
      for (const j of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0) continue;
        const a = ownerAt(w, j);
        if (a < 0 || a === d) continue;
        const k = a * 4096 + d;
        if (!cells.has(k)) cells.set(k, new Set());
        cells.get(k)!.add(i);
      }
    }
  let best = -1;
  for (const [k, s] of cells) if (best < 0 || s.size > cells.get(best)!.size) best = k;
  return { attacker: Math.floor(best / 4096), defender: best % 4096, cells: [...cells.get(best)!] };
}

// A smooth line along border cells: binned along their main axis (no wrap
// handling needed for the world below, checked by the caller)
function lineAlong(cells: number[], W: number): LinePoint[] {
  const pts = cells.map((i) => ({ x: (i % W) + 0.5, y: Math.floor(i / W) + 0.5 }));
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const t = pts.map((p) => (p.x - mx) * ux + (p.y - my) * uy);
  const t0 = Math.min(...t);
  const t1 = Math.max(...t);
  const bins = 12;
  const line: LinePoint[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = t0 + ((t1 - t0) * b) / bins;
    const hi = t0 + ((t1 - t0) * (b + 1)) / bins;
    const inBin = pts.filter((_p, k) => t[k] >= lo && (t[k] < hi || b === bins - 1));
    if (!inBin.length) continue;
    line.push({ x: inBin.reduce((s, p) => s + p.x, 0) / inBin.length, y: inBin.reduce((s, p) => s + p.y, 0) / inBin.length });
  }
  return simplifyLine(line, 0.5);
}

async function setup() {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin("0.1");
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 6; i++) sim.step();
  return { world, sim };
}

test("frontLine: samples are spread evenly and capped", () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const s = sampleLine(line, 10, 8);
  expect(s.length).toBe(8);
  expect(s[0].x).toBeCloseTo(100 / 16);
  expect(s[7].x).toBeCloseTo(100 - 100 / 16);
  expect(s.every((p) => Math.abs(p.nx) < 1e-12)).toBe(true);
  expect(s.every((p) => p.ny === 1)).toBe(true);
  expect(sampleLine(line, 40, 8).length).toBe(3);
  expect(sampleLine([{ x: 3, y: 4 }], 10, 8)).toEqual([{ x: 3, y: 4, nx: 0, ny: 0 }]);
  // Collinear points go, corners stay
  expect(simplifyLine([{ x: 0, y: 0 }, { x: 5, y: 0.1 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.5)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
});

test("an attack line takes the defender's land all along the line, as one battle", async () => {
  const { world, sim } = await setup();
  const W = world.width;
  const { attacker, defender, cells } = longestBorder(world);
  const line = lineAlong(cells, W);
  expect(Math.max(...line.map((p) => p.x)) - Math.min(...line.map((p) => p.x))).toBeLessThan(W / 2); // not across the wrap
  expect(line.length).toBeGreaterThanOrEqual(2);
  expect(lineTarget(world, attacker, line)).toBeGreaterThanOrEqual(0);

  const A = world.nations[attacker];
  const D = world.nations[defender];
  const before = Array.from({ length: W * world.height }, (_v, i) => ownerAt(world, i));
  const battles = sim.battles.length;
  const battleEvents = sim.events.filter((e) => e.kind === "battle").length;
  const frames = sim.history.total;

  const res = sim.commandFront(attacker, defender, 3, line);
  expect(res).not.toBeNull();
  expect(res!.taken).toBeGreaterThan(0);

  // Only the defender lost land, and only to the attacker
  const taken: number[] = [];
  for (let i = 0; i < before.length; i++) {
    const now = ownerAt(world, i);
    if (now === before[i]) continue;
    expect(world.nations[before[i]] ?? D).toBe(D);
    expect(world.nations[now]).toBe(A);
    taken.push(i);
  }
  expect(taken.length).toBe(res!.taken);

  // Spread along the line: several sample points have taken land near them
  const pts = sampleLine(line, Math.max(4, 12 * (W / 800)), 8);
  const reach = 10;
  const near = pts.filter((p) =>
    taken.some((i) => {
      let dx = Math.abs((i % W) + 0.5 - p.x);
      if (dx > W / 2) dx = W - dx;
      return Math.hypot(dx, Math.floor(i / W) + 0.5 - p.y) <= reach;
    }),
  );
  expect(pts.length).toBeGreaterThanOrEqual(4);
  expect(near.length).toBeGreaterThanOrEqual(Math.ceil(pts.length * 0.75));
  expect(res!.prongs).toBeGreaterThanOrEqual(4);
  // Broad and shallow: the budget is shared out, no prong takes the bulk of it
  expect(sim.offensives.length).toBe(res!.prongs);
  expect(Math.max(...sim.offensives.map((o) => o.size))).toBeLessThan(res!.taken / 2);

  // One battle, one chronicle entry, one new frame on the timeline
  expect(sim.battles.length).toBe(battles + 1);
  expect(sim.battles.at(-1)!.size).toBe(res!.taken);
  expect(sim.events.filter((e) => e.kind === "battle").length).toBe(battleEvents + 1);
  expect(sim.events.find((e) => e.kind === "battle")!.text).toContain("Offensive along"); // newest first
  expect(sim.history.total).toBe(frames + 1);
});

test("a line over the sea or the attacker's own land attacks nothing", async () => {
  const { world, sim } = await setup();
  const W = world.width;
  // Open sea: a run of water cells far from land
  let sea: LinePoint[] | null = null;
  for (let y = 10; y < world.height - 10 && !sea; y += 5)
    for (let x = 10; x < W - 40 && !sea; x += 5) {
      let ok = true;
      for (let dy = -6; dy <= 6 && ok; dy++) for (let dx = -6; dx <= 36 && ok; dx++) if (!world.grid[x + dx][y + dy].isWater) ok = false;
      if (ok) sea = [{ x, y }, { x: x + 30, y }];
    }
  expect(sea).not.toBeNull();
  const { attacker, defender } = longestBorder(world);
  const frames = sim.history.total;
  const events = sim.events.length;
  expect(lineTarget(world, attacker, sea!)).toBe(-1);
  expect(sim.commandFront(attacker, defender, 2, sea!)).toBeNull();
  // Deep inside some realm's own land
  let home: { line: LinePoint[]; owner: number } | null = null;
  for (let y = 10; y < world.height - 10 && !home; y++)
    for (let x = 10; x < W - 10 && !home; x++) {
      const o = ownerAt(world, y * W + x);
      let ok = o >= 0;
      for (let dy = -6; dy <= 6 && ok; dy++) for (let dx = -8; dx <= 8 && ok; dx++) if (ownerAt(world, (y + dy) * W + x + dx) !== o) ok = false;
      if (ok) home = { line: [{ x: x - 1.5, y: y + 0.5 }, { x: x + 2.5, y: y + 0.5 }], owner: o };
    }
  expect(home).not.toBeNull();
  expect(lineTarget(world, home!.owner, home!.line)).toBe(-1);
  expect(sim.commandFront(home!.owner, home!.owner === 0 ? 1 : 0, 2, home!.line)).toBeNull();
  // Nothing happened: no war declared, no frame, no chronicle entry
  expect(sim.history.total).toBe(frames);
  expect(sim.events.length).toBe(events);
});

test("a line attack survives branching back to it", async () => {
  const { world, sim } = await setup();
  const { attacker, defender, cells } = longestBorder(world);
  const res = sim.commandFront(attacker, defender, 3, lineAlong(cells, world.width));
  expect(res).not.toBeNull();
  const owners = () => Array.from({ length: world.width * world.height }, (_v, i) => ownerAt(world, i));
  const at = sim.lastFrame;
  const seen = new Map<number, number[]>([[at, owners()]]);
  const battles = sim.battles.length;
  for (let i = 0; i < 4; i++) {
    sim.step();
    seen.set(sim.lastFrame, owners());
  }
  // Two years later, replayed from the attack's checkpoint
  expect(sim.canBranchAt(at + 2)).toBe(true);
  expect(sim.branchAt(at + 2, false)).toBe(true);
  expect(sim.lastFrame).toBe(at + 2);
  expect(owners()).toEqual(seen.get(at + 2));
  // The attack itself
  sim.step();
  expect(sim.branchAt(at, false)).toBe(true);
  expect(sim.lastFrame).toBe(at);
  expect(owners()).toEqual(seen.get(at));
  expect(sim.battles.length).toBe(battles);
}, 300_000);
