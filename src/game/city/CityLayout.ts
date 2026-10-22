import { CELL_METERS } from "../../core/FieldNoise";
import type { City, River, WorldData } from "../WorldData";
import { sampleCurve } from "../util/curves";
import {
  type Poly,
  type Vec,
  area,
  centroid,
  circlePoly,
  contours,
  distToSegment,
  insetConvex,
  longestEdge,
  pointInPoly,
  rng,
  splitConvex,
  voronoi,
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
}

const STYLES: Record<string, CityStyle> = {
  temperate: {
    ground: "#d6c5a1",
    street: "#cdb990",
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
    street: "#c2bcae",
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
    street: "#d6c08f",
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
    street: "#c2ac7f",
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

const TYPE_NAMES: Partial<Record<WardType, string[]>> = {
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

function dirName(a: number): string {
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
function styleFor(world: WorldData, city: City): CityStyle {
  const base = climateStyle(world, city);
  const cell = world.getCell(city.x, city.y);
  const family = world.languages[cell?.cultureIndex ?? -1]?.family.key;
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
function riverBox(r: River) {
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
class SegmentHash {
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

function rotRect(cx: number, cy: number, w: number, h: number, a: number): Poly {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts: Poly = [];
  for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
    pts.push({ x: cx + x * c - y * s, y: cy + x * s + y * c });
  }
  return pts;
}

function bbox(p: Poly): [number, number, number, number] {
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
interface Internals {
  obstacles: SegmentHash;
}
const internals = new WeakMap<CityLayout, Internals>();

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

// Builds the city skeleton. Yields periodically so it can be time-sliced.
export function* buildCityLayout(world: WorldData, city: City): Generator<void, CityLayout> {
  const rand = rng(city.seed || 1);
  const R = city.radiusM;
  const Ru = R * (city.size === 0 ? 1.25 : 1.35);
  const Rf = Ru + Math.min(2500, Math.max(450, 300 + R * 0.8));
  const ext = Rf + 80;
  const res = Math.max(5, Math.min(25, Rf / 180));
  const n = Math.ceil((2 * ext) / res) + 1;
  const origin = -ext;
  const W = world.width;
  const toCell = (m: number) => m / CELL_METERS;
  const sampler = world.sampler;
  const style = styleFor(world, city);

  // --- Terrain raster ---
  const octaves = Math.min(11, Math.max(4, Math.ceil(Math.log2((CELL_METERS * 2) / res)) + 1));
  const coastF = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const wy = city.y + toCell(origin + j * res);
    for (let i = 0; i < n; i++) {
      const wx = city.x + toCell(origin + i * res);
      coastF[j * n + i] = sampler.coastField(wx, wy, octaves) * CELL_METERS;
    }
    if (j % 24 === 23) yield;
  }

  const riverF = new Float32Array(n * n).fill(1e6);
  const riverSamples: number[] = [];
  const extC = toCell(ext + 1000);
  for (const r of world.rivers) {
    const b = riverBox(r);
    const shift = Math.round((city.x - (b[0] + b[2]) / 2) / W) * W;
    if (city.x < b[0] + shift - extC || city.x > b[2] + shift + extC) continue;
    if (city.y < b[1] - extC || city.y > b[3] + extC) continue;
    sampleCurve(r.points, r.widths, toCell(res / 2), (x, y, w) => {
      const mx = (x + shift - city.x) * CELL_METERS;
      const my = (y - city.y) * CELL_METERS;
      const hw = w / 2;
      if (Math.abs(mx) > ext + hw || Math.abs(my) > ext + hw) return;
      riverSamples.push(mx, my, w);
      const rr = hw + 2 * res;
      const i0 = Math.max(0, Math.floor((mx - rr - origin) / res));
      const i1 = Math.min(n - 1, Math.ceil((mx + rr - origin) / res));
      const j0 = Math.max(0, Math.floor((my - rr - origin) / res));
      const j1 = Math.min(n - 1, Math.ceil((my + rr - origin) / res));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(origin + i * res - mx, origin + j * res - my) - hw;
          const k = j * n + i;
          if (d < riverF[k]) riverF[k] = d;
        }
    });
  }
  const field = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) field[k] = Math.min(coastF[k], riverF[k]);
  for (let i = 0; i < n; i++) {
    field[i] = Math.max(field[i], 1);
    field[(n - 1) * n + i] = Math.max(field[(n - 1) * n + i], 1);
    field[i * n] = Math.max(field[i * n], 1);
    field[i * n + n - 1] = Math.max(field[i * n + n - 1], 1);
  }
  const waterLoops = contours(field, n, res, origin);
  yield;

  const L: CityLayout = {
    city, R, Ru, Rf, res, n, origin, field, coastF, riverF, waterLoops,
    wards: [], arteries: [], wall: null, bridges: [], piers: [], boats: [],
    fields: [], farmTrees: [], farmBuildings: [], landmarks: [], labels: [], streetLabels: [], style,
  };
  const land = (x: number, y: number) => sampleField(L, field, x, y);
  const coastAt = (x: number, y: number) => sampleField(L, coastF, x, y);
  const riverAt = (x: number, y: number) => sampleField(L, riverF, x, y);

  // --- Arteries: world roads through the city, plus extra radial roads ---
  const roadWidth = [7, 10, 14];
  for (const road of world.worldRoads) {
    const b0 = road.points[0];
    const shift = Math.round((city.x - b0.x) / W) * W;
    let run: Vec[] = [];
    let touchesCore = false;
    const flush = () => {
      if (run.length > 1 && touchesCore) L.arteries.push({ pts: run, width: roadWidth[road.tier] ?? 8 });
      run = [];
      touchesCore = false;
    };
    const reach = toCell(Rf + 2000);
    const near = road.points.some(
      (p) => Math.abs(p.x + shift - city.x) < reach && Math.abs(p.y - city.y) < reach,
    );
    if (!near) continue;
    const xs: number[] = [];
    sampleCurve(road.points, road.points.map(() => 0), toCell(res), (x, y) => {
      xs.push(x, y);
    });
    for (let k = 0; k < xs.length; k += 2) {
      const mx = (xs[k] + shift - city.x) * CELL_METERS;
      const my = (xs[k + 1] - city.y) * CELL_METERS;
      const r = Math.hypot(mx, my);
      if (r <= Rf) {
        run.push({ x: mx, y: my });
        if (r < Ru) touchesCore = true;
      } else flush();
    }
    flush();
  }

  const minArteries = city.isCapital ? 6 : city.size >= 2 ? 5 : city.size === 1 ? 3 : 2;
  const angleOf = (pts: Vec[]) => {
    const far = pts.reduce((b, p) => (Math.hypot(p.x, p.y) > Math.hypot(b.x, b.y) ? p : b), pts[0]);
    return Math.atan2(far.y, far.x);
  };
  let guard = 0;
  while (L.arteries.length < minArteries && guard++ < 12) {
    const angles = L.arteries.map((a) => angleOf(a.pts)).sort((a, b) => a - b);
    let heading: number;
    if (angles.length === 0) heading = rand() * Math.PI * 2;
    else {
      let bestGap = -1;
      heading = 0;
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i];
        const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
        if (b - a > bestGap) {
          bestGap = b - a;
          heading = (a + b) / 2;
        }
      }
      if (bestGap < 0.5) break;
    }
    const pts: Vec[] = [{ x: 0, y: 0 }];
    let p = { x: 0, y: 0 };
    let h = heading;
    while (Math.hypot(p.x, p.y) < Rf) {
      let moved = false;
      for (const delta of [0, 0.2, -0.2, 0.4, -0.4, 0.7, -0.7, 1.1, -1.1]) {
        const q = { x: p.x + Math.cos(h + delta) * 25, y: p.y + Math.sin(h + delta) * 25 };
        if (coastAt(q.x, q.y) > 8) {
          h += delta * 0.5 + (rand() - 0.5) * 0.12;
          p = q;
          moved = true;
          break;
        }
      }
      if (!moved) break;
      pts.push(p);
    }
    if (pts.length < 6) {
      // Couldn't leave the center (e.g. a narrow peninsula); stop trying
      if (L.arteries.length > 0) break;
    }
    L.arteries.push({ pts, width: city.size >= 1 ? 9 : 6 });
  }
  yield;

  for (const a of L.arteries) {
    const amp = 18 + rand() * 22;
    const wave = 160 + rand() * 120;
    const phase = rand() * 6.28;
    let s = 0;
    const out: Vec[] = [];
    for (let i = 0; i < a.pts.length; i++) {
      const p = a.pts[i];
      if (i > 0) s += Math.hypot(p.x - a.pts[i - 1].x, p.y - a.pts[i - 1].y);
      const q = a.pts[Math.min(a.pts.length - 1, i + 1)];
      const o = a.pts[Math.max(0, i - 1)];
      const dx = q.x - o.x;
      const dy = q.y - o.y;
      const dl = Math.hypot(dx, dy) || 1;
      const r = Math.hypot(p.x, p.y);
      const taper = Math.sin(Math.PI * Math.min(1, r / Ru));
      const off = amp * taper * Math.sin(s / wave + phase);
      const np = { x: p.x - (dy / dl) * off, y: p.y + (dx / dl) * off };
      out.push(land(np.x, np.y) > 3 || land(p.x, p.y) <= 3 ? np : p);
    }
    a.pts = out;
  }

  // Street names for the main roads
  const streetNames = ["High Street", "Sultan's Road", "Market Street", "Bridge Street", "Castle Way", "Mill Lane",
    "Harbor Road", "Gate Street", "Mosque Street", "Old Road", "Caravan Way", "Smith Street", "Wool Street"];
  L.arteries.forEach((a, i) => {
    if (a.pts.length < 6) return;
    const k = Math.min(a.pts.length - 2, Math.max(1, Math.floor(a.pts.length * 0.18)));
    const p = a.pts[k];
    const q = a.pts[k + 1];
    let ang = Math.atan2(q.y - p.y, q.x - p.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    L.streetLabels.push({ text: streetNames[(i + Math.floor(rand() * 5)) % streetNames.length], x: p.x, y: p.y, angle: ang });
  });

  const obstacles = new SegmentHash();
  for (const a of L.arteries)
    for (let i = 0; i < a.pts.length - 1; i++) obstacles.add(a.pts[i], a.pts[i + 1], a.width / 2 + 1.5);

  // Bridges where arteries cross rivers
  for (const a of L.arteries) {
    let start = -1;
    for (let i = 0; i < a.pts.length; i++) {
      const wet = riverAt(a.pts[i].x, a.pts[i].y) < 0 && coastAt(a.pts[i].x, a.pts[i].y) > 0;
      if (wet && start < 0) start = Math.max(0, i - 1);
      if (!wet && start >= 0) {
        L.bridges.push({ a: a.pts[start], b: a.pts[i], width: a.width + 3 });
        start = -1;
      }
    }
  }

  // --- Walls ---
  const walled = city.isCapital || city.population >= 6000;
  if (walled) {
    const Rw = R * 0.9;
    const count = Math.max(10, Math.min(48, Math.round((2 * Math.PI * Rw) / 85)));
    const phase = rand() * 10;
    const wallPoly: Poly = [];
    const onShore: boolean[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const r = Rw * (0.9 + 0.12 * Math.sin(a * 3 + phase) + 0.06 * (rand() - 0.5));
      let rr = r;
      let shore = false;
      while (rr > R * 0.2 && coastAt(Math.cos(a) * rr, Math.sin(a) * rr) < 6) {
        rr -= res;
        shore = true;
      }
      wallPoly.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
      onShore.push(shore);
    }
    const towers: Vec[] = [];
    const segments: [Vec, Vec][] = [];
    for (let i = 0; i < count; i++) {
      const a = wallPoly[i];
      const b = wallPoly[(i + 1) % count];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Leave the waterfront open where the wall would run along the sea
      if (coastAt(mid.x, mid.y) < 4 || (onShore[i] && onShore[(i + 1) % count])) continue;
      segments.push([a, b]);
      obstacles.add(a, b, 6);
      if (!onShore[i]) towers.push(a);
    }
    const gates: Vec[] = [];
    for (const art of L.arteries) {
      for (let i = 0; i < art.pts.length - 1; i++) {
        const p = art.pts[i];
        const q = art.pts[i + 1];
        if (pointInPoly(wallPoly, p.x, p.y) !== pointInPoly(wallPoly, q.x, q.y)) {
          gates.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
          break;
        }
      }
    }
    L.wall = { poly: wallPoly, towers, gates, segments };
  }
  yield;

  // --- Wards ---
  const spacing = (city.size >= 2 ? 200 : city.size === 1 ? 150 : 110) * (city.isCapital ? 1.05 : 1);
  const nW = Math.max(4, Math.min(300, Math.round((Math.PI * Ru * Ru) / (spacing * spacing))));
  const sites: Vec[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < nW; i++) {
    const r = Ru * Math.sqrt((i + 0.5) / nW);
    const a = i * golden + rand() * 0.4;
    const p = {
      x: Math.cos(a) * r + (rand() - 0.5) * spacing * 0.45,
      y: Math.sin(a) * r + (rand() - 0.5) * spacing * 0.45,
    };
    if (land(p.x, p.y) > 0) sites.push(p);
  }
  const cells = voronoi(sites, circlePoly(Ru * 1.02, 48));
  yield;

  const nearestArtery = (x: number, y: number) => {
    let best = Infinity;
    for (const a of L.arteries)
      for (let i = 0; i < a.pts.length - 1; i += 1) best = Math.min(best, distToSegment(x, y, a.pts[i], a.pts[i + 1]));
    return best;
  };

  for (const poly of cells) {
    if (poly.length < 3) continue;
    const c = centroid(poly);
    if (land(c.x, c.y) < 0) continue;
    let coastal = false;
    let riverside = false;
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i];
      const w = poly[(i + 1) % poly.length];
      const m = { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 };
      for (const q of [v, m]) {
        if (coastAt(q.x, q.y) < 0) coastal = true;
        if (riverAt(q.x, q.y) < 12) riverside = true;
      }
    }
    const d = Math.hypot(c.x, c.y);
    const inside = L.wall ? pointInPoly(L.wall.poly, c.x, c.y) : d < R * 0.85;
    L.wards.push({
      poly,
      type: "residential",
      c,
      d,
      inside,
      coastal,
      riverside,
      bbox: bbox(poly),
      seed: (rand() * 4294967296) >>> 0,
    });
  }

  // Outer wards survive only as ribbon development along roads
  L.wards = L.wards.filter((w) => {
    if (w.inside) return true;
    const near = nearestArtery(w.c.x, w.c.y);
    if (near < 90 || (w.coastal && city.isPort && w.d < Ru * 0.9)) {
      w.type = "suburb";
      return true;
    }
    if (w.d < R * 0.75) return true;
    return rand() < 0.15;
  });
  for (const w of L.wards) if (!w.inside && w.type === "residential") w.type = "suburb";

  const byDist = L.wards.filter((w) => w.inside).sort((a, b) => a.d - b.d);
  const take = (pred: (w: Ward) => boolean, type: WardType, score: (w: Ward) => number = () => rand()) => {
    const cands = L.wards.filter((w) => (w.type === "residential" || w.type === "suburb") && pred(w));
    if (cands.length === 0) return null;
    cands.sort((a, b) => score(b) - score(a));
    cands[0].type = type;
    return cands[0];
  };

  if (city.size === 0 && city.population < 3000) {
    if (byDist[0]) byDist[0].type = "green";
    else if (L.wards[0]) L.wards[0].type = "green";
  } else {
    if (byDist[0]) byDist[0].type = "market";
    let castle: Ward | null = null;
    if (city.isCapital || city.population > 40000 || (city.population > 8000 && rand() < 0.55)) {
      castle = take(
        (w) => w.d > R * 0.3 && w.d < R * 1.0,
        "castle",
        (w) => sampler.elevation(city.x + toCell(w.c.x), city.y + toCell(w.c.y)) * 4 + (w.coastal ? 0.4 : 0) + rand() * 0.3,
      );
    }
    if (city.population > 12000) take((w) => w.inside && w.d < R * 0.45, "cathedral", (w) => -w.d + rand() * 60);
    if (city.isCapital && castle) {
      take((w) => w.inside && Math.hypot(w.c.x - castle!.c.x, w.c.y - castle!.c.y) < spacing * 2.5, "palace");
    }
    if (city.isPort) for (const w of L.wards) if (w.coastal && (w.type === "residential" || w.type === "suburb")) w.type = "harbor";
    const parks = city.population > 60000 ? 3 : city.population > 20000 ? 2 : city.population > 8000 ? 1 : 0;
    for (let i = 0; i < parks; i++) take((w) => w.d > R * 0.3 && w.d < Ru * 0.95, "park");
    if (city.population > 8000) take((w) => w.d > R * 0.6, "cemetery", (w) => w.d + rand() * 80);
    for (const w of L.wards) {
      if (w.type !== "residential") continue;
      if (w.riverside && rand() < 0.7) w.type = "craft";
      else {
        const nearElite = L.wards.some(
          (o) => (o.type === "castle" || o.type === "cathedral" || o.type === "palace" || o.type === "market") &&
            Math.hypot(o.c.x - w.c.x, o.c.y - w.c.y) < spacing * 1.7,
        );
        if (nearElite && rand() < 0.55) w.type = "wealthy";
      }
    }
  }
  yield;

  // --- Harbor piers & boats ---
  if (city.isPort) {
    for (const loop of waterLoops) {
      let acc = 0;
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i];
        const q = loop[(i + 1) % loop.length];
        acc += Math.hypot(q.x - p.x, q.y - p.y);
        const d = Math.hypot(p.x, p.y);
        if (d > Ru * 0.95 || acc < 70 + rand() * 60) continue;
        acc = 0;
        // Direction toward open water from the coast gradient
        const gx = coastAt(p.x + res, p.y) - coastAt(p.x - res, p.y);
        const gy = coastAt(p.x, p.y + res) - coastAt(p.x, p.y - res);
        const gl = Math.hypot(gx, gy);
        if (gl < 1e-6) continue;
        const dx = -gx / gl;
        const dy = -gy / gl;
        if (coastAt(p.x + dx * 12, p.y + dy * 12) > -2) continue; // river bank, not sea
        let len = 40 + rand() * 80;
        for (let s = 10; s < len; s += 6) {
          if (coastAt(p.x + dx * s, p.y + dy * s) > -3) {
            len = s - 6;
            break;
          }
        }
        if (len < 25) continue;
        const wdt = 6 + rand() * 5;
        const a = Math.atan2(dy, dx);
        const cx = p.x + dx * (len / 2 - 3);
        const cy = p.y + dy * (len / 2 - 3);
        L.piers.push(rotRect(cx, cy, len + 6, wdt, a));
        const boatsN = Math.floor(rand() * 3);
        for (let b = 0; b < boatsN; b++) {
          const along = 10 + rand() * (len - 15);
          const side = (rand() < 0.5 ? -1 : 1) * (wdt / 2 + 5 + rand() * 4);
          L.boats.push({
            x: p.x + dx * along - dy * side,
            y: p.y + dy * along + dx * side,
            a: a + (rand() - 0.5) * 0.15,
            len: 12 + rand() * 18,
            sail: rand() < 0.4,
          });
        }
        if (L.piers.length > 60) break;
      }
    }
    // A few ships riding at anchor
    for (let i = 0; i < 6; i++) {
      const a = rand() * Math.PI * 2;
      const r = Ru * (0.6 + rand() * 0.8);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (coastAt(x, y) < -60) L.boats.push({ x, y, a: rand() * Math.PI * 2, len: 25 + rand() * 20, sail: true });
    }
    // Lighthouse on the most seaward urban shore point
    let best: Vec | null = null;
    let bestScore = -Infinity;
    for (const loop of waterLoops)
      for (const p of loop) {
        const d = Math.hypot(p.x, p.y);
        if (d > Ru * 1.1 || coastAt(p.x, p.y) > 2) continue;
        const sea = -coastAt(p.x * 1.15, p.y * 1.15);
        if (sea + d * 0.2 > bestScore) {
          bestScore = sea + d * 0.2;
          best = p;
        }
      }
    if (best && city.size >= 1) {
      const len = Math.hypot(best.x, best.y) || 1;
      const p = { x: best.x - (best.x / len) * 8, y: best.y - (best.y / len) * 8 };
      L.landmarks.push({ kind: "lighthouse", polys: [], accents: [], circles: [p.x, p.y, 7, p.x, p.y, 3.5], stone: true });
    }
  }
  yield;

  // --- Farmland ring ---
  // Large parcels (between lanes/hedges) are split into rectangular fields and
  // strips; some parcels stay meadow with copses, like a real countryside.
  const parcelSpacing = city.size === 0 ? 300 : 420;
  const urbanPolys = L.wards.map((w) => w.poly);
  const parcelSites: Vec[] = [];
  const nP = Math.min(500, Math.round((Math.PI * Rf * Rf) / (parcelSpacing * parcelSpacing)));
  for (let i = 0; i < nP; i++) {
    const r = Rf * Math.sqrt((i + 0.5) / nP);
    if (r < R * 0.6) continue;
    const a = i * golden;
    parcelSites.push({
      x: Math.cos(a) * r + (rand() - 0.5) * parcelSpacing * 0.6,
      y: Math.sin(a) * r + (rand() - 0.5) * parcelSpacing * 0.6,
    });
  }
  const parcels = voronoi(parcelSites, circlePoly(Rf, 56));
  yield;
  const cultivable = (() => {
    const cell = world.getCell(city.x, city.y);
    return !cell || !(cell.biome === "Snow" || cell.biome === "Scorched" || cell.biome === "Bare");
  })();
  const okFieldPoint = (v: Vec) => land(v.x, v.y) > 4 && obstacles.clearance(v.x, v.y) > 2;
  let windmills = city.size >= 1 ? 2 + Math.floor(rand() * 3) : rand() < 0.5 ? 1 : 0;
  for (let pi = 0; pi < parcels.length && cultivable; pi++) {
    const poly = parcels[pi];
    if (poly.length < 3) continue;
    const c = centroid(poly);
    if (urbanPolys.some((u) => pointInPoly(u, c.x, c.y))) continue;
    const d = Math.hypot(c.x, c.y);
    const alpha = 1 - Math.max(0, Math.min(1, (d - Rf * 0.7) / (Rf * 0.3)));
    const inset = insetConvex(poly, 4);
    if (!inset) continue;
    // Pasture closer to the edge of the farmland, crops near town
    if (rand() < 0.15 + 0.35 * (d / Rf)) {
      if (rand() < 0.5) {
        const n = 6 + Math.floor(rand() * 14);
        for (let t = 0; t < n; t++) {
          const x = c.x + (rand() - 0.5) * 60;
          const y = c.y + (rand() - 0.5) * 60;
          if (land(x, y) > 4 && obstacles.clearance(x, y) > 3) L.farmTrees.push(x, y, 3 + rand() * 3);
        }
      }
      continue;
    }
    const blocks: Poly[] = [];
    subdivide(inset, 9000 + rand() * 22000, 3, rand, blocks);
    const parts: Poly[] = [];
    for (const blk of blocks) {
      // Some fields are worked as long narrow strips
      if (rand() < 0.35) subdivide(blk, Math.abs(area(blk)) / (2 + Math.floor(rand() * 3)), 1.5, rand, parts);
      else parts.push(blk);
    }
    for (const part of parts) {
      if (Math.abs(area(part)) < 500) continue;
      if (!part.every(okFieldPoint) || !okFieldPoint(centroid(part))) continue;
      const color = Math.floor(rand() * style.fields.length);
      L.fields.push({ poly: part, color, alpha });
      const roll = rand();
      if (roll < 0.06) {
        // Orchard rows
        const bb = bbox(part);
        for (let y = bb[1] + 4; y < bb[3]; y += 9)
          for (let x = bb[0] + 4; x < bb[2]; x += 9)
            if (pointInPoly(part, x, y)) L.farmTrees.push(x, y, 3 + rand());
      } else if (roll < 0.3) {
        // Hedgerow trees along one edge
        const e = longestEdge(part);
        const p0 = part[e.i];
        for (let t = 4; t < e.len; t += 9 + rand() * 8)
          L.farmTrees.push(p0.x + e.dir.x * t, p0.y + e.dir.y * t, 3 + rand() * 2.5);
      } else if (roll < 0.34 && alpha > 0.3) {
        // Farmstead in the corner nearest a road
        const corner = part.reduce((b2, v) => (obstacles.clearance(v.x, v.y) < obstacles.clearance(b2.x, b2.y) ? v : b2));
        const cc = centroid(part);
        const dx = cc.x - corner.x;
        const dy = cc.y - corner.y;
        const dl = Math.hypot(dx, dy) || 1;
        const hx = corner.x + (dx / dl) * 18;
        const hy = corner.y + (dy / dl) * 18;
        const ang = Math.atan2(dy, dx);
        L.farmBuildings.push(rotRect(hx, hy, 16, 9, ang));
        L.farmBuildings.push(rotRect(hx + Math.cos(ang + 1.57) * 13, hy + Math.sin(ang + 1.57) * 13, 10, 7, ang));
      } else if (roll < 0.37 && windmills > 0 && d > Ru * 1.1) {
        windmills--;
        const cc = centroid(part);
        L.landmarks.push({ kind: "windmill", polys: [], accents: [], circles: [cc.x, cc.y, 5], stone: false });
      }
    }
    if (pi % 20 === 19) yield;
  }
  yield;

  // --- District labels ---
  const groups = new Map<string, Ward[]>();
  for (const w of L.wards) {
    if (w.type === "residential") continue;
    const sector = ["harbor", "suburb", "craft", "wealthy"].includes(w.type)
      ? dirName(Math.atan2(w.c.y, w.c.x))
      : "";
    const key = `${w.type}|${sector}`;
    const g = groups.get(key) ?? [];
    g.push(w);
    groups.set(key, g);
  }
  for (const [key, ws] of groups) {
    const [type, sector] = key.split("|") as [WardType, string];
    const names = TYPE_NAMES[type];
    if (!names) continue;
    let text = names[Math.floor(rand() * names.length)];
    if (type === "suburb") text = `${sector} ${text}`;
    else if (sector && ws.length < L.wards.length * 0.5) text = `${sector.split("-").pop()} ${text}`;
    if (type === "park" && ws.length === 1) text = `${city.name} ${text}`;
    const x = ws.reduce((s, w) => s + w.c.x, 0) / ws.length;
    const y = ws.reduce((s, w) => s + w.c.y, 0) / ws.length;
    L.labels.push({ text, x, y, size: Math.sqrt(ws.length) });
  }
  if (L.wards.length > 0 && city.size >= 1) {
    const core = L.wards.filter((w) => w.type === "residential" && w.inside);
    if (core.length > 2) {
      const x = core.reduce((s, w) => s + w.c.x, 0) / core.length;
      const y = core.reduce((s, w) => s + w.c.y, 0) / core.length;
      L.labels.push({ text: "Old Quarter", x, y, size: 1.5 });
    }
  }

  internals.set(L, { obstacles });
  return L;
}

// ------------------------------------------------------------------
// Lazy per-ward detail: blocks, lots, buildings, trees, landmarks
// ------------------------------------------------------------------

interface WardParams {
  block: number; // max block area m²
  alley: number;
  lot: number; // target lot area m²
  margin: number;
  empty: number; // chance a lot stays empty
  depth: number; // frontage depth; deeper lots become gardens
  ribbon: number; // only lots within this distance of an artery (0 = off)
  ring: number; // only lots within this distance of the ward edge (0 = off)
}

const PARAMS: Record<WardType, WardParams> = {
  residential: { block: 7000, alley: 4, lot: 140, margin: 0.5, empty: 0.05, depth: 18, ribbon: 0, ring: 0 },
  wealthy: { block: 11000, alley: 5, lot: 420, margin: 2.5, empty: 0.08, depth: 26, ribbon: 0, ring: 0 },
  market: { block: 1e9, alley: 4, lot: 160, margin: 0.4, empty: 0.02, depth: 18, ribbon: 0, ring: 22 },
  cathedral: { block: 1e9, alley: 4, lot: 180, margin: 0.5, empty: 0.05, depth: 18, ribbon: 0, ring: 20 },
  harbor: { block: 9000, alley: 6, lot: 380, margin: 1, empty: 0.12, depth: 28, ribbon: 0, ring: 0 },
  craft: { block: 8000, alley: 4, lot: 230, margin: 0.8, empty: 0.1, depth: 22, ribbon: 0, ring: 0 },
  suburb: { block: 9000, alley: 5, lot: 260, margin: 1.5, empty: 0.3, depth: 22, ribbon: 65, ring: 0 },
  green: { block: 1e9, alley: 4, lot: 260, margin: 1.5, empty: 0.15, depth: 24, ribbon: 0, ring: 26 },
  castle: { block: 1e9, alley: 3, lot: 200, margin: 0.6, empty: 0.1, depth: 14, ribbon: 0, ring: 14 },
  palace: { block: 1e9, alley: 4, lot: 300, margin: 1, empty: 0.3, depth: 18, ribbon: 0, ring: 0 },
  park: { block: 1e9, alley: 4, lot: 300, margin: 1, empty: 1, depth: 0, ribbon: 0, ring: 0 },
  cemetery: { block: 1e9, alley: 4, lot: 300, margin: 1, empty: 1, depth: 0, ribbon: 0, ring: 0 },
};

function subdivide(poly: Poly, maxArea: number, gap: number, rand: () => number, out: Poly[], depth = 0) {
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

function edgeDistance(poly: Poly, x: number, y: number): number {
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

function makeBuilding(poly: Poly, bucket: number, wealthy: boolean, form: RoofForm): Building {
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
function mosque(D: WardDetail, cx: number, cy: number, size: number, ang: number, grand: boolean) {
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

export function buildWardDetail(L: CityLayout, ward: Ward): WardDetail {
  const rand = rng(ward.seed);
  const P = PARAMS[ward.type];
  const st = L.style;
  const inner = internals.get(L)!;
  const D: WardDetail = {
    blocks: [], buildings: [], trees: [], plazas: [], paths: [], stalls: [], graves: [], ponds: [], hedges: [], landmarks: [],
    domes: [], minarets: [],
  };
  const formFor = (): RoofForm =>
    st.roofForm === "mixed" ? (rand() < 0.45 ? "hip" : "gable") : st.roofForm;
  const land = (x: number, y: number) => sampleField(L, L.field, x, y);
  const lotOk = (p: Poly, clear: number) => {
    for (const v of p) if (land(v.x, v.y) < 1.5 || inner.obstacles.clearance(v.x, v.y) < clear) return false;
    const c = centroid(p);
    return land(c.x, c.y) > 1.5 && inner.obstacles.clearance(c.x, c.y) > clear;
  };
  const nearArtery = (x: number, y: number) => inner.obstacles.clearance(x, y);
  const roofCount = st.roofs.length;

  const base = insetConvex(ward.poly, 3);
  if (!base) return D;
  const wc = centroid(base);

  // --- Open spaces ---
  if (ward.type === "park") {
    D.plazas.push(base);
    const b = bbox(base);
    for (let y = b[1]; y < b[3]; y += 11)
      for (let x = b[0]; x < b[2]; x += 11) {
        const px = x + (rand() - 0.5) * 8;
        const py = y + (rand() - 0.5) * 8;
        if (rand() < 0.55 && pointInPoly(base, px, py) && land(px, py) > 3) D.trees.push(px, py, 3 + rand() * 3.5);
      }
    for (let k = 0; k < 2; k++) {
      const a = rand() * Math.PI;
      const r = 400;
      D.paths.push([
        { x: wc.x - Math.cos(a) * r, y: wc.y - Math.sin(a) * r },
        { x: wc.x + Math.cos(a) * r, y: wc.y + Math.sin(a) * r },
      ]);
    }
    if (Math.abs(area(base)) > 25000) {
      const r = Math.sqrt(Math.abs(area(base))) * 0.12;
      const pond = circlePoly(r, 20).map((v) => ({ x: wc.x + v.x * 1.4 + r * 0.6, y: wc.y + v.y }));
      D.ponds.push(pond);
    }
    return D;
  }
  if (ward.type === "cemetery") {
    D.plazas.push(base);
    const yard = insetConvex(base, 2);
    if (yard) D.hedges.push(yard);
    const b = bbox(base);
    for (let y = b[1] + 4; y < b[3]; y += 3.2)
      for (let x = b[0] + 4; x < b[2]; x += 2.4)
        if (rand() < 0.7 && pointInPoly(base, x, y) && edgeDistance(base, x, y) > 4) D.graves.push(rotRect(x, y, 1, 2, 0));
    for (let i = 0; i < 12; i++) {
      const x = b[0] + rand() * (b[2] - b[0]);
      const y = b[1] + rand() * (b[3] - b[1]);
      if (pointInPoly(base, x, y)) D.trees.push(x, y, 3 + rand() * 2);
    }
    mosque(D, wc.x, wc.y, 14, 0, false);
    return D;
  }

  // --- Landmarks claiming the center of their ward ---
  let core: Poly | null = null;
  if (ward.type === "castle") {
    const curtain = insetConvex(ward.poly, 8);
    if (curtain) {
      D.plazas.push(curtain);
      const e = longestEdge(curtain);
      const ang = Math.atan2(e.dir.y, e.dir.x);
      const keep = rotRect(wc.x, wc.y, 36, 28, ang);
      const circles: number[] = [];
      for (const v of curtain) circles.push(v.x, v.y, 7);
      const kc = keep.map((v) => [v.x, v.y, 5]).flat();
      D.landmarks.push({ kind: "castle", polys: [curtain], accents: [], circles, stone: true });
      D.landmarks.push({ kind: "keep", polys: [keep], accents: [], circles: kc, stone: true });
      core = insetConvex(curtain, 16);
    }
  } else if (ward.type === "market" || ward.type === "cathedral" || ward.type === "green") {
    D.plazas.push(base);
    if (ward.type === "market") {
      D.landmarks.push({ kind: "fountain", polys: [], accents: [], circles: [wc.x, wc.y, 4], stone: true });
      const e = longestEdge(base);
      const ang = Math.atan2(e.dir.y, e.dir.x);
      const th = rotRect(wc.x + Math.cos(ang + 1.57) * 30, wc.y + Math.sin(ang + 1.57) * 30, 30, 18, ang);
      D.landmarks.push({ kind: "townhall", polys: [th], accents: [], circles: [], stone: true });
      const b = bbox(base);
      if (st.bazaar) {
        // Covered bazaar: a dense grid of stall roofs with narrow lanes and a few domes
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const ext = Math.max(b[2] - b[0], b[3] - b[1]);
        for (let u = -ext; u < ext; u += 8)
          for (let v = -ext; v < ext; v += 8) {
            if ((Math.round(u / 8) % 6 === 0) || (Math.round(v / 8) % 5 === 0)) continue; // lanes
            const x = wc.x + u * c - v * s;
            const y = wc.y + u * s + v * c;
            if (!pointInPoly(base, x, y) || edgeDistance(base, x, y) < 26 || pointInPoly(th, x, y)) continue;
            D.stalls.push(rotRect(x, y, 6.2, 6.2, ang));
            if (rand() < 0.04) D.domes.push(x, y, 3.4);
          }
      } else {
        for (let i = 0; i < 70; i++) {
          const x = b[0] + rand() * (b[2] - b[0]);
          const y = b[1] + rand() * (b[3] - b[1]);
          if (!pointInPoly(base, x, y) || edgeDistance(base, x, y) < 28) continue;
          if (Math.hypot(x - wc.x, y - wc.y) < 9 || pointInPoly(th, x, y)) continue;
          D.stalls.push(rotRect(x, y, 3.5, 2.5, ang + (rand() < 0.5 ? 0 : 1.57)));
        }
      }
    } else if (ward.type === "cathedral") {
      const big = L.city.population > 40000;
      const ang = (rand() - 0.5) * 0.2;
      mosque(D, wc.x, wc.y, big ? 70 : 48, ang, true);
    } else {
      // Village green with church and pond
      mosque(D, wc.x, wc.y - 12, 16, (rand() - 0.5) * 0.3, false);
      for (let i = 0; i < 8; i++) D.trees.push(wc.x + (rand() - 0.5) * 50, wc.y + 10 + (rand() - 0.5) * 30, 3 + rand() * 3);
    }
  } else if (ward.type === "palace") {
    const e = longestEdge(base);
    const ang = Math.atan2(e.dir.y, e.dir.x);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const at = (u: number, v: number) => ({ x: wc.x + u * c - v * s, y: wc.y + u * s + v * c });
    const m = at(0, -25);
    const l = at(-38, 0);
    const r = at(38, 0);
    D.landmarks.push({
      kind: "palace",
      polys: [rotRect(m.x, m.y, 90, 20, ang), rotRect(l.x, l.y, 16, 60, ang), rotRect(r.x, r.y, 16, 60, ang)],
      accents: [],
      circles: [],
      stone: true,
    });
    // Formal parterre garden
    const g = at(0, 45);
    for (let k = 0; k < 3; k++) D.hedges.push(rotRect(g.x, g.y, 70 - k * 18, 50 - k * 14, ang));
    for (let k = -3; k <= 3; k++) {
      const p = at(k * 11, 80);
      D.trees.push(p.x, p.y, 3.5);
    }
    D.plazas.push(base);
  }

  // --- Blocks and lots ---
  const blocks: Poly[] = [];
  subdivide(base, P.block, P.alley, rand, blocks);
  for (const block of blocks) {
    D.blocks.push(block);
    const lots: Poly[] = [];
    subdivide(block, P.lot * (rand() < 0.12 ? 3 : 0.55 + rand() * 0.9), 0, rand, lots);
    for (const lot of lots) {
      const c = centroid(lot);
      const depth = edgeDistance(block, c.x, c.y);
      if (P.ring > 0 && edgeDistance(base, c.x, c.y) > P.ring) continue;
      if (core && pointInPoly(core, c.x, c.y)) continue;
      if (P.ribbon > 0 && nearArtery(c.x, c.y) > P.ribbon) continue;
      if (D.landmarks.some((lm) => lm.polys.some((p) => pointInPoly(p, c.x, c.y)))) continue;
      if (ward.type === "market" || ward.type === "cathedral") {
        // keep the plaza clear around the centerpiece
        if (Math.hypot(c.x - wc.x, c.y - wc.y) < 55) continue;
      }
      if (depth > P.depth) {
        // Back gardens
        if (rand() < (ward.type === "wealthy" ? 0.6 : 0.25)) D.trees.push(c.x, c.y, 2.5 + rand() * 3);
        continue;
      }
      if (rand() < P.empty) continue;
      const b = insetConvex(lot, P.margin * (0.6 + rand() * 0.8));
      if (!b || Math.abs(area(b)) < 16) continue;
      if (!lotOk(b, 0.5)) continue;
      const wealthy = ward.type === "wealthy" || ward.type === "palace" || ward.type === "castle";
      const pal = wealthy ? st.wealthyRoofs.length : roofCount;
      // Big buildings (halls, warehouses) get hip roofs; the rest follow the culture
      const big = Math.abs(area(b)) > 450;
      const form: RoofForm = st.roofForm === "flat" ? "flat" : big ? "hip" : formFor();
      D.buildings.push(makeBuilding(b, Math.floor(rand() * pal), wealthy, form));
      if (st.roofForm === "flat" && big && rand() < 0.15) {
        const cc = centroid(b);
        D.domes.push(cc.x, cc.y, Math.sqrt(Math.abs(area(b))) * 0.22);
      }
    }
  }

  // Some parish churches in big residential wards
  if ((ward.type === "residential" || ward.type === "craft" || ward.type === "suburb") && rand() < 0.18) {
    mosque(D, wc.x, wc.y, 22, (rand() - 0.5) * 0.3, false);
    D.buildings = D.buildings.filter((b) => {
      const c = centroid(b.faces[0]);
      return Math.hypot(c.x - wc.x, c.y - wc.y) > 22;
    });
  }
  return D;
}
