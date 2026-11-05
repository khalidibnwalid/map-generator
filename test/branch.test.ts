import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { Simulation } from "../src/game/sim/Simulation";
import type { WorldData } from "../src/game/WorldData";
import { fingerprint } from "./fingerprint";

// Political state worth comparing between timelines
const state = (w: WorldData, sim: Simulation) => {
  const f = fingerprint(w);
  return { year: sim.year, nations: f.nations, provinces: f.provinces, cities: f.cities, roads: f.roads, relations: f.relations, events: sim.events.length, battles: sim.battles.length };
};

test("branching replays history exactly up to the chosen year, then takes another course", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());

  const seen: ReturnType<typeof state>[] = [];
  for (let i = 0; i < 26; i++) {
    sim.step();
    seen[sim.lastFrame] = state(world, sim);
  }
  // A skipped year too: replays must repeat the same kind of step
  sim.skipYear();
  seen[sim.lastFrame] = state(world, sim);
  for (let i = 0; i < 3; i++) {
    sim.step();
    seen[sim.lastFrame] = state(world, sim);
  }
  const presentFrame = sim.lastFrame;
  const present = state(world, sim);

  // Mid-way between checkpoints: needs a replay
  const target = 17;
  expect(sim.canBranchAt(target)).toBe(true);
  expect(sim.branchAt(target)).toBe(true);
  expect(sim.lastFrame).toBe(target);
  expect(state(world, sim)).toEqual(seen[target]);
  expect(sim.other?.year).toBe(present.year);

  // The new course diverges from the old one
  for (let i = 0; i < 12; i++) sim.step();
  const branched = state(world, sim);
  expect(branched).not.toEqual(seen[sim.lastFrame]);

  // Back and forth between the two timelines
  expect(sim.switchTimeline()).toBe(true);
  expect(sim.lastFrame).toBe(presentFrame);
  expect(state(world, sim)).toEqual(present);
  expect(sim.switchTimeline()).toBe(true);
  expect(state(world, sim)).toEqual(branched);
}, 300_000);

test("a replay restores the whole simulation, not just the map", async () => {
  const g = new MapGenerator(400, 225, 8080);
  g.currentPreset = "Earthlike";
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 34; i++) sim.step();
  const end = sim.lastFrame;
  const present = state(world, sim);
  // Rewind without changing the random stream: the same future must follow
  expect(sim.branchAt(13, false)).toBe(true);
  while (sim.lastFrame < end) sim.step();
  expect(state(world, sim)).toEqual(present);
}, 300_000);

test("an edit between years is kept when branching after it", async () => {
  const g = new MapGenerator(400, 225, 9090);
  g.currentPreset = "Pangea";
  const world = await g.generate();
  const sim = new Simulation(world, g.getNoise());
  for (let i = 0; i < 4; i++) sim.step();
  world.nations[0].name = "Edited Realm";
  sim.markEdited();
  for (let i = 0; i < 6; i++) sim.step();
  const atEight = (() => {
    // frame 8 is after the edit
    return sim.lastFrame;
  })();
  expect(atEight).toBeGreaterThan(5);
  expect(sim.branchAt(7)).toBe(true);
  expect(world.nations.some((n) => n.name === "Edited Realm") || world.nations.length > 0).toBe(true);
  // The edit happened before frame 7, so the rewound world still has it
  const edited = world.nations.find((n) => n.name === "Edited Realm");
  expect(edited).toBeDefined();
}, 300_000);
