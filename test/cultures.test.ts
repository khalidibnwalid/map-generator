import { beforeAll, describe, expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import type { WorldData } from "../src/game/WorldData";
import { loadWorld, saveWorld } from "../src/game/WorldFile";
import { patchStats } from "./enclaves";

// 0.2 worlds place peoples like an ethnographic map: empty deserts and peaks,
// minority pockets inside other peoples' land, and mixed cells with a second
// culture and race. 0.1 worlds keep one solid culture per land cell (their
// golden fingerprints are checked in determinism.test.ts).

const W = 400;
const H = 225;

async function generate(version: string, seed = 123) {
  const g = new MapGenerator(W, H, seed);
  g.currentPreset = "Earthlike";
  if (version === "0.2") g.pin("0.2", 123);
  else g.pin(version);
  return { g, world: await g.generate() };
}

function landCells(world: WorldData) {
  const out: { x: number; y: number; c: WorldData["grid"][number][number] }[] = [];
  for (let x = 0; x < world.width; x++)
    for (let y = 0; y < world.height; y++) if (!world.grid[x][y].isWater) out.push({ x, y, c: world.grid[x][y] });
  return out;
}

describe("0.2 peoples", () => {
  let g: MapGenerator;
  let world: WorldData;
  beforeAll(async () => {
    ({ g, world } = await generate("0.2"));
  });

  test("some land is uninhabited, most is not", () => {
    const land = landCells(world);
    const empty = land.filter(({ c }) => c.cultureIndex === undefined);
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.length / land.length).toBeLessThan(0.45);
    // Nobody at all lives there: no race, no second people
    for (const { c } of empty) {
      expect(c.raceIndex).toBeUndefined();
      expect(c.culture2Index).toBeUndefined();
      expect(c.race2Index).toBeUndefined();
    }
  });

  test("cultures and races both live in separate patches, some enclosed by other peoples", () => {
    for (const field of ["cultureIndex", "raceIndex"] as const) {
      // Patches of a few cells or more, not single-cell specks
      const { fragmented, enclaves, sizes } = patchStats(world, field, 4);
      expect(fragmented, field).toBeGreaterThan(0);
      expect(enclaves, field).toBeGreaterThan(2);
      // From small islands to small regions
      expect(sizes[0], field).toBeLessThan(20);
      expect(sizes[sizes.length - 1], field).toBeGreaterThan(30);
    }
  });

  test("some race islands differ from the race of the culture around them", () => {
    let foreign = 0;
    for (const { c } of landCells(world))
      if (c.cultureIndex !== undefined && c.culture2Index === undefined && c.race2Index === undefined && c.raceIndex !== world.cultures[c.cultureIndex].raceId) foreign++;
    expect(foreign).toBeGreaterThan(20);
  });

  test("mixed cells hold two different peoples", () => {
    const land = landCells(world);
    const mixed = land.filter(({ c }) => c.culture2Index !== undefined);
    const mixedRaces = land.filter(({ c }) => c.race2Index !== undefined);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixedRaces.length).toBeGreaterThan(0);
    for (const { c } of mixed) {
      expect(c.cultureIndex).toBeDefined();
      expect(c.culture2Index).not.toBe(c.cultureIndex);
      expect(world.cultures[c.culture2Index!]).toBeDefined();
    }
    for (const { c } of mixedRaces) {
      expect(c.raceIndex).toBeDefined();
      expect(c.race2Index).not.toBe(c.raceIndex);
      expect(world.races[c.race2Index!]).toBeDefined();
    }
  });

  test("races follow cultures, but not cell for cell", () => {
    let differ = 0;
    for (const { c } of landCells(world)) {
      if (c.cultureIndex === undefined) continue;
      expect(world.races[c.raceIndex!]).toBeDefined();
      if (world.cultures[c.cultureIndex].raceId !== c.raceIndex) differ++;
    }
    expect(differ).toBeGreaterThan(0);
  });

  test("culture names are unique", () => {
    const names = world.cultures.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("realms and settlements still work", () => {
    expect(world.nations.length).toBeGreaterThan(3);
    for (const n of world.nations) {
      expect(world.cultures[n.cultureId ?? -1]).toBeDefined();
      expect(n.name.length).toBeGreaterThan(0);
    }
    expect(world.cities.length).toBeGreaterThan(world.nations.length);
    for (const c of world.cities) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(world.nations[c.nationIndex]).toBeDefined();
      // Nobody settles uninhabited land
      const cell = world.getCell(c.x, c.y)!;
      if (!cell.isWater && !c.isCapital) expect(cell.cultureIndex).toBeDefined();
    }
    for (const p of world.provinces) expect(p.name.length).toBeGreaterThan(0);
  });

  test("edited peoples, mixed cells included, survive a save", async () => {
    // Paint a mixed patch and empty a few cells, as the editors would
    const land = landCells(world).filter(({ c }) => c.cultureIndex !== undefined);
    const a = land[Math.floor(land.length / 3)];
    const b = land[Math.floor((land.length * 2) / 3)];
    const other = (a.c.cultureIndex! + 1) % world.cultures.length;
    a.c.culture2Index = other;
    a.c.race2Index = world.cultures[other].raceId === a.c.raceIndex ? undefined : world.cultures[other].raceId;
    b.c.cultureIndex = b.c.raceIndex = b.c.culture2Index = b.c.race2Index = undefined;
    world.culturesEdited = true;
    const snapshot = (w: WorldData) => landCells(w).map(({ c }) => [c.cultureIndex, c.culture2Index, c.raceIndex, c.race2Index].join(","));
    const before = snapshot(world);

    const reopened = await loadWorld(await saveWorld(g), new MapGenerator(10, 10, 1));
    expect(reopened.version).toBe("0.2");
    expect(snapshot(reopened)).toEqual(before);
  });
});

test("0.1 worlds keep one solid culture on every land cell", async () => {
  const { world } = await generate("0.1");
  for (const { c } of landCells(world)) {
    expect(c.cultureIndex).toBeDefined();
    expect(c.culture2Index).toBeUndefined();
    expect(c.race2Index).toBeUndefined();
    expect(c.raceIndex).toBe(world.cultures[c.cultureIndex!].raceId);
  }
});
