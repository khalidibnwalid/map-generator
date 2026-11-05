import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { loadWorld, saveWorld } from "../src/game/WorldFile";
import { fingerprint } from "./fingerprint";

test("a saved world reopens to the same world, edits included", async () => {
  const g = new MapGenerator(400, 225, 13579);
  g.currentPreset = "Earthlike";
  const world = await g.generate();

  // A few edits of the kinds a .world file has to carry
  world.nations[0].name = "Testland";
  world.cities[0].name = "Proofton";
  const victim = world.nations.length - 1;
  for (let x = 0; x < world.width; x++)
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      if (c.nationIndex === victim) c.nationIndex = 0;
    }
  world.relations[0][1] = world.relations[1][0] = "War";
  // Saving trims coordinates to 3 decimals on purpose; compare like with like
  const trim = <T>(v: T): T =>
    JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isInteger(x) ? Math.round(x * 1000) / 1000 : x)));
  world.nations = trim(world.nations);
  world.provinces = trim(world.provinces);
  world.cities = trim(world.cities);
  const before = fingerprint(world);

  const blob = await saveWorld(g);
  const g2 = new MapGenerator(10, 10, 1);
  const reopened = await loadWorld(blob, g2);
  const after = fingerprint(reopened);
  // Trade, and with it city wealth, is recomputed on load (the war above
  // closes routes), so compare the saved city data without those fields
  const saved = (cs: typeof world.cities) => cs.map(({ wealth: _w, wealthTier: _t, ...c }) => c);
  expect(saved(reopened.cities)).toEqual(saved(world.cities));

  expect(after.nations).toBe(before.nations);
  expect(after.provinces).toBe(before.provinces);
  expect(after.relations).toBe(before.relations);
  expect(after.elevation).toBe(before.elevation);
  expect(after.biomes).toBe(before.biomes);
});
