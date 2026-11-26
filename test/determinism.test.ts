import { describe, expect, test } from "vitest";
import { MapGenerator, type Preset } from "../src/game/MapGenerator";
import { fingerprint } from "./fingerprint";
import { APP_VERSION } from "../src/game/version";

// The app's core promise: the same seed always gives the same world, and a
// .world file (seed + edits) reopens to exactly what was saved. These golden
// fingerprints fail whenever a change alters existing seeds. If that change is
// intended, bump the world file VERSION and update with `pnpm test -u`.
// Golden worlds are 0.1 worlds (links and files from before versions), which
// must keep regenerating exactly; 0.2+ worlds also need their politics seed.

const W = 400;
const H = 225;
const PRESETS: Preset[] = ["Heavy Landmass", "Realistic Continents", "Earthlike", "Pangea", "Landworld"];

async function generate(seed: number, preset: Preset, version = "0.1", politicsSeed?: number) {
  const g = new MapGenerator(W, H, seed);
  g.currentPreset = preset;
  g.pin(version, politicsSeed);
  return { g, world: await g.generate() };
}

describe("seeded generation", () => {
  test.each(PRESETS.map((p, i) => [p, 982332 + i * 1013] as const))("%s, seed %i matches its golden fingerprint", async (preset, seed) => {
    const { world } = await generate(seed, preset);
    expect(fingerprint(world)).toMatchSnapshot();
  });

  test("generating the same seed twice in one session gives the same world", async () => {
    // Catches module-level caches or Math.random leaking into generation
    const a = fingerprint((await generate(4242, "Earthlike")).world);
    await generate(777, "Pangea");
    const b = fingerprint((await generate(4242, "Earthlike")).world);
    expect(b).toEqual(a);
  });

  test("0.2 worlds share their land but not their realms, unless the politics seed is pinned", async () => {
    const a = await generate(4242, "Earthlike", "0.2", 11);
    const b = await generate(4242, "Earthlike", "0.2", 12);
    const a2 = await generate(4242, "Earthlike", "0.2", 11);
    expect(a.world.version).toBe("0.2");
    expect(a.world.politicsSeed).toBe(11);
    expect(Array.from(b.world.landmass)).toEqual(Array.from(a.world.landmass));
    expect(b.world.nations.map((n) => n.name)).not.toEqual(a.world.nations.map((n) => n.name));
    expect(fingerprint(a2.world)).toEqual(fingerprint(a.world));
  });

  test("an unpinned generation makes a current-version world with a fresh politics seed", async () => {
    const g = new MapGenerator(W, H, 4242);
    await g.generate();
    const first = g.politicsSeed;
    await g.generate();
    expect(g.version).toBe(APP_VERSION);
    expect(g.politicsSeed).not.toBe(first);
  });
});
