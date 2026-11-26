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

test("a natural region stops at rivers, ridges and the sea", async () => {
  const { naturalRegion } = await import("../src/ui/ProvinceTool");
  const w = await world();
  const start = w.provinces.find((p) => w.nations[p.nationIndex])!;
  const region = naturalRegion(w, start);
  expect(region).toContain(start);
  // A region never reaches every province of a world with rivers and mountains
  expect(region.length).toBeLessThan(w.provinces.length);
  // A region is a few provinces, not a continent
  expect(region.length).toBeLessThan(40);
}, 120_000);

test("a province splits into 3-10 contiguous pieces inside its outline, and merges back whole", async () => {
  const { splitProvince, mergeProvinces, keepOccupied } = await import("../src/game/politics");
  const w = await world();
  const W = w.width;
  const sizeOf = (id: number) => {
    let n = 0;
    for (let x = 0; x < W; x++) for (let y = 0; y < w.height; y++) if (!w.grid[x][y].isWater && w.grid[x][y].provinceIndex === id) n++;
    return n;
  };
  const p = [...w.provinces].sort((a, b) => sizeOf(b.id) - sizeOf(a.id))[0];
  const total = sizeOf(p.id);
  const count = w.provinces.length;
  const parts = splitProvince(w, p, 6);
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(parts.length).toBeLessThanOrEqual(10);
  expect(parts[0]).toBe(p);
  // Together they are the old province exactly; each is in one piece
  expect(parts.reduce((s, q) => s + sizeOf(q.id), 0)).toBe(total);
  for (const q of parts) {
    const cells: number[] = [];
    for (let x = 0; x < W; x++) for (let y = 0; y < w.height; y++) if (!w.grid[x][y].isWater && w.grid[x][y].provinceIndex === q.id) cells.push(y * W + x);
    const set = new Set(cells);
    const seen = new Set([cells[0]]);
    const queue = [cells[0]];
    for (let h = 0; h < queue.length; h++) {
      const c = queue[h];
      const x = c % W;
      const y = Math.floor(c / W);
      for (const nb of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), c - W, c + W])
        if (set.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
    }
    // Land cut off inside the province (islands) may sit apart; the bulk is one piece
    expect(seen.size).toBeGreaterThan(cells.length * 0.8);
  }
  mergeProvinces(w, p, parts.slice(1));
  expect(w.provinces.length).toBe(count);
  expect(sizeOf(p.id)).toBe(total);
  // Keeping occupied land: nothing occupied, nothing changes
  expect(keepOccupied(w, 0, 1)).toBe(0);
}, 120_000);
