import type { City, CityPlan, River, WorldData } from "../WorldData";
import { cultureNear } from "../peoples";
import {
  type Poly,
  type Vec,
  area,
  centroid,
  distToSegment,
  insetConvex,
  longestEdge,
  splitConvex,
} from "./geom";

// Procedural city plans in real-world meters, local to the city center
// (+x east, +y south). Built lazily; see CityRenderer for the LOD logic.

export type WardType =
  | "market"
  | "castle"
  | "cathedral"
  | "residential"
  | "wealthy"
  | "harbor"
  | "craft"
  | "park"
  | "cemetery"
  | "palace"
  | "suburb"
  | "green";

export type RoofForm = "gable" | "hip" | "flat";

export interface Building {
  faces: Poly[]; // roof planes
  shades: number[]; // 0 (darkest) .. 3 (lit), one per face
  bucket: number; // palette index
  wealthy: boolean;
}

export interface WardDetail {
  blocks: Poly[]; // yards / block ground
  buildings: Building[];
  trees: number[]; // x, y, r triples
  plazas: Poly[];
  paths: Vec[][];
  stalls: Poly[];
  graves: Poly[];
  ponds: Poly[];
  hedges: Poly[];
  landmarks: Landmark[];
  domes: number[]; // x, y, r triples
  minarets: number[]; // x, y, r triples
}

export interface Ward {
  poly: Poly;
  type: WardType;
  c: Vec;
  d: number;
  inside: boolean;
  coastal: boolean;
  riverside: boolean;
  bbox: [number, number, number, number];
  detail?: WardDetail;
  seed: number;
  // Width of the street along each edge of the outline (edge i runs from
  // poly[i] to poly[i+1]); 0 where no street runs (the back of a roadside strip)
  front: number[];
  elev: number; // ground height at its center, meters
}

export interface Landmark {
  kind: "castle" | "cathedral" | "church" | "temple" | "townhall" | "palace" | "windmill" | "lighthouse" | "fountain" | "keep";
  polys: Poly[]; // roof-colored parts
  accents: Poly[]; // darker parts (towers, apse)
  circles: number[]; // x, y, r triples (towers, fountains)
  stone: boolean;
}

export interface CityStyle {
  ground: string;
  street: string;
  yard: string;
  plaza: string;
  roofs: string[];
  wealthyRoofs: string[];
  flat: boolean;
  wall: string;
  wallDark: string;
  tree: string;
  treeDark: string;
  fields: string[];
  palm: boolean;
  roofForm: RoofForm | "mixed";
  domeColor: string | null;
  onion: boolean; // onion domes on churches
  minarets: boolean;
  bazaar: boolean;
}

export interface CityLayout {
  city: City;
  R: number;
  Ru: number;
  Rf: number;
  res: number;
  n: number;
  origin: number;
  field: Float32Array; // min(coast, river) signed distance in meters, > 0 land
  coastF: Float32Array;
  riverF: Float32Array;
  waterLoops: Poly[];
  wards: Ward[];
  arteries: { pts: Vec[]; width: number }[];
  wall: { poly: Poly; towers: Vec[]; gates: Vec[]; segments: [Vec, Vec][] } | null;
  bridges: { a: Vec; b: Vec; width: number }[];
  piers: Poly[];
  boats: { x: number; y: number; a: number; len: number; sail: boolean }[];
  fields: { poly: Poly; color: number; alpha: number }[];
  farmTrees: number[];
  farmBuildings: Poly[];
  landmarks: Landmark[];
  labels: { text: string; x: number; y: number; size: number }[];
  streetLabels: { text: string; x: number; y: number; angle: number }[];
  style: CityStyle;
  // The street network: every segment with its width (dead ends included)
  streets: { a: Vec; b: Vec; w: number; kind: "artery" | "street" | "lane" | "quay" }[];
  quays: Vec[][]; // stone waterfronts (harbor and river quays)
  aprons: Poly[]; // paved quaysides between the waterfront and the first street
  moles: Vec[][]; // breakwaters
  cranes: number[]; // x, y, angle triples on the quays
  slips: Poly[]; // shipyard slipways running into the water
  plan: CityPlan; // the settings it was built with (see City.plan)
}

const STYLES: Record<string, CityStyle> = {
  temperate: {
    ground: "#d6c5a1",
    street: "#e4d6b4",
    yard: "#a9ab7c",
    plaza: "#e3d6b6",
    roofs: ["#b5533c", "#a34a35", "#c26446", "#9c4b3a", "#b86a4f", "#a85a40"],
    wealthyRoofs: ["#6b7480", "#5d6773", "#7a6e66"],
    flat: false,
    wall: "#d9cfb6",
    wallDark: "#7a6a55",
    tree: "#557d3c",
    treeDark: "#2f4f25",
    fields: ["#9fae5c", "#c8bb6a", "#88a050", "#b49a62", "#a9b86e", "#7f9a4c"],
    palm: false,
    roofForm: "gable",
    domeColor: null,
    onion: false,
    minarets: false,
    bazaar: false,
  },
  cold: {
    ground: "#cfc9bd",
    street: "#dcd6c8",
    yard: "#8e9a7c",
    plaza: "#dcd7cc",
    roofs: ["#5c4a42", "#6d5a4d", "#4f5660", "#7a6655", "#655048"],
    wealthyRoofs: ["#3f4a55", "#4b5560"],
    flat: false,
    wall: "#cfcabd",
    wallDark: "#5f5a50",
    tree: "#35553d",
    treeDark: "#1f3526",
    fields: ["#8d9a63", "#a7a36f", "#7c8d58", "#9b8b66"],
    palm: false,
    roofForm: "gable",
    domeColor: null,
    onion: false,
    minarets: false,
    bazaar: false,
  },
  desert: {
    ground: "#e2cfa3",
    street: "#ecdcb4",
    yard: "#cdb983",
    plaza: "#ecdcb6",
    roofs: ["#e3d3b0", "#d8c39b", "#efe4cc", "#ccb48a", "#e8d8bc"],
    wealthyRoofs: ["#f3ece0", "#e9dfcd"],
    flat: true,
    wall: "#e0cc9e",
    wallDark: "#8a7350",
    tree: "#6d8a3a",
    treeDark: "#3e5520",
    fields: ["#b9a85e", "#a8a050", "#d0b878", "#9fa258"],
    palm: true,
    roofForm: "flat",
    domeColor: "#e9e1cf",
    onion: false,
    minarets: true,
    bazaar: true,
  },
  tropical: {
    ground: "#cbb98f",
    street: "#dcc79c",
    yard: "#8fa868",
    plaza: "#dccaa0",
    roofs: ["#b05a3a", "#9a6b45", "#c08a55", "#a65e3e"],
    wealthyRoofs: ["#d9cfc0", "#8c7b6b"],
    flat: false,
    wall: "#d6c7a5",
    wallDark: "#6f5f45",
    tree: "#3f7a32",
    treeDark: "#21481c",
    fields: ["#8fb050", "#a6b85c", "#7da046", "#b7a65c"],
    palm: true,
    roofForm: "hip",
    domeColor: null,
    onion: false,
    minarets: false,
    bazaar: false,
  },
};

export const TYPE_NAMES: Partial<Record<WardType, string[]>> = {
  market: ["Old Town", "Market Ward", "Town Square"],
  castle: ["Castle Hill", "The Citadel", "Royal Castle"],
  cathedral: ["Great Mosque Quarter", "Imam's Quarter", "Friday Mosque Ward"],
  wealthy: ["Merchants' Ward", "High Town", "Nobles' Quarter"],
  harbor: ["Docks", "Harbor District", "Wharves"],
  craft: ["Tanners' Row", "Millers' Quarter", "Weavers' Ward", "Smiths' Lane"],
  park: ["Gardens", "Commons", "Royal Park"],
  cemetery: ["Old Maqbara", "Garden of Rest"],
  palace: ["Palace Quarter", "Royal Palace"],
  suburb: ["Gate", "Outskirts", "Fields"],
};

export function dirName(a: number): string {
  const names = ["East", "South-East", "South", "South-West", "West", "North-West", "North", "North-East"];
  return names[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

function climateStyle(world: WorldData, city: City): CityStyle {
  const cell = world.getCell(city.x, city.y);
  if (!cell) return STYLES.temperate;
  const b = cell.biome;
  if (b.includes("Desert") || b === "Scorched" || (cell.temperature > 0.66 && cell.moisture < 0.35))
    return STYLES.desert;
  if (cell.temperature < 0.33 || b === "Taiga" || b === "Tundra" || b === "Snow") return STYLES.cold;
  if (b.includes("Tropical") || b === "Savanna") return STYLES.tropical;
  return STYLES.temperate;
}

// Architecture follows the culture; climate supplies ground, trees and fields.
export function styleFor(world: WorldData, city: City): CityStyle {
  const base = climateStyle(world, city);
  const family = world.languages[cultureNear(world, city.x, city.y, 24) ?? -1]?.family.key;
  const s: CityStyle = { ...base };
  switch (family) {
    case "Desert":
      Object.assign(s, {
        roofs: ["#e6d7b6", "#dccaa2", "#efe6d3", "#d2bb92", "#e9dcc4"],
        wealthyRoofs: ["#f4efe4", "#e8dfcf"],
        roofForm: "flat",
        domeColor: city.population > 30000 ? "#3f7fa6" : "#ede5d3",
        minarets: true,
        bazaar: true,
        onion: false,
      });
      break;
    case "Eastern":
      Object.assign(s, {
        roofs: ["#4d5560", "#5a6470", "#3f6e6a", "#55606b"],
        wealthyRoofs: ["#9c3b2e", "#c49a3c"],
        roofForm: "hip",
        domeColor: null,
        bazaar: true,
        onion: false,
        minarets: false,
      });
      break;
    case "Slavic":
      Object.assign(s, {
        roofs: ["#7d5a44", "#8a6a4c", "#6a5a48", "#5f6b4f", "#94704f"],
        wealthyRoofs: ["#4f7a62", "#5f6773"],
        roofForm: "mixed",
        domeColor: "#d6a83a",
        onion: true,
      });
      break;
    case "Latin":
      Object.assign(s, {
        roofs: ["#c4683f", "#b85c38", "#d07a4a", "#a9573a", "#c97a52"],
        wealthyRoofs: ["#c06a45", "#9d8f80"],
        roofForm: "hip",
        domeColor: "#b8683f",
      });
      break;
    case "Nordic":
      Object.assign(s, {
        roofs: ["#4a3b32", "#5c4a3c", "#3d4448", "#5f6e45", "#6b5442"],
        wealthyRoofs: ["#34404a", "#7a3b2e"],
        roofForm: "gable",
      });
      break;
    case "Celtic":
      Object.assign(s, {
        roofs: ["#a08c5a", "#8f7b4d", "#6b6f74", "#5e646b", "#9a8556"],
        wealthyRoofs: ["#555c66", "#4a5058"],
        roofForm: "gable",
      });
      break;
    default:
      break; // Germanic & others keep the climate palette (red/brown gables)
  }
  if (base === STYLES.desert) {
    s.roofForm = "flat";
    s.minarets = s.minarets || family === "Desert";
  }
  return s;
}

const riverBoxes = new WeakMap<River, [number, number, number, number]>();
export function riverBox(r: River) {
  let b = riverBoxes.get(r);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of r.points) {
      b[0] = Math.min(b[0], p.x);
      b[1] = Math.min(b[1], p.y);
      b[2] = Math.max(b[2], p.x);
      b[3] = Math.max(b[3], p.y);
    }
    riverBoxes.set(r, b);
  }
  return b;
}

// Obstacle segments (arteries, walls) in a coarse spatial hash
export class SegmentHash {
  private cells = new Map<number, { a: Vec; b: Vec; clear: number }[]>();
  private size = 40;
  add(a: Vec, b: Vec, clear: number) {
    const s = this.size;
    const pad = clear + s;
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / s);
    const x1 = Math.floor((Math.max(a.x, b.x) + pad) / s);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / s);
    const y1 = Math.floor((Math.max(a.y, b.y) + pad) / s);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = y * 100003 + x;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push({ a, b, clear });
      }
  }
  // Positive when (x, y) is clear of every obstacle by `extra` meters
  clearance(x: number, y: number): number {
    const k = Math.floor(y / this.size) * 100003 + Math.floor(x / this.size);
    let best = Infinity;
    for (const s of this.cells.get(k) ?? []) best = Math.min(best, distToSegment(x, y, s.a, s.b) - s.clear);
    return best;
  }
}

export function rotRect(cx: number, cy: number, w: number, h: number, a: number): Poly {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts: Poly = [];
  for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
    pts.push({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  }
  return pts;
}

export function bbox(p: Poly): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const v of p) {
    a = Math.min(a, v.x);
    b = Math.min(b, v.y);
    c = Math.max(c, v.x);
    d = Math.max(d, v.y);
  }
  return [a, b, c, d];
}

// Internal state carried from the skeleton to lazy ward detail
export interface Internals {
  obstacles: SegmentHash;
}
export const internals = new WeakMap<CityLayout, Internals>();

export function sampleField(L: CityLayout, arr: Float32Array, x: number, y: number): number {
  const fx = (x - L.origin) / L.res;
  const fy = (y - L.origin) / L.res;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= L.n - 1 || j >= L.n - 1) return 1e3;
  const tx = fx - i;
  const ty = fy - j;
  const n = L.n;
  const a = arr[j * n + i];
  const b = arr[j * n + i + 1];
  const c = arr[(j + 1) * n + i];
  const d = arr[(j + 1) * n + i + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// ------------------------------------------------------------------
// Lazy per-ward detail: blocks, lots, buildings, trees, landmarks
// ------------------------------------------------------------------

export function subdivide(poly: Poly, maxArea: number, gap: number, rand: () => number, out: Poly[], depth = 0) {
  const a = Math.abs(area(poly));
  if (a <= maxArea || depth > 14) {
    if (a > 8) out.push(poly);
    return;
  }
  const e = longestEdge(poly);
  const A = poly[e.i];
  const t = 0.4 + 0.2 * rand();
  const o = { x: A.x + e.dir.x * e.len * t, y: A.y + e.dir.y * e.len * t };
  const dir = { x: -e.dir.y, y: e.dir.x };
  const [p1, p2] = splitConvex(poly, o, dir, gap);
  if (p1.length >= 3) subdivide(p1, maxArea, gap, rand, out, depth + 1);
  if (p2.length >= 3) subdivide(p2, maxArea, gap, rand, out, depth + 1);
}

export function edgeDistance(poly: Poly, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(x, y, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

const LIGHT = { x: -0.7071, y: -0.7071 };

// Maps how much a roof plane faces the light (-1..1) to a shade level 0..3
function shadeLevel(nx: number, ny: number): number {
  const d = nx * LIGHT.x + ny * LIGHT.y;
  return d > 0.45 ? 3 : d > -0.1 ? 2 : d > -0.6 ? 1 : 0;
}

export function makeBuilding(poly: Poly, bucket: number, wealthy: boolean, form: RoofForm): Building {
  if (form === "flat") {
    const inner = insetConvex(poly, 1.0);
    return inner
      ? { faces: [poly, inner], shades: [3, 2], bucket, wealthy }
      : { faces: [poly], shades: [2], bucket, wealthy };
  }
  const e = longestEdge(poly);
  const c = centroid(poly);
  if (form === "hip") {
    // Ridge along the long axis, shortened by the building's half-width
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of poly) {
      const t = (v.x - c.x) * e.dir.x + (v.y - c.y) * e.dir.y;
      mn = Math.min(mn, t);
      mx = Math.max(mx, t);
    }
    const len = mx - mn;
    const width = Math.abs(area(poly)) / Math.max(1, len);
    const h = Math.max(0, len / 2 - width / 2);
    const mid = (mn + mx) / 2;
    const r1 = { x: c.x + e.dir.x * (mid - h), y: c.y + e.dir.y * (mid - h) };
    const r2 = { x: c.x + e.dir.x * (mid + h), y: c.y + e.dir.y * (mid + h) };
    const ridgeOf = (v: Vec) => ((v.x - c.x) * e.dir.x + (v.y - c.y) * e.dir.y < mid ? r1 : r2);
    const faces: Poly[] = [];
    const shades: number[] = [];
    const sgn = area(poly) > 0 ? 1 : -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ra = ridgeOf(a);
      const rb = ridgeOf(b);
      const face = ra === rb ? [a, b, ra] : [a, b, rb, ra];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const el = Math.hypot(ex, ey) || 1;
      faces.push(face);
      shades.push(shadeLevel((-sgn * ey) / el, (sgn * ex) / el));
    }
    return { faces, shades, bucket, wealthy };
  }
  const [a, b] = splitConvex(poly, c, e.dir, 0);
  const nx = -e.dir.y;
  const ny = e.dir.x;
  // splitConvex: `a` is on the -normal side, `b` on the +normal side
  return { faces: [a, b], shades: [shadeLevel(-nx, -ny) >= 2 ? 3 : 1, shadeLevel(nx, ny) >= 2 ? 3 : 1], bucket, wealthy };
}

// Mosque: domed prayer hall, arcaded courtyard (sahn) with a fountain, and
// minarets at the courtyard corners. `size` is the prayer hall width in meters.
export function mosque(D: WardDetail, cx: number, cy: number, size: number, ang: number, grand: boolean) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const at = (u: number, v: number) => ({ x: cx + u * c - v * s, y: cy + u * s + v * c });
  const hallDepth = size * 0.62;
  const hall = at(0, -hallDepth / 2);
  const court = at(0, size * 0.45);
  D.landmarks.push({
    kind: "temple",
    polys: [rotRect(hall.x, hall.y, size, hallDepth, ang)],
    accents: grand ? [] : [],
    circles: [],
    stone: true,
  });
  if (grand) {
    // Courtyard ring of arcades around an open, paved sahn
    const courtW = size;
    const courtD = size * 0.9;
    D.plazas.push(rotRect(court.x, court.y, courtW, courtD, ang));
    const arc = 6;
    for (const [u, v, w, h] of [
      [0, size * 0.45 - courtD / 2 + arc / 2, courtW, arc],
      [0, size * 0.45 + courtD / 2 - arc / 2, courtW, arc],
      [-courtW / 2 + arc / 2, size * 0.45, arc, courtD],
      [courtW / 2 - arc / 2, size * 0.45, arc, courtD],
    ]) {
      const p = at(u, v);
      D.landmarks.push({ kind: "temple", polys: [rotRect(p.x, p.y, w, h, ang)], accents: [], circles: [], stone: true });
    }
    D.landmarks.push({ kind: "fountain", polys: [], accents: [], circles: [court.x, court.y, 3.5], stone: true });
  }
  // Main dome, a row of smaller domes along the qibla wall
  D.domes.push(hall.x, hall.y, size * (grand ? 0.27 : 0.33));
  if (grand) {
    for (const u of [-0.36, 0.36]) {
      const p = at(size * u, -hallDepth / 2);
      D.domes.push(p.x, p.y, size * 0.12);
    }
    for (const u of [-0.36, -0.12, 0.12, 0.36]) {
      const p = at(size * u, -hallDepth * 0.1);
      D.domes.push(p.x, p.y, size * 0.07);
    }
  }
  const mins = grand
    ? [at(-size / 2, size * 0.45 + size * 0.45), at(size / 2, size * 0.45 + size * 0.45), at(-size / 2, -hallDepth), at(size / 2, -hallDepth)]
    : [at(size / 2 + 2, 0)];
  for (const m of mins) D.minarets.push(m.x, m.y, grand ? 3.2 : 2.2);
}
