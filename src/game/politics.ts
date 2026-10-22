import type { Nation, RelationType, WorldData } from "./WorldData";
import { NATION_PALETTE } from "./generators/generateNations";

// Political bookkeeping shared by the editor and the history simulation.
// Keeps nation indices, relations, provinces and vassal links consistent.

const MIRROR: Partial<Record<RelationType, RelationType>> = { Vassal: "Overlord", Overlord: "Vassal" };

export function relation(world: WorldData, a: number, b: number): RelationType {
  return world.relations[a]?.[b] ?? "Neutral";
}

function ensureMatrix(world: WorldData) {
  const n = world.nations.length;
  while (world.relations.length < n) world.relations.push([]);
  world.relations.length = n;
  for (const row of world.relations) {
    while (row.length < n) row.push("Neutral");
    row.length = n;
  }
}

// Sets a's relation toward b (b gets the mirrored one). "Vassal" means a
// becomes b's vassal.
export function setRelation(world: WorldData, a: number, b: number, rel: RelationType) {
  if (a === b) return;
  ensureMatrix(world);
  const A = world.nations[a];
  const B = world.nations[b];
  // Leaving a vassal bond clears the overlord link on whichever side had it
  const prev = world.relations[a][b];
  if (prev === "Vassal" && rel !== "Vassal" && A.overlord === b) A.overlord = undefined;
  if (prev === "Overlord" && rel !== "Overlord" && B.overlord === a) B.overlord = undefined;
  world.relations[a][b] = rel;
  world.relations[b][a] = MIRROR[rel] ?? rel;
  if (rel === "Vassal") makeVassal(world, a, b);
  else if (rel === "Overlord") makeVassal(world, b, a);
}

export function paler(hex: string, amt = 0.42): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number) => {
    const c = (v >> s) & 255;
    return Math.round(c + (255 - c) * amt)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

export function makeVassal(world: WorldData, vassal: number, overlord: number) {
  if (vassal === overlord) return;
  ensureMatrix(world);
  const V = world.nations[vassal];
  const O = world.nations[overlord];
  if (!V || !O) return;
  // A vassal's own vassals pass to the new overlord
  world.nations.forEach((n, i) => {
    if (n.overlord === vassal) {
      n.overlord = overlord;
      world.relations[i][overlord] = "Vassal";
      world.relations[overlord][i] = "Overlord";
      n.color = paler(O.color);
    }
  });
  if (V.overlord !== undefined && V.overlord !== overlord) {
    world.relations[vassal][V.overlord] = "Neutral";
    world.relations[V.overlord][vassal] = "Neutral";
  }
  V.overlord = overlord;
  world.relations[vassal][overlord] = "Vassal";
  world.relations[overlord][vassal] = "Overlord";
  V.color = paler(O.color);
}

export function releaseVassal(world: WorldData, vassal: number) {
  const V = world.nations[vassal];
  if (!V || V.overlord === undefined) return;
  const o = V.overlord;
  V.overlord = undefined;
  world.relations[vassal][o] = "Friendly";
  world.relations[o][vassal] = "Friendly";
  V.color = NATION_PALETTE[(vassal * 7 + 3) % NATION_PALETTE.length];
}

// Nations that should highlight together: an overlord and all its vassals
export function blocOf(world: WorldData, idx: number): number[] {
  const n = world.nations[idx];
  if (!n) return [];
  const head = n.overlord ?? idx;
  const out = [head];
  world.nations.forEach((m, i) => {
    if (m.overlord === head) out.push(i);
  });
  return out;
}

export function appendNation(world: WorldData, nation: Nation): number {
  nation.id = world.nations.length;
  world.nations.push(nation);
  ensureMatrix(world);
  return nation.id;
}

// Removes a nation and re-indexes everything that refers to nations
export function removeNation(world: WorldData, idx: number) {
  if (idx < 0 || idx >= world.nations.length) return;
  const shift = (v: number | undefined) => (v === undefined || v < 0 ? v : v === idx ? -1 : v > idx ? v - 1 : v);

  for (const c of world.cities) {
    if (c.nationIndex === idx) {
      c.nationIndex = -1;
      c.isCapital = false;
      c.provinceIndex = -1;
    } else c.nationIndex = shift(c.nationIndex)!;
  }

  // Provinces of the removed nation go; others are re-indexed
  const removedProv = new Set(world.provinces.filter((p) => p.nationIndex === idx).map((p) => p.id));
  const kept = world.provinces.filter((p) => p.nationIndex !== idx);
  const provRemap = new Map<number, number>();
  kept.forEach((p, i) => {
    provRemap.set(p.id, i);
    p.id = i;
    p.nationIndex = shift(p.nationIndex)!;
  });
  world.provinces = kept;
  const fixProv = (v: number | undefined) =>
    v === undefined || v < 0 ? v : removedProv.has(v) ? -1 : (provRemap.get(v) ?? -1);

  for (let x = 0; x < world.width; x++) {
    const col = world.grid[x];
    for (let y = 0; y < world.height; y++) {
      const cell = col[y];
      cell.nationIndex = shift(cell.nationIndex);
      cell.provinceIndex = fixProv(cell.provinceIndex);
      if (cell.nationIndex === -1) cell.isNationBorder = false;
    }
  }
  for (const c of world.cities) c.provinceIndex = fixProv(c.provinceIndex);

  world.relations.splice(idx, 1);
  for (const row of world.relations) row.splice(idx, 1);
  world.nations.splice(idx, 1);
  world.nations.forEach((n, i) => {
    n.id = i;
    if (n.overlord !== undefined) n.overlord = n.overlord === idx ? undefined : n.overlord > idx ? n.overlord - 1 : n.overlord;
  });
}

// Moves a nation's seat to its most populous city (after its capital fell)
export function relocateCapital(world: WorldData, idx: number) {
  const nation = world.nations[idx];
  if (!nation) return;
  for (const c of world.cities) if (c.nationIndex === idx && c.isCapital) return;
  const successor = world.cities
    .filter((c) => c.nationIndex === idx)
    .sort((a, b) => b.population - a.population)[0];
  if (!successor) return;
  successor.isCapital = true;
  nation.capitalX = successor.x;
  nation.capitalY = successor.y;
}
