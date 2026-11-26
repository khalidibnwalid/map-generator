import { CELL_KM2, type Nation, type Province, type RelationType, type WorldData } from "./WorldData";
import { NATION_PALETTE, colorForNewNation, refreshTerritorialWaters } from "./generators/generateNations";
import { defaultFlagFor } from "./flags";
import { foundHouse } from "./sim/Rulers";
import { pruneCoalitions } from "./coalitions";
import { assignProvinceTypes, provinceTypesApply, refreshProvinceTypes } from "./provinceTypes";

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
  pruneCoalitions(world); // vassals leave their coalition
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
  pruneCoalitions(world);
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

// --- Editor actions: merging realms, provinces breaking away ---

// Border flag rule of generation: owned land touching water or another owner (8 neighbors)
function isBorderCell(world: WorldData, x: number, y: number): boolean {
  const c = world.grid[x][y];
  const id = c.nationIndex ?? -1;
  if (c.isWater || id < 0) return false;
  const W = world.width;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const ny = y + dy;
      if ((!dx && !dy) || ny < 0 || ny >= world.height) continue;
      const nb = world.grid[(((x + dx) % W) + W) % W][ny];
      if (nb.isWater || (nb.nationIndex ?? -1) !== id) return true;
    }
  return false;
}

// Border flags of the given cells (flat indices) and their neighbors
function refreshBorderFlags(world: WorldData, cells: number[]) {
  const W = world.width;
  const seen = new Set<number>();
  for (const i of cells) {
    const x0 = i % W;
    const y0 = (i - x0) / W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const y = y0 + dy;
        if (y < 0 || y >= world.height) continue;
        const x = (((x0 + dx) % W) + W) % W;
        const k = y * W + x;
        if (seen.has(k)) continue;
        seen.add(k);
        world.grid[x][y].isNationBorder = isBorderCell(world, x, y);
      }
  }
}

// Provinces are shades of their nation's color (see partitionNation): keep a
// province's shade while moving it onto another nation's color
function retint(prov: string, from: string, to: string): string {
  const rgb = (h: string) => {
    const v = parseInt(h.slice(1, 7), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const sum = (c: number[]) => c[0] + c[1] + c[2];
  const f = sum(rgb(from));
  const amt = f > 0 ? Math.max(-0.15, Math.min(0.15, sum(rgb(prov)) / f - 1)) : 0;
  return `#${rgb(to)
    .map((c) => Math.max(0, Math.min(255, Math.round(c * (1 + amt)))).toString(16).padStart(2, "0"))
    .join("")}`;
}

// Nation `from` joins `into`: its land, waters, provinces and cities change
// hands, its vassals pass to into's bloc and it is removed with its relations.
// Returns into's index afterwards, or -1 if nothing was done.
export function mergeNation(world: WorldData, from: number, into: number): number {
  const X = world.nations[from];
  const Y = world.nations[into];
  if (!X || !Y || from === into) return -1;
  // An overlord merging into its own vassal frees it first
  if (Y.overlord === from) releaseVassal(world, into);
  // X's vassals serve the head of into's bloc (vassals never have vassals)
  const head = Y.overlord ?? into;
  world.nations.forEach((n, i) => {
    if (n.overlord !== from) return;
    if (i === head) releaseVassal(world, i);
    else makeVassal(world, i, head);
  });

  const W = world.width;
  const moved: number[] = [];
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    for (let y = 0; y < world.height; y++)
      if (col[y].nationIndex === from) {
        col[y].nationIndex = into;
        moved.push(y * W + x);
      }
  }
  for (const p of world.provinces)
    if (p.nationIndex === from) {
      p.nationIndex = into;
      p.color = retint(p.color, X.color, Y.color);
    }
  for (const c of world.cities)
    if (c.nationIndex === from) {
      c.nationIndex = into;
      c.isCapital = false;
    }
  refreshBorderFlags(world, moved);
  // A realm without a capital city takes the largest one it gained
  relocateCapital(world, into);
  removeNation(world, from);
  // The absorbed capital district is ordinary land now
  refreshProvinceTypes(world);
  return into > from ? into - 1 : into;
}

// Province `provinceId` breaks away as a new nation with its land, cities and
// nearby waters. Its seat city (else its largest city, else its middle)
// becomes the capital; if the old capital left with it, the old realm moves
// its seat. A nation's only province cannot leave. Returns the new nation's
// index, or -1 if nothing was done.
export function provinceIndependence(world: WorldData, provinceId: number): number {
  const P = world.provinces.find((p) => p.id === provinceId);
  const owner = P?.nationIndex ?? -1;
  const old = world.nations[owner];
  if (!P || !old) return -1;
  if (!world.provinces.some((q) => q !== P && q.nationIndex === owner)) return -1;

  const W = world.width;
  const H = world.height;
  const cells: number[] = [];
  const neighbors = new Set<number>([owner]);
  const cultures = new Map<number, number>();
  const faiths = new Map<number, number>();
  const tally = (m: Map<number, number>, k: number | undefined) => {
    if (k !== undefined && k >= 0) m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const c = world.grid[x][y];
      if (c.provinceIndex !== provinceId || c.nationIndex !== owner) continue;
      cells.push(y * W + x);
      tally(cultures, c.cultureIndex);
      tally(faiths, c.religionIndex);
      for (const [nx, ny] of [[(x + 1) % W, y], [(x - 1 + W) % W, y], [x, y - 1], [x, y + 1]]) {
        const n = ny >= 0 && ny < H ? (world.grid[nx][ny].nationIndex ?? -1) : -1;
        if (n >= 0) neighbors.add(n);
      }
    }
  if (!cells.length) return -1;
  const most = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];

  const inProvince = (x: number, y: number) => world.getCell(x, y)?.provinceIndex === provinceId;
  const cities = world.cities.filter((c) => c.nationIndex === owner && (c.provinceIndex === provinceId || inProvince(c.x, c.y)));
  const seat = cities.find((c) => c.id === P.capitalCityId) ?? [...cities].sort((a, b) => b.population - a.population)[0];
  const lostCapital = inProvince(old.capitalX, old.capitalY) || cities.some((c) => c.isCapital);
  const culture = most(cultures) ?? old.cultureId ?? 0;
  const lang = world.languages[culture];
  const mid = cells[cells.length >> 1];
  const idx = appendNation(world, {
    id: 0,
    name: seat?.name ?? P.name,
    color: colorForNewNation(world, [...neighbors]),
    capitalX: seat?.x ?? P.centroidX ?? (mid % W) + 0.5,
    capitalY: seat?.y ?? P.centroidY ?? Math.floor(mid / W) + 0.5,
    cultureId: culture,
    religionId: most(faiths) ?? old.religionId,
    government: lang ? lang.government(0.1, false) : "Kingdom",
  });
  const NT = world.nations[idx];

  for (const i of cells) world.grid[i % W][(i - (i % W)) / W].nationIndex = idx;
  for (const c of cities) {
    c.nationIndex = idx;
    c.isCapital = c === seat;
  }
  P.nationIndex = idx;
  P.color = retint(P.color, old.color, NT.color);

  if (lostCapital) {
    relocateCapital(world, owner);
    // No cities left to rule from: the seat of its largest province
    if (!world.cities.some((c) => c.nationIndex === owner && c.isCapital)) {
      const rest = world.provinces.filter((p) => p.nationIndex === owner).sort((a, b) => (b.area ?? 0) - (a.area ?? 0))[0];
      if (rest) {
        old.capitalX = rest.seatX ?? rest.centroidX ?? old.capitalX;
        old.capitalY = rest.seatY ?? rest.centroidY ?? old.capitalY;
      }
    }
  }
  // Sea claims follow the new coastline
  refreshTerritorialWaters(world);
  refreshBorderFlags(world, cells);

  // A breakaway is no friend of the realm it left
  setRelation(world, idx, owner, "Rival");
  NT.flag = defaultFlagFor(world, idx);
  foundHouse(world, NT, world.year, Math.random);
  // The breakaway province is its new realm's capital district; the old realm's may have moved
  if (provinceTypesApply(world)) {
    refreshProvinceTypes(world);
    assignProvinceTypes(world, { nation: idx });
  }
  return idx;
}

// --- Redrawing borders by province (the map editor's province tool) ---

// A realm to form from provinces: name and color picked in the editor, or
// derived from the land (its people's naming, a color unlike its neighbors')
export interface NewRealm {
  name?: string;
  color?: string;
}

export interface TransferResult {
  nation: number; // the receiving realm's index afterwards (-1: nothing was done)
  moved: number; // provinces that changed hands
  removed: string[]; // names of realms left without land, removed
}

// Provinces `ids` pass to realm `to` (an index), or together form a new realm.
// Each takes its land, cities and nearby waters; a capital that leaves moves
// its old realm's seat to its largest remaining city; a realm left without
// any land is removed. A new realm rules from the seat of its largest
// province and is a rival of every realm it took land from.
// `occupiers`: realms whose cells inside these provinces move too (a peace
// conference: land the victor occupies goes with its province, wherever it goes).
export function transferProvinces(world: WorldData, ids: number[], to: number | NewRealm, occupiers: number[] = []): TransferResult {
  const none: TransferResult = { nation: -1, moved: 0, removed: [] };
  const toNew = typeof to !== "number";
  if (!toNew && !world.nations[to]) return none;
  const provs = [...new Set(ids)]
    .map((id) => world.provinces.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p && !!world.nations[p.nationIndex] && (toNew || p.nationIndex !== to));
  if (!provs.length) return none;

  const W = world.width;
  const H = world.height;
  const owners = new Set(provs.map((p) => p.nationIndex));
  const byId = new Map(provs.map((p) => [p.id, p]));
  // A cell of province P moves if its realm holds it, or one of the occupiers does
  const moves = (P: { nationIndex: number }, cellOwner: number | undefined) =>
    cellOwner !== undefined && (cellOwner === P.nationIndex || (occupiers.includes(cellOwner) && cellOwner >= 0));
  const cells: number[] = [];
  const neighbors = new Set<number>(owners);
  const cultures = new Map<number, number>();
  const faiths = new Map<number, number>();
  const tally = (m: Map<number, number>, k: number | undefined) => {
    if (k !== undefined && k >= 0) m.set(k, (m.get(k) ?? 0) + 1);
  };
  const cellProv = new Int32Array(W * H).fill(-1);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const c = world.grid[x][y];
      const P = c.provinceIndex !== undefined ? byId.get(c.provinceIndex) : undefined;
      if (!P || !moves(P, c.nationIndex)) continue;
      const i = y * W + x;
      cells.push(i);
      owners.add(c.nationIndex!);
      cellProv[i] = P.id;
      tally(cultures, c.cultureIndex);
      tally(faiths, c.religionIndex);
      for (const [nx, ny] of [[(x + 1) % W, y], [(x - 1 + W) % W, y], [x, y - 1], [x, y + 1]]) {
        const n = ny >= 0 && ny < H ? (world.grid[nx][ny].nationIndex ?? -1) : -1;
        if (n >= 0) neighbors.add(n);
      }
    }
  if (!cells.length) return none;
  const most = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const inMoved = (x: number, y: number) => {
    const c = world.getCell(x, y);
    const P = c?.provinceIndex !== undefined ? byId.get(c.provinceIndex) : undefined;
    return !!P && moves(P, c!.nationIndex);
  };
  const cities = world.cities.filter((c) => {
    const P = c.provinceIndex !== undefined ? byId.get(c.provinceIndex) : undefined;
    return (P && moves(P, c.nationIndex)) || (owners.has(c.nationIndex) && inMoved(c.x, c.y));
  });
  // Realms whose capital leaves with these provinces
  const lostCapital = new Set<number>();
  for (const o of owners) {
    const n = world.nations[o];
    if (inMoved(n.capitalX, n.capitalY) || cities.some((c) => c.nationIndex === o && c.isCapital)) lostCapital.add(o);
  }

  // The receiving realm
  let t: number;
  if (toNew) {
    const largest = [...provs].sort((a, b) => (b.area ?? 0) - (a.area ?? 0))[0];
    const inLargest = cities.filter((c) => c.provinceIndex === largest.id);
    const seat =
      cities.find((c) => c.id === largest.capitalCityId) ?? [...(inLargest.length ? inLargest : cities)].sort((a, b) => b.population - a.population)[0];
    const old = world.nations[largest.nationIndex];
    const culture = most(cultures) ?? old.cultureId ?? 0;
    const lang = world.languages[culture];
    const mid = cells[cells.length >> 1];
    const name = to.name?.trim() || (provs.length === 1 ? (seat?.name ?? largest.name) : (lang?.nationName() ?? seat?.name ?? largest.name));
    t = appendNation(world, {
      id: 0,
      name,
      color: to.color || colorForNewNation(world, [...neighbors]),
      capitalX: seat?.x ?? largest.centroidX ?? (mid % W) + 0.5,
      capitalY: seat?.y ?? largest.centroidY ?? Math.floor(mid / W) + 0.5,
      cultureId: culture,
      religionId: most(faiths) ?? old.religionId,
      government: lang ? lang.government(Math.min(1, cells.length / 4000), false) : "Kingdom",
    });
    for (const c of cities) c.isCapital = c === seat;
  } else {
    t = to;
    for (const c of cities) c.isCapital = false;
  }
  const T = world.nations[t];

  for (const i of cells) world.grid[i % W][(i - (i % W)) / W].nationIndex = t;
  for (const c of cities) c.nationIndex = t;
  for (const P of provs) {
    P.color = retint(P.color, world.nations[P.nationIndex].color, T.color);
    P.nationIndex = t;
  }
  // A realm annexing land keeps its own capital; one without a capital city takes the largest it gained
  if (!toNew) relocateCapital(world, t);

  for (const o of lostCapital) {
    const old = world.nations[o];
    relocateCapital(world, o);
    // No cities left to rule from: the seat of its largest province
    if (!world.cities.some((c) => c.nationIndex === o && c.isCapital)) {
      const rest = world.provinces.filter((p) => p.nationIndex === o).sort((a, b) => (b.area ?? 0) - (a.area ?? 0))[0];
      if (rest) {
        old.capitalX = rest.seatX ?? rest.centroidX ?? old.capitalX;
        old.capitalY = rest.seatY ?? rest.centroidY ?? old.capitalY;
      }
    }
  }
  if (toNew) {
    // A realm carved out of others is no friend of theirs
    for (const o of owners) setRelation(world, t, o, "Rival");
    T.flag = defaultFlagFor(world, t);
    foundHouse(world, T, world.year, Math.random);
  }

  // Sea claims follow the new coastline
  refreshTerritorialWaters(world);
  refreshBorderFlags(world, cells);

  // Realms left with no land at all are gone (highest index first, so the
  // others keep theirs while removing)
  const landOf = new Map<number, number>();
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const c = world.grid[x][y];
      if (!c.isWater && c.nationIndex !== undefined && owners.has(c.nationIndex)) landOf.set(c.nationIndex, (landOf.get(c.nationIndex) ?? 0) + 1);
    }
  const removed: string[] = [];
  for (const o of [...owners].sort((a, b) => b - a)) {
    if (o === t || landOf.get(o)) continue;
    removed.push(world.nations[o].name);
    // Its vassals go free with it
    world.nations.forEach((n, i) => {
      if (n.overlord === o) releaseVassal(world, i);
    });
    removeNation(world, o);
    if (o < t) t--;
  }

  if (provinceTypesApply(world)) {
    refreshProvinceTypes(world);
    if (toNew) assignProvinceTypes(world, { nation: t });
  }
  return { nation: t, moved: provs.length, removed };
}

// --- Splitting and merging provinces (peace conferences) ---

const COMPASS = ["East", "South-East", "South", "South-West", "West", "North-West", "North", "North-East"];
// "North Kvstad March": a part of a province named by where it lies in it
function partName(base: string, dx: number, dy: number, taken: Set<string>): string {
  const word = Math.hypot(dx, dy) < 0.5 ? "Inner" : COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
  let name = `${word} ${base}`;
  for (let k = 2; taken.has(name); k++) name = `${word} ${base} ${k}`;
  taken.add(name);
  return name;
}

// Province records refreshed from the cells: area, centroid, a share of the people
function remeasure(world: WorldData, provs: Province[], pop0: Map<Province, number>, cells0: Map<Province, number>) {
  const W = world.width;
  const ids = new Map(provs.map((p) => [p.id, p]));
  const n = new Map<Province, number>();
  const sx = new Map<Province, number>();
  const sy = new Map<Province, number>();
  for (let x = 0; x < W; x++)
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      const p = c.isWater || c.provinceIndex === undefined ? undefined : ids.get(c.provinceIndex);
      if (!p) continue;
      n.set(p, (n.get(p) ?? 0) + 1);
      sx.set(p, (sx.get(p) ?? 0) + x + 0.5);
      sy.set(p, (sy.get(p) ?? 0) + y + 0.5);
    }
  for (const p of provs) {
    const k = n.get(p) ?? 0;
    if (!k) continue;
    p.area = Math.round(k * CELL_KM2);
    p.centroidX = sx.get(p)! / k;
    p.centroidY = sy.get(p)! / k;
    const total = pop0.get(p);
    if (total !== undefined) p.population = Math.round((total * k) / Math.max(1, cells0.get(p) ?? k));
  }
}

// Splits province `p` into `parts` contiguous pieces inside its outline,
// following the land: its towns are the pieces' centers (the largest first,
// then seeds spread over what is left), and pieces grow outward by travel
// cost, so crossing a river or climbing a ridge is dear and the cuts fall
// along them. The piece holding the seat keeps the name, seat and type; a
// piece with a town is named after it ("Lands of Kvstad"), the rest by
// where they lie ("North …"). Returns every piece, `p` first.
export function splitProvince(world: WorldData, p: Province, parts: number, rand: () => number = Math.random, given?: number[][]): Province[] {
  const pieces = given ?? pieceCells(world, p, parts, rand);
  if (pieces.length < 2) return [p];
  return applyPieces(world, p, pieces);
}

// The land of province `p` cut into up to `parts` pieces (cells, flat
// indices), its seat's piece first; nothing in the world changes. See
// splitProvince for how the land is cut.
export function pieceCells(world: WorldData, p: Province, parts: number, rand: () => number = Math.random): number[][] {
  const W = world.width;
  const H = world.height;
  const cells: number[] = [];
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const c = world.grid[x][y];
      if (!c.isWater && c.provinceIndex === p.id) cells.push(y * W + x);
    }
  const k = Math.max(1, Math.min(parts, Math.floor(cells.length / 3)));
  if (k < 2) return [cells];
  const inP = new Set(cells);
  const dist = (i: number, j: number) => {
    let dx = Math.abs((i % W) - (j % W));
    if (dx > W / 2) dx = W - dx;
    return Math.hypot(dx, Math.floor(i / W) - Math.floor(j / W));
  };
  const cellOf = (x: number, y: number) => Math.floor(y) * W + ((Math.floor(x) % W) + W) % W;
  // Seeds: the seat, then the province's towns by size (spread apart), then farthest points
  const spacing = Math.sqrt(cells.length / k) * 0.8;
  const seeds: number[] = [];
  const seatCell = p.seatX !== undefined && p.seatY !== undefined ? cellOf(p.seatX, p.seatY) : -1;
  seeds.push(inP.has(seatCell) ? seatCell : cells[Math.floor(rand() * cells.length)]);
  const towns = world.cities
    .filter((c) => inP.has(cellOf(c.x, c.y)))
    .sort((a, b) => b.population - a.population);
  for (const t of towns) {
    if (seeds.length >= k) break;
    const c = cellOf(t.x, t.y);
    if (seeds.every((s0) => dist(s0, c) >= spacing)) seeds.push(c);
  }
  const near = cells.map((i) => Math.min(...seeds.map((s0) => dist(i, s0))));
  while (seeds.length < k) {
    let best = 0;
    for (let c = 1; c < cells.length; c++) if (near[c] > near[best]) best = c;
    if (near[best] < 1) break;
    seeds.push(cells[best]);
    for (let c = 0; c < cells.length; c++) near[c] = Math.min(near[c], dist(cells[c], cells[best]));
  }
  // Growth by travel cost (Dijkstra over the province's land, a little noise for ragged borders)
  const cost = (from: number, to: number) => {
    const a = world.grid[from % W][Math.floor(from / W)];
    const b = world.grid[to % W][Math.floor(to / W)];
    let c = 1 + rand() * 0.35;
    if (a.hasRiver !== b.hasRiver || (a.hasRiver && b.hasRiver)) c += 5; // rivers part the land
    c += Math.abs(b.elevation - a.elevation) * 60; // slopes
    if (Math.max(a.elevation, b.elevation) > 0.67) c += 3; // ridges
    return c;
  };
  const owner = new Map<number, number>();
  const best = new Map<number, number>();
  const heap: [number, number, number][] = []; // [cost, cell, piece]
  const push = (e: [number, number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (heap[j][0] <= heap[i][0]) break;
      [heap[i], heap[j]] = [heap[j], heap[i]];
      i = j;
    }
  };
  const pop = (): [number, number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  seeds.forEach((s0, i) => {
    best.set(s0, 0);
    push([0, s0, i]);
  });
  while (heap.length) {
    const [c0, cell, piece] = pop();
    if (owner.has(cell) || c0 > (best.get(cell) ?? Infinity)) continue;
    owner.set(cell, piece);
    const x = cell % W;
    const y = Math.floor(cell / W);
    for (const nb of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), y > 0 ? cell - W : -1, y < H - 1 ? cell + W : -1]) {
      if (nb < 0 || !inP.has(nb) || owner.has(nb)) continue;
      const c1 = c0 + cost(cell, nb);
      if (c1 < (best.get(nb) ?? Infinity)) {
        best.set(nb, c1);
        push([c1, nb, piece]);
      }
    }
  }
  // Land cut off from every seed goes to the nearest one
  for (const c of cells)
    if (!owner.has(c)) {
      let b = 0;
      for (let i = 1; i < seeds.length; i++) if (dist(c, seeds[i]) < dist(c, seeds[b])) b = i;
      owner.set(c, b);
    }
  const out: number[][] = seeds.map(() => []);
  for (const [c, i] of owner) out[i].push(c);
  return out.filter((q, i) => i === 0 || q.length > 0);
}

// Where a piece lies in its province, and its largest town (for its name)
export function pieceLabel(world: WorldData, p: Province, cells: number[], taken = new Set<string>()): string {
  const W = world.width;
  const inside = new Set(cells);
  const town = world.cities
    .filter((c) => inside.has(Math.floor(c.y) * W + ((Math.floor(c.x) % W) + W) % W))
    .sort((a, b) => b.population - a.population)[0];
  if (town && !taken.has(`Lands of ${town.name}`)) {
    taken.add(`Lands of ${town.name}`);
    return `Lands of ${town.name}`;
  }
  let sx = 0;
  let sy = 0;
  const ref = cells[0];
  for (const c of cells) {
    let dx = (c % W) - (ref % W);
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    sx += (ref % W) + dx + 0.5;
    sy += Math.floor(c / W) + 0.5;
  }
  sx /= cells.length;
  sy /= cells.length;
  let dx = sx - (p.centroidX ?? sx);
  if (dx > W / 2) dx -= W;
  if (dx < -W / 2) dx += W;
  const span = Math.sqrt((p.area ?? cells.length * CELL_KM2) / CELL_KM2 / Math.PI) || 1;
  return partName(p.name, dx / span, (sy - (p.centroidY ?? sy)) / span, taken);
}

// Turns pieces of `p` (its seat's piece first) into provinces of their own
function applyPieces(world: WorldData, p: Province, pieces: number[][]): Province[] {
  const W = world.width;
  const total = pieces.reduce((s0, q) => s0 + q.length, 0);
  const pop0 = p.population ?? 0;
  const taken = new Set(world.provinces.map((q) => q.name));
  const out: Province[] = [p];
  for (let i = 1; i < pieces.length; i++) {
    const cells = pieces[i];
    const mid = cells[cells.length >> 1];
    out.push({
      id: world.provinces.length,
      name: pieceLabel(world, p, cells, taken),
      color: p.color,
      nationIndex: p.nationIndex,
      capitalCityId: -1,
      seatX: (mid % W) + 0.5,
      seatY: Math.floor(mid / W) + 0.5,
    });
    world.provinces.push(out[i]);
    for (const c of cells) world.grid[c % W][Math.floor(c / W)].provinceIndex = out[i].id;
  }
  // Cities follow the land they stand on; a piece takes its largest town as seat and name
  for (const city of world.cities) {
    if (city.provinceIndex !== p.id) continue;
    const c = world.getCell(city.x, city.y);
    if (c?.provinceIndex !== undefined && c.provinceIndex !== p.id) city.provinceIndex = c.provinceIndex;
  }
  for (const q of out.slice(1)) {
    const seat = world.cities.filter((c) => c.provinceIndex === q.id).sort((a, b) => b.population - a.population)[0];
    if (!seat) continue;
    q.capitalCityId = seat.id;
    q.seatX = seat.x;
    q.seatY = seat.y;
  }
  remeasure(world, out, new Map(out.map((q) => [q, pop0])), new Map(out.map((q) => [q, total])));
  return out;
}

// Removes provinces, re-indexing what refers to the rest (their land is
// expected to belong to another province already)
function dropProvinces(world: WorldData, gone: Set<Province>) {
  if (!gone.size) return;
  const remap = new Map<number, number>();
  const kept = world.provinces.filter((p) => !gone.has(p));
  const goneIds = new Set([...gone].map((p) => p.id));
  kept.forEach((p, i) => {
    remap.set(p.id, i);
    p.id = i;
  });
  world.provinces = kept;
  const fix = (v: number | undefined) => (v === undefined || v < 0 ? v : goneIds.has(v) ? -1 : (remap.get(v) ?? -1));
  for (let x = 0; x < world.width; x++) {
    const col = world.grid[x];
    for (let y = 0; y < world.height; y++) col[y].provinceIndex = fix(col[y].provinceIndex);
  }
  for (const c of world.cities) c.provinceIndex = fix(c.provinceIndex);
}

// Pieces join `into` again: their land, towns and people
export function mergeProvinces(world: WorldData, into: Province, others: Province[]) {
  const gone = new Set(others.filter((o) => o !== into && world.provinces.includes(o)));
  if (!gone.size) return;
  const ids = new Set([...gone].map((o) => o.id));
  for (let x = 0; x < world.width; x++) {
    const col = world.grid[x];
    for (let y = 0; y < world.height; y++) if (col[y].provinceIndex !== undefined && ids.has(col[y].provinceIndex!)) col[y].provinceIndex = into.id;
  }
  for (const c of world.cities) if (c.provinceIndex !== undefined && ids.has(c.provinceIndex)) c.provinceIndex = into.id;
  const pop = (into.population ?? 0) + [...gone].reduce((s, o) => s + (o.population ?? 0), 0);
  dropProvinces(world, gone);
  into.population = pop;
  remeasure(world, [into], new Map(), new Map());
}

// A peace that keeps the war's lines: each side keeps exactly the land it
// occupies of the other's provinces, which becomes a province of its own
// ("West Kvstad March"); a province occupied whole simply changes hands.
// Returns the number of provinces that changed or were made.
export function keepOccupied(world: WorldData, a: number, b: number): number {
  const W = world.width;
  const occupied = new Map<Province, number[]>(); // province -> its cells held by the other side
  const sizes = new Map<Province, number>();
  for (let x = 0; x < W; x++)
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      const p = c.isWater || c.provinceIndex === undefined ? undefined : world.provinces[c.provinceIndex];
      if (!p || (p.nationIndex !== a && p.nationIndex !== b)) continue;
      sizes.set(p, (sizes.get(p) ?? 0) + 1);
      const other = p.nationIndex === a ? b : a;
      if (c.nationIndex === other) (occupied.get(p) ?? occupied.set(p, []).get(p)!).push(y * W + x);
    }
  const taken = new Set(world.provinces.map((q) => q.name));
  let changed = 0;
  for (const [p, cells] of occupied) {
    const other = p.nationIndex === a ? b : a;
    const color = world.provinces.find((q) => q.nationIndex === other)?.color ?? world.nations[other]?.color ?? p.color;
    if (cells.length >= (sizes.get(p) ?? 0)) {
      p.nationIndex = other;
      p.color = color;
      changed++;
      continue;
    }
    let sx = 0;
    let sy = 0;
    for (const c of cells) {
      sx += (c % W) + 0.5;
      sy += Math.floor(c / W) + 0.5;
    }
    sx /= cells.length;
    sy /= cells.length;
    let dx = sx - (p.centroidX ?? sx);
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    const span = Math.sqrt((sizes.get(p) ?? 1) / Math.PI) || 1;
    const q: Province = {
      id: world.provinces.length,
      name: partName(p.name, dx / span, (sy - (p.centroidY ?? sy)) / span, taken),
      color,
      nationIndex: other,
      capitalCityId: -1,
      seatX: sx,
      seatY: sy,
    };
    world.provinces.push(q);
    for (const c of cells) world.grid[c % W][Math.floor(c / W)].provinceIndex = q.id;
    for (const city of world.cities) {
      const cc = world.getCell(city.x, city.y);
      if (city.provinceIndex === p.id && cc?.provinceIndex === q.id) city.provinceIndex = q.id;
    }
    const seat = world.cities.filter((c) => c.provinceIndex === q.id).sort((x, y) => y.population - x.population)[0];
    if (seat) {
      q.capitalCityId = seat.id;
      q.seatX = seat.x;
      q.seatY = seat.y;
    }
    const pop = p.population ?? 0;
    remeasure(world, [p, q], new Map([[p, pop], [q, pop]]), new Map([[p, sizes.get(p)!], [q, sizes.get(p)!]]));
    changed++;
  }
  if (provinceTypesApply(world)) refreshProvinceTypes(world);
  return changed;
}

// Land for a realm founded in the editor at (x, y): it spreads from there the
// way a history offensive does. Open country is cheap; river crossings and
// climbs are dear, so it tends to stop at rivers, ridges and the coast; land
// already held by a realm costs more to take, and capitals are never taken.
// Returns the number of cells claimed.
export function claimFoundingLand(world: WorldData, idx: number, x: number, y: number, rand: () => number = Math.random): number {
  const W = world.width;
  const H = world.height;
  const start = world.getCell(x, y);
  if (!start || start.isWater) return 0;
  const budget = Math.max(40, Math.round(450 * (W / 800) ** 2));
  const reach = 1.7 * Math.sqrt(budget) + 3;
  const capitals = new Set(world.nations.map((n, i) => (i === idx ? -1 : Math.floor(n.capitalY) * W + (((Math.floor(n.capitalX) % W) + W) % W))));
  const cost = new Float64Array(W * H).fill(Infinity);
  // Binary min-heap of [priority, cell]
  const pri: number[] = [];
  const cells: number[] = [];
  const push = (p: number, c: number) => {
    let i = pri.length;
    pri.push(p);
    cells.push(c);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (pri[up] <= pri[i]) break;
      [pri[up], pri[i]] = [pri[i], pri[up]];
      [cells[up], cells[i]] = [cells[i], cells[up]];
      i = up;
    }
  };
  const pop = (): number => {
    const top = cells[0];
    const lp = pri.pop()!;
    const lc = cells.pop()!;
    if (pri.length) {
      pri[0] = lp;
      cells[0] = lc;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < pri.length && pri[l] < pri[m]) m = l;
        if (r < pri.length && pri[r] < pri[m]) m = r;
        if (m === i) break;
        [pri[m], pri[i]] = [pri[i], pri[m]];
        [cells[m], cells[i]] = [cells[i], cells[m]];
        i = m;
      }
    }
    return top;
  };
  const sx = ((x % W) + W) % W;
  const s = y * W + sx;
  cost[s] = 0;
  push(0, s);
  let taken = 0;
  const done = new Uint8Array(W * H);
  while (pri.length && taken < budget) {
    const c = pop();
    if (done[c]) continue;
    done[c] = 1;
    const g = cost[c];
    if (g > reach) break;
    const cx = c % W;
    const cy = (c - cx) / W;
    const cell = world.grid[cx][cy];
    cell.nationIndex = idx;
    taken++;
    for (let d = 0; d < 4; d++) {
      const nx = d === 0 ? (cx + 1) % W : d === 1 ? (cx - 1 + W) % W : cx;
      const ny = d === 2 ? cy - 1 : d === 3 ? cy + 1 : cy;
      if (ny < 0 || ny >= H) continue;
      const j = ny * W + nx;
      if (done[j] || capitals.has(j)) continue;
      const nb = world.grid[nx][ny];
      if (nb.isWater) continue;
      const owner = nb.nationIndex ?? -1;
      const held = owner >= 0 && owner !== idx ? 3 : 1;
      const crossing = nb.hasRiver && !cell.hasRiver ? 7 : 0;
      const climb = Math.max(0, nb.elevation - cell.elevation) * 70 + Math.max(0, nb.elevation - 0.66) * 30;
      const gj = g + (held + crossing + climb) * (0.7 + rand() * 0.6);
      if (gj >= cost[j]) continue;
      cost[j] = gj;
      let dx = Math.abs(nx - sx);
      if (dx > W / 2) dx = W - dx;
      push(gj + Math.hypot(dx, ny - y) * 0.15, j);
    }
  }
  return taken;
}
