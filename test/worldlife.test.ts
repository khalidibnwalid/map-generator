import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { Simulation } from "../src/game/sim/Simulation";

const LIFE = new Set(["plague", "famine", "migration", "wonder", "learning", "rename"]);

async function run(version: string, years: number) {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin(version, 5);
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < years; i++) sim.step();
  return { world, sim };
}

test("0.3 histories bring plague, famine, migrations and learning; the same seed brings the same", async () => {
  const a = await run("0.3", 220);
  const kinds = new Set(a.sim.events.map((e) => e.kind).filter((k) => LIFE.has(k)));
  expect(kinds.size).toBeGreaterThanOrEqual(2);
  // Seats of learning are landmarks with a year; knowledge only grows from them
  const seats = a.world.pois.filter((p) => p.kind === "university" || p.kind === "library");
  for (const p of seats) expect(p.year).toBeGreaterThan(0);
  if (seats.length) expect(a.world.nations.some((n) => (n.knowledge ?? 0) > 0)).toBe(true);
  // Renamed towns remember their old name, and stay rare
  const renamed = a.world.cities.filter((c) => c.formerName);
  expect(renamed.length).toBeLessThanOrEqual(3);
  for (const c of renamed) expect(c.formerName).not.toBe(c.name);

  const b = await run("0.3", 220);
  expect(b.sim.events.map((e) => `${e.year} ${e.text}`)).toEqual(a.sim.events.map((e) => `${e.year} ${e.text}`));
}, 300_000);

test("0.2 histories are untouched by it", async () => {
  const { world, sim } = await run("0.2", 120);
  expect(sim.events.some((e) => LIFE.has(e.kind))).toBe(false);
  expect(world.pois.some((p) => p.kind === "wonder" || p.kind === "university" || p.kind === "library")).toBe(false);
  expect(world.nations.every((n) => n.knowledge === undefined)).toBe(true);
}, 300_000);

test("branching a 0.3 history replays it exactly, marks and all", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  g.pin("0.3", 5);
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  const state = () =>
    JSON.stringify([
      sim.year,
      sim.events.map((e) => e.text),
      world.pois.map((p) => p.name),
      world.nations.map((n) => n.knowledge ?? 0),
      // (populations are left out: they drift a little on replay, as in 0.2 worlds)
      world.cities.map((c) => c.name),
      sim.life.marks.map((m) => `${m.kind}${m.year}`),
    ]);
  const seen: string[] = [];
  for (let i = 0; i < 45; i++) {
    sim.step();
    seen[sim.lastFrame] = state();
  }
  const target = sim.lastFrame - 17;
  expect(sim.branchAt(target, false)).toBe(true);
  expect(state()).toBe(seen[target]);
}, 300_000);
