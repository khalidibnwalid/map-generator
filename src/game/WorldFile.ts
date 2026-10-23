import type { MapGenerator, Preset } from "./MapGenerator";
import type { City, Nation, Province, RelationType, Road, WorldData } from "./WorldData";
import type { Poi } from "./generators/generatePOIs";
import { computeTrade } from "./generators/generateTrade";
import type { TerrainGuide } from "./ImageGuide";

// A .world file = gzip(JSON). Terrain is regenerated from seed/preset/size
// (and the imported picture's guide, when there is one); everything the user
// can edit is stored on top of it. Per-cell ownership is run-length encoded,
// then base64'd inside the JSON before compression.

const FORMAT = "mapgen-world";
// Version 2 adds the image guide; worlds without one are still written as 1
// so older builds keep opening them
const VERSION = 2;

interface SavedGuide {
  w: number;
  h: number;
  fit: TerrainGuide["fit"];
  roughness: number;
  islands?: number; // absent before the setting (none)
  zoom?: number;
  land: string; // deflate + base64
  relief?: string;
  depth?: string;
  moisture?: string;
}

interface WorldFileData {
  format: typeof FORMAT;
  version: number;
  seed: number;
  preset: Preset;
  greatPowers?: number; // absent in files from before the setting (none)
  width: number;
  height: number;
  nations: Nation[];
  provinces: Province[];
  cities: City[];
  relations: string; // relation codes, row-major n×n
  nationGrid: string; // RLE + base64 of per-cell nation index
  provinceGrid: string;
  roads?: string; // only when edits changed the road network
  pois?: Poi[]; // only when landmarks were edited
  year?: number; // simulated year, so ruler ages carry on after loading
  guide?: SavedGuide; // imported picture the terrain was shaped from
}

const RELATION_CODES: RelationType[] = ["Neutral", "Alliance", "Friendly", "Rival", "War", "Vassal", "Overlord"];

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// [value, runLength] pairs as Int32
function rleEncode(values: Int32Array): string {
  const pairs: number[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i];
    let j = i + 1;
    while (j < values.length && values[j] === v) j++;
    pairs.push(v, j - i);
    i = j;
  }
  return toBase64(new Uint8Array(new Int32Array(pairs).buffer));
}

function rleDecode(b64: string, length: number): Int32Array {
  const bytes = fromBase64(b64);
  const pairs = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const out = new Int32Array(length);
  let o = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    out.fill(pairs[k], o, o + pairs[k + 1]);
    o += pairs[k + 1];
  }
  return out;
}

// Roads: per road [tier, a, b, count, then delta-encoded x/y in 1/100 cells]
function encodeRoads(roads: Road[]): string {
  const ints: number[] = [];
  for (const r of roads) {
    ints.push(r.tier, r.a, r.b, r.points.length);
    let px = 0;
    let py = 0;
    for (const p of r.points) {
      const x = Math.round(p.x * 100);
      const y = Math.round(p.y * 100);
      ints.push(x - px, y - py);
      px = x;
      py = y;
    }
  }
  return toBase64(new Uint8Array(new Int32Array(ints).buffer));
}

function decodeRoads(b64: string): Road[] {
  const bytes = fromBase64(b64);
  const v = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const roads: Road[] = [];
  let i = 0;
  while (i < v.length) {
    const tier = v[i++];
    const a = v[i++];
    const b = v[i++];
    const n = v[i++];
    const points = [];
    let x = 0;
    let y = 0;
    for (let k = 0; k < n; k++) {
      x += v[i++];
      y += v[i++];
      points.push({ x: x / 100, y: y / 100 });
    }
    roads.push({ tier, a, b, points });
  }
  return roads;
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// Guide layers are deflated before base64, which gzip alone cannot shrink
async function packBytes(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function unpackBytes(b64: string): Promise<Uint8Array> {
  const stream = new Blob([fromBase64(b64) as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodeGuide(g: TerrainGuide): Promise<SavedGuide> {
  return {
    w: g.w,
    h: g.h,
    fit: g.fit,
    roughness: g.roughness,
    islands: g.islands,
    zoom: g.zoom,
    land: await packBytes(g.land),
    relief: g.relief ? await packBytes(g.relief) : undefined,
    depth: g.depth ? await packBytes(g.depth) : undefined,
    moisture: g.moisture ? await packBytes(g.moisture) : undefined,
  };
}

async function decodeGuide(s: SavedGuide): Promise<TerrainGuide> {
  return {
    w: s.w,
    h: s.h,
    fit: s.fit,
    roughness: s.roughness,
    islands: s.islands ?? 0,
    zoom: s.zoom ?? 1,
    land: await unpackBytes(s.land),
    relief: s.relief ? await unpackBytes(s.relief) : null,
    depth: s.depth ? await unpackBytes(s.depth) : null,
    moisture: s.moisture ? await unpackBytes(s.moisture) : null,
  };
}

export async function saveWorld(generator: MapGenerator): Promise<Blob> {
  const world = generator.getWorld();
  const W = world.width;
  const N = W * world.height;
  const nationGrid = new Int32Array(N);
  const provinceGrid = new Int32Array(N);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      nationGrid[y * W + x] = c.nationIndex ?? -1;
      provinceGrid[y * W + x] = c.provinceIndex ?? -1;
    }
  }
  const n = world.nations.length;
  let rel = "";
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) rel += Math.max(0, RELATION_CODES.indexOf(world.relations[a]?.[b] ?? "Neutral"));

  const data: WorldFileData = {
    format: FORMAT,
    version: generator.guide ? VERSION : 1,
    seed: generator.currentSeed,
    preset: generator.currentPreset,
    greatPowers: generator.greatPowers,
    width: W,
    height: world.height,
    nations: world.nations,
    provinces: world.provinces,
    cities: world.cities,
    relations: rel,
    nationGrid: rleEncode(nationGrid),
    provinceGrid: rleEncode(provinceGrid),
    roads: world.roadsEdited ? encodeRoads(world.worldRoads) : undefined,
    pois: world.poisEdited ? world.pois : undefined,
    year: world.year || undefined,
    guide: generator.guide ? await encodeGuide(generator.guide) : undefined,
  };
  // Trim float noise from city coordinates to keep the file small
  const json = JSON.stringify(data, (_k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v));
  return gzip(json);
}

export async function loadWorld(
  file: Blob,
  generator: MapGenerator,
  onProgress?: (pct: number) => void,
): Promise<WorldData> {
  const data = JSON.parse(await gunzip(file)) as WorldFileData;
  if (data.format !== FORMAT) throw new Error("Not a world file");
  if (data.version > VERSION) throw new Error(`World file version ${data.version} is newer than this app supports`);

  generator.currentSeed = data.seed;
  generator.currentPreset = data.preset;
  generator.greatPowers = data.greatPowers ?? 0;
  generator.guide = data.guide ? await decodeGuide(data.guide) : null;
  generator.setSize(data.width, data.height);
  await generator.generate(onProgress);
  const world = generator.getWorld();

  world.nations = data.nations;
  world.provinces = data.provinces;
  world.cities = data.cities;
  world.year = data.year ?? 0;
  const n = world.nations.length;
  world.relations = Array.from({ length: n }, (_, a) =>
    Array.from({ length: n }, (_, b) => RELATION_CODES[Number(data.relations[a * n + b] ?? 0)] ?? "Neutral"),
  );
  if (data.roads) {
    world.worldRoads = decodeRoads(data.roads);
    world.roadsEdited = true;
  }
  if (data.pois) {
    world.pois = data.pois;
    world.poisEdited = true;
  }

  const W = world.width;
  const N = W * world.height;
  const nationGrid = rleDecode(data.nationGrid, N);
  const provinceGrid = rleDecode(data.provinceGrid, N);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      c.nationIndex = nationGrid[y * W + x];
      c.provinceIndex = provinceGrid[y * W + x];
    }
  }
  // Border flags follow the restored ownership
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      const id = c.nationIndex ?? -1;
      let border = false;
      if (!c.isWater && id >= 0) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = world.getCell(x + dx, y + dy);
          if (nb && (nb.isWater || (nb.nationIndex ?? -1) !== id)) border = true;
        }
      }
      c.isNationBorder = border;
    }
  }
  // Trade follows the saved settlements, roads and wars
  computeTrade(world);
  return world;
}
