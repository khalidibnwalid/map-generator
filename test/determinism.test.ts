import { describe, expect, test } from "vitest";
import { MapGenerator, type Preset } from "../src/game/MapGenerator";
import { fingerprint } from "./fingerprint";

// The app's core promise: the same seed always gives the same world, and a
// .world file (seed + edits) reopens to exactly what was saved. These golden
// fingerprints fail whenever a change alters existing seeds. If that change is
// intended, bump the world file VERSION and update with `pnpm test -u`.

const W = 400;
const H = 225;
const PRESETS: Preset[] = ["Heavy Landmass", "Realistic Continents", "Earthlike", "Pangea", "Landworld"];

async function generate(seed: number, preset: Preset) {
  const g = new MapGenerator(W, H, seed);
  g.currentPreset = preset;
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
});
