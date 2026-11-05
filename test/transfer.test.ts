import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { packWorld, unpackWorld } from "../src/game/WorldTransfer";
import { cityTrade } from "../src/game/generators/generateTrade";
import { fingerprint } from "./fingerprint";

// The browser generates in a worker and ships the world back; that must be
// indistinguishable from generating in place, random streams included
// (the history simulation keeps drawing from them).
test("a world moved from the worker matches one generated in place", async () => {
  const seed = 31337;
  const a = new MapGenerator(400, 225, seed);
  a.currentPreset = "Realistic Continents";
  const local = await a.generate();

  const b = new MapGenerator(400, 225, seed);
  b.currentPreset = "Realistic Continents";
  const remote = await b.generate();
  const { packed, transfer } = packWorld(remote, b.getNoise(), seed);
  const { world, noise } = unpackWorld(structuredClone(packed, { transfer }));

  expect(fingerprint(world)).toEqual(fingerprint(local));
  expect(Object.keys(world).sort()).toEqual(Object.keys(local).sort());
  expect(world.grid[17][42]).toEqual(local.grid[17][42]);
  // Same random stream from here on
  const next = (r: () => number) => Array.from({ length: 5 }, r);
  expect(next(noise.random)).toEqual(next(a.getNoise().random));
  // Languages draw from that stream too, and keep their sound
  expect(world.languages.map((l) => l.townName())).toEqual(local.languages.map((l) => l.townName()));
  // Trade figures, cached per city object, are rebuilt
  expect(cityTrade(world.cities[0])).toEqual(cityTrade(local.cities[0]));
  expect(world.sampler.isWater(10.5, 10.5)).toBe(local.sampler.isWater(10.5, 10.5));
});
