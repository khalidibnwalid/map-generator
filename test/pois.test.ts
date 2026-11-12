import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";

async function generate(version: string) {
  const g = new MapGenerator(400, 225, 982332);
  g.currentPreset = "Earthlike";
  g.pin(version, 11);
  return g.generate();
}

// The domed landmark: zawiyas in 0.1 worlds (pinned by the golden
// fingerprints in determinism.test.ts), mosques from 0.2
test("0.2 worlds have mosques where 0.1 worlds had zawiyas", async () => {
  const old = await generate("0.1");
  const now = await generate("0.2");
  const domes = (w: typeof old) => w.pois.filter((p) => p.kind === "monastery");
  expect(domes(old).length).toBeGreaterThan(0);
  expect(domes(old).every((p) => p.name.startsWith("Zawiya of "))).toBe(true);
  expect(domes(now).length).toBeGreaterThan(0);
  expect(domes(now).every((p) => p.name.startsWith("Mosque of "))).toBe(true);
  expect(now.pois.some((p) => p.name.includes("Zawiya"))).toBe(false);
});
