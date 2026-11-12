import type { Nation, RelationType, WorldData } from "./WorldData";
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
