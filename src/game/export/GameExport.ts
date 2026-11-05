import { BIOME_COLORS, BIOME_INDEX, CELL_KM, type Point } from "../WorldData";
import type { MapGenerator } from "../MapGenerator";
import { recipeToHash } from "../WorldLink";

// "Export for game engines": the world as data other tools can read. A JSON
// file with every realm, settlement, route and landmark; a 16-bit heightmap
// for terrain tools (Unity, Godot, Unreal, World Machine); and images, both
// colored previews and index maps where a pixel's color is an id.
//
// Everything is in grid cells: x to the east, y to the south, one cell is
// CELL_KM kilometers, and x wraps around (the world is a cylinder). Polyline
// x values may run past the width where a line crosses the seam.

export const EXPORT_FORMAT = "fantasy-world-map/world-data";
export const EXPORT_VERSION = 1;

// An image as RGBA bytes; the caller encodes it to PNG (that needs a canvas)
export interface RasterImage {
  name: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface GameExport {
  json: string;
  readme: string;
  heightmap16: Uint8Array<ArrayBuffer>; // little-endian Uint16, row-major from the top-left
  images: RasterImage[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const pts = (p: Point[]) => p.map((q) => [r2(q.x), r2(q.y)]);
const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const SIZE_NAMES = ["village", "town", "city"];
const ROAD_TIERS = ["track", "road", "highway"];

function image(name: string, W: number, H: number, px: (x: number, y: number) => [number, number, number]): RasterImage {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      const o = (y * W + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  return { name, width: W, height: H, rgba };
}

// Id + 1 in red (low byte) and green (high byte); black is "none"
export const idColor = (id: number | undefined): [number, number, number] => {
  const v = id === undefined || id < 0 ? 0 : id + 1;
  return [v & 255, (v >> 8) & 255, 0];
};

export function buildGameExport(generator: MapGenerator): GameExport {
  const world = generator.getWorld();
  const W = world.width;
  const H = world.height;
  const seaLevel = generator.settings.seaLevel;
  const cityIds = new Set(world.cities.map((c) => c.id));

  const relations: { a: number; b: number; type: string }[] = [];
  const n = world.nations.length;
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      const t = world.relations[a]?.[b];
      // Symmetric relations once; vassal ties in both directions
      if (a !== b && t && t !== "Neutral" && (a < b || t === "Vassal" || t === "Overlord")) relations.push({ a, b, type: t });
    }

  const data = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generator: {
      seed: generator.currentSeed,
      preset: generator.currentPreset,
      greatPowers: generator.greatPowers,
      settings: generator.settings,
      shapedFromImage: !!generator.guide,
      link: generator.guide
        ? null
        : recipeToHash({ seed: generator.currentSeed, preset: generator.currentPreset, width: W, height: H, greatPowers: generator.greatPowers, settings: generator.settings }),
    },
    grid: {
      width: W,
      height: H,
      cellKm: CELL_KM,
      wrapsX: true,
      seaLevel, // elevation (0..1) below which a cell is water
      note: "Coordinates are grid cells: x east, y south, origin at the top-left corner of cell (0,0). Polylines may run past x = width where they cross the seam.",
    },
    year: world.year,
    biomes: Object.entries(BIOME_INDEX).map(([name, id]) => ({ id, name, color: BIOME_COLORS[name as keyof typeof BIOME_COLORS] ?? null })),
    nations: world.nations.map((nt, i) => ({
      id: i,
      name: nt.name,
      color: nt.color,
      capital: { x: r2(nt.capitalX), y: r2(nt.capitalY) },
      government: nt.government ?? null,
      overlord: nt.overlord ?? null,
      culture: nt.cultureId ?? null,
      dynasty: nt.dynasty ?? null,
      ruler: nt.ruler ?? null,
      flag: nt.flag ?? null,
    })),
    provinces: world.provinces.map((p, i) => ({
      id: i,
      name: p.name,
      color: p.color,
      nation: p.nationIndex,
      capitalCity: cityIds.has(p.capitalCityId) ? p.capitalCityId : null,
      seat: p.seatX !== undefined && p.seatY !== undefined ? { x: r2(p.seatX), y: r2(p.seatY) } : null,
      areaKm2: p.area ?? null,
      population: p.population ?? null,
    })),
    cities: world.cities.map((c) => ({
      id: c.id,
      name: c.name,
      x: r2(c.x),
      y: r2(c.y),
      nation: c.nationIndex,
      province: c.provinceIndex ?? null,
      kind: SIZE_NAMES[c.size] ?? "village",
      population: c.population,
      capital: c.isCapital,
      port: !!c.isPort,
      wealth: c.wealth !== undefined ? r2(c.wealth) : null,
      resources: c.resources ?? [],
    })),
    cultures: world.cultures.map((c, i) => ({ id: i, name: c.name, color: c.color, race: c.raceId ?? null, language: world.languages[i]?.family.key ?? null })),
    races: world.races.map((r, i) => ({ id: i, name: r.name, color: r.color, language: r.family })),
    relations,
    rivers: world.rivers.map((r) => ({ id: r.id, name: r.name, flowsInto: r.parent >= 0 ? r.parent : null, points: pts(r.points), widthsM: r.widths.map(Math.round) })),
    roads: world.worldRoads.map((r) => ({ from: r.a, to: r.b, tier: ROAD_TIERS[r.tier] ?? "track", points: pts(r.points) })),
    seaRoutes: world.seaRoutes.map((r) => ({ from: r.a, to: r.b, tier: r.tier, points: pts(r.points) })),
    landmarks: world.pois.map((p) => ({ kind: p.kind, name: p.name, x: r2(p.x), y: r2(p.y), nation: p.nationIndex })),
    resources: world.resources.map((r) => ({ kind: r.kind, x: r2(r.x), y: r2(r.y), richness: r2(r.richness) })),
    files: {
      "heightmap.r16": "Elevation, 16-bit little-endian unsigned, width x height, row by row from the top. 0 = deepest sea floor, 65535 = highest peak; sea level is grid.seaLevel * 65535.",
      "heightmap.png": "The same elevation as an 8-bit grayscale preview.",
      "biomes.png": "Biome colors.",
      "political.png": "Nation colors on land; water is dark blue.",
      "index/biomes.png": "Red = biome id (see biomes).",
      "index/nations.png": "Nation id + 1 = red + 256 * green; black is no nation.",
      "index/provinces.png": "Province id + 1, encoded the same way.",
      "index/cultures.png": "Culture id + 1, encoded the same way.",
      "index/water.png": "Red: 0 land, 1 ocean, 2 lake.",
    },
  };

  // Heightmap: raw elevation, 0..1
  const heightmap16 = new Uint8Array(W * H * 2);
  const hv = new DataView(heightmap16.buffer);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) hv.setUint16((y * W + x) * 2, Math.round(Math.max(0, Math.min(1, world.grid[x][y].elevation)) * 65535), true);

  const cell = (x: number, y: number) => world.grid[x][y];
  const WATER: [number, number, number] = [28, 62, 90];
  const images: RasterImage[] = [
    image("heightmap.png", W, H, (x, y) => {
      const v = Math.round(Math.max(0, Math.min(1, cell(x, y).elevation)) * 255);
      return [v, v, v];
    }),
    image("biomes.png", W, H, (x, y) => hex(BIOME_COLORS[cell(x, y).biome] ?? "#808080")),
    image("political.png", W, H, (x, y) => {
      const c = cell(x, y);
      if (c.isWater) return WATER;
      const nt = world.nations[c.nationIndex ?? -1];
      return nt ? hex(nt.color) : [200, 190, 170];
    }),
    image("index/biomes.png", W, H, (x, y) => [BIOME_INDEX[cell(x, y).biome] ?? 0, 0, 0]),
    image("index/nations.png", W, H, (x, y) => idColor(cell(x, y).nationIndex)),
    image("index/provinces.png", W, H, (x, y) => idColor(cell(x, y).provinceIndex)),
    image("index/cultures.png", W, H, (x, y) => idColor(cell(x, y).cultureIndex)),
    image("index/water.png", W, H, (x, y) => [world.waterType[y * W + x], 0, 0]),
  ];

  const readme = [
    "World data export",
    "=================",
    "",
    `Seed ${generator.currentSeed}, ${W} x ${H} cells of ${CELL_KM} km${world.year ? `, year ${world.year}` : ""}.`,
    "",
    "world.json      Realms, provinces, settlements, rivers, roads, sea routes,",
    "                landmarks, resources, cultures, races and diplomacy.",
    `                Format "${EXPORT_FORMAT}", version ${EXPORT_VERSION}.`,
    `heightmap.r16   16-bit RAW heightmap (little-endian), ${W} x ${H}. Unity:`,
    "                Terrain > Import Raw, Depth 16 bit, Byte Order Windows.",
    `                Sea level is at ${Math.round(seaLevel * 65535)} of 65535.`,
    "*.png           Previews: heightmap, biomes, political.",
    "index/*.png     Lookup images where a pixel's color is an id; see \"files\"",
    "                in world.json for each encoding.",
    "",
    `Coordinates are grid cells (x east, y south). One cell is ${CELL_KM} km; pixel`,
    "(x, y) in every image is cell (x, y). The world wraps east to west.",
    "",
  ].join("\n");

  return { json: JSON.stringify(data), readme, heightmap16, images };
}
