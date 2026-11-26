import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { transferProvinces } from "../src/game/politics";

async function world() {
  const g = new MapGenerator(300, 170, 2024);
  g.currentPreset = "Earthlike";
  g.pin("0.2");
  return g.generate();
}

const landOf = (w: Awaited<ReturnType<typeof world>>, n: number) => {
  let c = 0;
  for (let x = 0; x < w.width; x++) for (let y = 0; y < w.height; y++) if (!w.grid[x][y].isWater && w.grid[x][y].nationIndex === n) c++;
  return c;
};

test("provinces form a new realm, or pass to another, with their land and cities", async () => {
  const w = await world();
  // A realm with at least three provinces
  const owner = w.nations.findIndex((_, i) => w.provinces.filter((p) => p.nationIndex === i).length >= 3);
  expect(owner).toBeGreaterThanOrEqual(0);
  const mine = w.provinces.filter((p) => p.nationIndex === owner);
  const pick = mine.slice(0, 2);
  const before = w.nations.length;
  const ownerName = w.nations[owner].name;

  const res = transferProvinces(w, pick.map((p) => p.id), { name: "Testland", color: "#123456" });
  expect(res.nation).toBe(before);
  expect(res.moved).toBe(2);
  const T = w.nations[res.nation];
  expect(T.name).toBe("Testland");
  expect(T.color).toBe("#123456");
  for (const p of pick) expect(p.nationIndex).toBe(res.nation);
  // Every cell of those provinces is the new realm's; their cities too
  for (let x = 0; x < w.width; x++)
    for (let y = 0; y < w.height; y++) {
      const c = w.grid[x][y];
      if (!c.isWater && pick.some((p) => p.id === c.provinceIndex)) expect(c.nationIndex).toBe(res.nation);
    }
  for (const c of w.cities) if (pick.some((p) => p.id === c.provinceIndex)) expect(c.nationIndex).toBe(res.nation);
  // One capital each
  expect(w.cities.filter((c) => c.nationIndex === res.nation && c.isCapital).length).toBeLessThanOrEqual(1);
  const old = w.nations.findIndex((n) => n.name === ownerName);
  expect(w.cities.filter((c) => c.nationIndex === old && c.isCapital).length).toBeLessThanOrEqual(1);
  expect(landOf(w, res.nation)).toBeGreaterThan(0);

  // Handing all its provinces back removes the new realm
  const back = transferProvinces(w, pick.map((p) => p.id), old);
  expect(back.removed).toEqual(["Testland"]);
  expect(w.nations.length).toBe(before);
  expect(w.nations[back.nation].name).toBe(ownerName);
}, 120_000);
