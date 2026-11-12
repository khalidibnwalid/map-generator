import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { mergeNation, provinceIndependence } from "../src/game/politics";
import { EditHistory } from "../src/game/EditHistory";
import { loadWorld, saveWorld } from "../src/game/WorldFile";
import type { WorldData } from "../src/game/WorldData";
import { fingerprint } from "./fingerprint";

async function world(seed = 4242) {
  const g = new MapGenerator(400, 225, seed);
  g.pin("0.1");
  const w = await g.generate();
  return { g, w };
}

// Every nation reference points at a real nation and matches its province
function expectConsistent(w: WorldData) {
  const N = w.nations.length;
  const P = w.provinces.length;
  w.nations.forEach((n, i) => {
    expect(n.id).toBe(i);
    if (n.overlord !== undefined) {
      expect(n.overlord).toBeLessThan(N);
      expect(n.overlord).not.toBe(i);
      expect(w.nations[n.overlord].overlord).toBeUndefined();
      expect(w.relations[i][n.overlord]).toBe("Vassal");
      expect(w.relations[n.overlord][i]).toBe("Overlord");
    }
  });
  expect(w.relations.length).toBe(N);
  for (const row of w.relations) expect(row.length).toBe(N);
  w.provinces.forEach((p, i) => {
    expect(p.id).toBe(i);
    expect(p.nationIndex).toBeGreaterThanOrEqual(0);
    expect(p.nationIndex).toBeLessThan(N);
  });
  for (let x = 0; x < w.width; x++)
    for (let y = 0; y < w.height; y++) {
      const c = w.grid[x][y];
      const n = c.nationIndex ?? -1;
      expect(n).toBeLessThan(N);
      const p = c.provinceIndex ?? -1;
      if (p >= 0) {
        expect(p).toBeLessThan(P);
        if (!c.isWater && n >= 0) expect(w.provinces[p].nationIndex).toBe(n);
      }
    }
  for (const c of w.cities) {
    expect(c.nationIndex).toBeLessThan(N);
    if (c.provinceIndex !== undefined && c.provinceIndex >= 0) expect(w.provinces[c.provinceIndex].nationIndex).toBe(c.nationIndex);
  }
  // At most one capital per nation
  const caps = new Array(N).fill(0);
  for (const c of w.cities) if (c.isCapital && c.nationIndex >= 0) caps[c.nationIndex]++;
  for (const k of caps) expect(k).toBeLessThanOrEqual(1);
}

// A pair of nations sharing a land border
function neighbors(w: WorldData): [number, number] {
  for (let x = 0; x < w.width; x++)
    for (let y = 0; y < w.height; y++) {
      const a = w.grid[x][y];
      const b = w.grid[(x + 1) % w.width][y];
      if (a.isWater || b.isWater) continue;
      const i = a.nationIndex ?? -1;
      const j = b.nationIndex ?? -1;
      if (i >= 0 && j >= 0 && i !== j) return [i, j];
    }
  throw new Error("no neighbors");
}

const landOf = (w: WorldData, n: number) => {
  let k = 0;
  for (const col of w.grid) for (const c of col) if (!c.isWater && c.nationIndex === n) k++;
  return k;
};

test("merging a nation hands everything to the other and removes it", async () => {
  const { w } = await world();
  const [from, into] = neighbors(w);
  const X = w.nations[from];
  const Y = w.nations[into];
  const nationsBefore = w.nations.length;
  const land = landOf(w, from) + landOf(w, into);
  const provs = w.provinces.filter((p) => p.nationIndex === from || p.nationIndex === into);
  const cities = w.cities.filter((c) => c.nationIndex === from || c.nationIndex === into);
  // Give the merged realm a vassal to pass on
  const third = w.nations.findIndex((n, i) => i !== from && i !== into && n.overlord === undefined && !w.nations.some((m) => m.overlord === i));
  const thirdNation = w.nations[third];
  w.relations[into][from] = w.relations[from][into] = "War";
  thirdNation.overlord = from;
  w.relations[third][from] = "Vassal";
  w.relations[from][third] = "Overlord";

  const h = new EditHistory(w);
  h.ensureBaseline();
  const before = fingerprint(w);

  const yIdx = mergeNation(w, from, into);
  expect(w.nations.length).toBe(nationsBefore - 1);
  expect(w.nations).not.toContain(X);
  expect(w.nations[yIdx]).toBe(Y);
  expect(landOf(w, yIdx)).toBe(land);
  for (const p of provs) expect(p.nationIndex).toBe(yIdx);
  for (const c of cities) expect(c.nationIndex).toBe(yIdx);
  expect(cities.filter((c) => c.isCapital).length).toBe(1);
  // The vassal now serves the merged realm's bloc
  const head = Y.overlord ?? yIdx;
  expect(thirdNation.overlord).toBe(head);
  expectConsistent(w);

  // No border flags left on the old X/Y line
  for (let x = 0; x < w.width; x++)
    for (let y = 1; y < w.height - 1; y++) {
      const c = w.grid[x][y];
      if (c.isWater || c.nationIndex !== yIdx || !c.isNationBorder) continue;
      let edge = false;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const nb = w.grid[(x + dx + w.width) % w.width][y + dy];
          if (nb.isWater || nb.nationIndex !== yIdx) edge = true;
        }
      expect(edge).toBe(true);
    }

  // Undo puts it all back
  h.commit();
  h.undo();
  expect(fingerprint(w)).toEqual(before);
  expect(w.nations[from]).toBe(X);
});

test("a province breaks away as a new nation", async () => {
  const { w } = await world();
  // A nation with several provinces; take one that is not its capital's
  const owner = w.nations.findIndex((_, i) => w.provinces.filter((p) => p.nationIndex === i).length >= 3);
  const capital = w.cities.find((c) => c.nationIndex === owner && c.isCapital);
  const prov = w.provinces.find((p) => p.nationIndex === owner && p.id !== capital?.provinceIndex && p.capitalCityId >= 0)!;
  const seat = w.cities.find((c) => c.id === prov.capitalCityId)!;
  const ownerLand = landOf(w, owner);
  let provLand = 0;
  for (const col of w.grid) for (const c of col) if (!c.isWater && c.provinceIndex === prov.id) provLand++;
  const provCities = w.cities.filter((c) => c.provinceIndex === prov.id);
  const count = w.nations.length;
  w.nations[owner].coalitions = [99];
  const h = new EditHistory(w);
  h.ensureBaseline();
  const before = fingerprint(w);

  const idx = provinceIndependence(w, prov.id);
  expect(idx).toBe(count);
  const NT = w.nations[idx];
  expect(NT.name).toBe(seat.name);
  expect(NT.coalitions).toBeUndefined();
  expect(NT.overlord).toBeUndefined();
  expect(NT.flag).toBeDefined();
  expect(NT.capitalX).toBe(seat.x);
  expect(seat.isCapital).toBe(true);
  expect(prov.nationIndex).toBe(idx);
  expect(landOf(w, idx)).toBe(provLand);
  expect(landOf(w, owner)).toBe(ownerLand - provLand);
  for (const c of provCities) expect(c.nationIndex).toBe(idx);
  expect(capital?.isCapital).toBe(true);
  expect(w.relations[idx][owner]).toBe("Rival");
  expect(w.relations[owner][idx]).toBe("Rival");
  expectConsistent(w);

  // Not for a nation's last province
  const lone = w.provinces.find((p) => w.provinces.filter((q) => q.nationIndex === p.nationIndex).length === 1)!;
  expect(provinceIndependence(w, lone.id)).toBe(-1);

  // One undo step takes it back
  h.commit();
  h.undo();
  expect(fingerprint(w)).toEqual(before);
  expect(w.nations.length).toBe(count);
});

test("the capital province can leave; the old realm moves its seat", async () => {
  const { w } = await world();
  const owner = w.nations.findIndex(
    (_, i) => w.provinces.filter((p) => p.nationIndex === i).length >= 2 && w.cities.filter((c) => c.nationIndex === i).length >= 3,
  );
  const capital = w.cities.find((c) => c.nationIndex === owner && c.isCapital)!;
  const idx = provinceIndependence(w, capital.provinceIndex!);
  expect(idx).toBeGreaterThan(0);
  expect(capital.nationIndex).toBe(idx);
  const newSeat = w.cities.find((c) => c.nationIndex === owner && c.isCapital)!;
  expect(newSeat).toBeDefined();
  expect(w.nations[owner].capitalX).toBe(newSeat.x);
  expectConsistent(w);
});

test("merged and independent nations survive a save and reload", async () => {
  const { g, w } = await world();
  const [from, into] = neighbors(w);
  mergeNation(w, from, into);
  const owner = w.nations.findIndex((_, i) => w.provinces.filter((p) => p.nationIndex === i).length >= 2);
  const prov = w.provinces.find((p) => p.nationIndex === owner)!;
  provinceIndependence(w, prov.id);
  // Saving trims coordinates to 3 decimals; compare like with like
  const trim = <T>(v: T): T =>
    JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isInteger(x) ? Math.round(x * 1000) / 1000 : x)));
  w.nations = trim(w.nations);
  w.provinces = trim(w.provinces);
  w.cities = trim(w.cities);
  const before = fingerprint(w);

  const reopened = await loadWorld(await saveWorld(g), new MapGenerator(10, 10, 1));
  const after = fingerprint(reopened);
  expect(after.nations).toBe(before.nations);
  expect(after.provinces).toBe(before.provinces);
  expect(after.relations).toBe(before.relations);
  expect(reopened.nations.length).toBe(w.nations.length);
  expectConsistent(reopened);
});
