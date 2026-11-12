import type { Province, WorldData } from "./WorldData";
import { mulberry } from "./names";
import { atLeast } from "./version";

// What kind of province it is within its realm. Undefined on a province means
// "province": ordinary land. Generated from 0.2 on (see assignProvinceTypes);
// the editor can set any of them on any world.

export type ProvinceType = "province" | "capital" | "autonomous" | "march" | "territory" | "colony";

export interface ProvinceTypeInfo {
  id: ProvinceType;
  label: string; // "Autonomous region"
  short: string; // for tight spots: "Autonomous"
  plural: string; // "Autonomous regions"
  of: string; // tooltip lead: "Autonomous region of"
  icon: string; // one text glyph for badges ("" for ordinary provinces)
  description: string;
}

// U+FE0E keeps glyphs that also exist as emoji in text style
export const PROVINCE_TYPES: ProvinceTypeInfo[] = [
  { id: "province", plural: "Provinces", label: "Province", short: "Province", of: "Province of", icon: "", description: "Ordinary land of the realm, ruled through its governor." },
  { id: "capital", plural: "Capital districts", label: "Capital district", short: "Capital", of: "Capital district of", icon: "★", description: "Holds the seat of the realm and is ruled from its court." },
  { id: "autonomous", plural: "Autonomous regions", label: "Autonomous region", short: "Autonomous", of: "Autonomous region of", icon: "◈", description: "Governs itself within the realm, keeping its own laws and often its own people." },
  { id: "march", plural: "Marches", label: "March", short: "March", of: "March of", icon: "⚔︎", description: "A frontier held by a warden against a hostile neighbour." },
  { id: "territory", plural: "Territories", label: "Territory", short: "Territory", of: "Territory of", icon: "◇", description: "Thinly settled or remote land, governed directly by the crown." },
  { id: "colony", plural: "Colonies", label: "Colony", short: "Colony", of: "Colony of", icon: "⚓︎", description: "An overseas holding, apart from the realm's home landmass." },
];

const BY_ID = new Map(PROVINCE_TYPES.map((t) => [t.id, t]));

export const provinceType = (p: Province | undefined): ProvinceType => p?.type ?? "province";
export const provinceTypeInfo = (p: Province | ProvinceType | undefined): ProvinceTypeInfo =>
  BY_ID.get(typeof p === "string" ? p : provinceType(p)) ?? PROVINCE_TYPES[0];
export const isAutonomous = (p: Province | undefined) => p?.type === "autonomous";
export const isProvinceType = (v: unknown): v is ProvinceType => typeof v === "string" && BY_ID.has(v as ProvinceType);

// "2 marches · 1 autonomous region" for the special provinces among these (capital districts left out)
export function provinceTypeSummary(provinces: Province[]): string {
  const n = new Map<ProvinceType, number>();
  for (const p of provinces) if (p.type && p.type !== "province" && p.type !== "capital") n.set(p.type, (n.get(p.type) ?? 0) + 1);
  return PROVINCE_TYPES.filter((t) => n.has(t.id))
    .map((t) => `${n.get(t.id)} ${(n.get(t.id) === 1 ? t.label : t.plural).toLowerCase()}`)
    .join(" · ");
}

// Stores a type, leaving ordinary provinces without the field
export function setProvinceType(p: Province, t: ProvinceType) {
  if (t === "province") delete p.type;
  else p.type = t;
}

// Province types are generated (and kept up by the editor and history) from 0.2 on
export const provinceTypesApply = (world: WorldData) => atLeast(world.version, "0.2");

// --- Generation ---

const AUTONOMY_CHANCE = 0.5; // of a province whose people differ from the realm's
const MARCH_HOSTILE = 0.3; // share of the border facing a rival or enemy
const MARCH_FOREIGN = 0.6; // share of the border facing any other realm
const TERRITORY_DENSITY = 0.3; // of the realm's own density
const COLONY_MIN_CELLS = 40; // at 800 cells wide: smaller isles off the coast are no colonies

interface Stats {
  cells: number;
  landmass: Map<number, number>; // cells per landmass
  edges: number; // cell sides on its border (other provinces, realms, sea)
  foreign: number; // sides facing another realm's land
  hostile: number; // sides facing a rival's or enemy's land
  cult: Map<number, number>;
  settled: number; // cells with a culture
}

// A nation's capital cell: its capital city, else its capital point
function capitalCell(world: WorldData, n: number): number {
  const W = world.width;
  const city = world.cities.find((c) => c.nationIndex === n && c.isCapital);
  const nt = world.nations[n];
  const x = city?.x ?? nt?.capitalX;
  const y = city?.y ?? nt?.capitalY;
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const cy = Math.floor(y);
  if (cy < 0 || cy >= world.height) return -1;
  return cy * W + (((Math.floor(x) % W) + W) % W);
}

function capitalProvince(world: WorldData, n: number, cell: number): number {
  if (cell < 0) return -1;
  const W = world.width;
  const c = world.grid[cell % W][(cell - (cell % W)) / W];
  const p = c.provinceIndex ?? -1;
  if (p >= 0 && world.provinces[p]?.nationIndex === n) return p;
  const city = world.cities.find((ct) => ct.nationIndex === n && ct.isCapital);
  const q = city?.provinceIndex ?? -1;
  return q >= 0 && world.provinces[q]?.nationIndex === n ? q : -1;
}

// Roll in [0, 1) fixed by the world's politics seed and the province's seat,
// so it never draws from the generation streams and survives re-indexing
function roll(world: WorldData, p: Province, salt: number): number {
  const sx = Math.round((p.seatX ?? p.centroidX ?? p.id) * 8);
  const sy = Math.round((p.seatY ?? p.centroidY ?? 0) * 8);
  const r = mulberry((world.politicsSeed ^ 0x7e1a5c3b ^ Math.imul(sx, 0x9e3779b1) ^ Math.imul(sy, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0);
  r();
  return r();
}

export interface AssignOptions {
  nation?: number; // only this nation's provinces
  // Provinces that keep their current type, unless it is a capital district
  // that no longer holds the capital
  keep?: (p: Province) => boolean;
  // Cells of every province of `nation` by id, when the caller already has them
  cells?: Map<number, number[]>;
}

// Gives provinces their type from the land: the capital's province, overseas
// colonies, peoples apart (autonomous), hostile frontiers (marches) and
// empty country (territories). Draws no random numbers from the generators.
export function assignProvinceTypes(world: WorldData, opts: AssignOptions = {}) {
  const W = world.width;
  const H = world.height;
  const targets = world.provinces.filter(
    (p) => (opts.nation === undefined || p.nationIndex === opts.nation) && !!world.nations[p.nationIndex],
  );
  if (!targets.length) return;

  // Capital province and cell per nation involved
  const capProv = new Map<number, number>();
  const capCell = new Map<number, number>();
  for (const p of targets) {
    const n = p.nationIndex;
    if (capProv.has(n)) continue;
    const cell = capitalCell(world, n);
    capCell.set(n, cell);
    capProv.set(n, capitalProvince(world, n, cell));
  }
  // Nations whose capital district no longer holds the capital
  const moved = new Set<number>();
  for (const p of targets) if (p.type === "capital" && capProv.get(p.nationIndex) !== p.id) moved.add(p.nationIndex);

  const derive: Province[] = [];
  for (const p of targets) {
    const kept = opts.keep?.(p) ?? false;
    if (capProv.get(p.nationIndex) === p.id) {
      // A kept capital province the user made something else stays so,
      // unless the capital has just moved into it
      if (!kept || p.type === undefined || moved.has(p.nationIndex)) p.type = "capital";
      continue;
    }
    if (kept && p.type !== "capital") continue;
    derive.push(p);
  }
  if (!derive.length) return;

  // One pass over the land of the nations involved: the provinces to derive,
  // and how much land each nation holds on each landmass
  const stats = new Map<number, Stats>();
  for (const p of derive)
    stats.set(p.id, { cells: 0, landmass: new Map(), edges: 0, foreign: 0, hostile: 0, cult: new Map(), settled: 0 });
  const nations = new Set(derive.map((p) => p.nationIndex));
  const holdings = new Map<number, Map<number, number>>();
  for (const n of nations) holdings.set(n, new Map());
  const visit = (i: number, n: number, prov: number) => {
    const lm = world.landmass[i];
    const hold = holdings.get(n)!;
    hold.set(lm, (hold.get(lm) ?? 0) + 1);
    const s = stats.get(prov);
    if (!s) return;
    const x = i % W;
    const y = (i - x) / W;
    s.cells++;
    s.landmass.set(lm, (s.landmass.get(lm) ?? 0) + 1);
    const ci = world.grid[x][y].cultureIndex;
    if (ci !== undefined && ci >= 0) {
      s.settled++;
      s.cult.set(ci, (s.cult.get(ci) ?? 0) + 1);
    }
    const rel = world.relations[n];
    const side = (nx: number, ny: number) => {
      if (ny < 0 || ny >= H) return;
      const o = world.grid[nx][ny];
      if (!o.isWater && o.provinceIndex === prov) return;
      s.edges++;
      const on = o.nationIndex ?? -1;
      if (o.isWater || on < 0 || on === n) return;
      s.foreign++;
      const r = rel?.[on];
      if (r === "Rival" || r === "War") s.hostile++;
    };
    side((x + 1) % W, y);
    side((x - 1 + W) % W, y);
    side(x, y - 1);
    side(x, y + 1);
  };
  if (opts.cells && opts.nation !== undefined) {
    for (const [id, cells] of opts.cells) for (const i of cells) visit(i, opts.nation, id);
  } else {
    for (let x = 0; x < W; x++) {
      const col = world.grid[x];
      for (let y = 0; y < H; y++) {
        const c = col[y];
        const n = c.nationIndex ?? -1;
        const p = c.provinceIndex ?? -1;
        if (c.isWater || p < 0 || !nations.has(n) || world.provinces[p]?.nationIndex !== n) continue;
        visit(y * W + x, n, p);
      }
    }
  }

  // Home landmass: the capital's, unless the capital sits on an islet off the
  // realm's real heartland (then where most of its land is)
  const home = new Map<number, number>();
  for (const [n, hold] of holdings) {
    const cell = capCell.get(n) ?? -1;
    const capLm = cell >= 0 ? world.landmass[cell] : -1;
    let total = 0;
    let best = -1;
    let bestN = 0;
    hold.forEach((v, lm) => {
      total += v;
      if (lm >= 0 && (v > bestN || (v === bestN && lm < best))) {
        bestN = v;
        best = lm;
      }
    });
    home.set(n, capLm >= 0 && (hold.get(capLm) ?? 0) * 4 >= total ? capLm : best);
  }

  // The realm's own density, to tell empty country from settled land
  const density = new Map<number, { pop: number; area: number; count: number }>();
  for (const p of world.provinces) {
    if (!nations.has(p.nationIndex)) continue;
    const d = density.get(p.nationIndex) ?? { pop: 0, area: 0, count: 0 };
    d.pop += p.population ?? 0;
    d.area += p.area ?? 0;
    d.count++;
    density.set(p.nationIndex, d);
  }
  const minColony = COLONY_MIN_CELLS * (W / 800) ** 2;

  for (const p of derive) {
    const s = stats.get(p.id)!;
    const n = p.nationIndex;
    const nation = world.nations[n];
    let t: ProvinceType = "province";
    if (s.cells > 0) {
      const h = home.get(n) ?? -1;
      let major = -1;
      let most = 0;
      s.cult.forEach((v, k) => {
        if (v > most || (v === most && k < major)) {
          most = v;
          major = k;
        }
      });
      const d = density.get(n);
      const realmDensity = d && d.area > 0 ? d.pop / d.area : 0;
      const own = p.area && p.area > 0 ? (p.population ?? 0) / p.area : realmDensity;
      if (h >= 0 && (s.landmass.get(h) ?? 0) * 2 < s.cells && s.cells >= minColony) t = "colony";
      else if (
        nation.cultureId !== undefined &&
        major >= 0 &&
        major !== nation.cultureId &&
        most * 2 > s.settled &&
        roll(world, p, major) < AUTONOMY_CHANCE
      )
        t = "autonomous";
      else if (s.edges > 0 && (s.hostile >= s.edges * MARCH_HOSTILE || s.foreign >= s.edges * MARCH_FOREIGN)) t = "march";
      else if ((d?.count ?? 0) >= 3 && realmDensity > 0 && own < realmDensity * TERRITORY_DENSITY) t = "territory";
    }
    setProvinceType(p, t);
  }
}

// After borders, capitals or relations moved (editor, history): fixes the
// capital districts and leaves the rest, including the user's choices
export function refreshProvinceTypes(world: WorldData) {
  if (!provinceTypesApply(world)) return;
  assignProvinceTypes(world, { keep: () => true });
}
