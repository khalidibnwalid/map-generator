import { TerrainSampler } from "../core/TerrainSampler";
import type { FlagSpec } from "./flags";
import type { Language } from "./names";
import type { Poi } from "./generators/generatePOIs";
import type { SeaRoute } from "./generators/generateSeaRoutes";
import type { CurrentField } from "./generators/generateCurrents";
import type { Resource } from "./generators/generateEconomy";

export const BiomeType = {
  OCEAN: "Ocean",
  DEEP_OCEAN: "Deep Ocean",
  SHALLOW_WATER: "Shallow Water",
  LAKE: "Lake",
  BEACH: "Beach",
  SCORCHED: "Scorched",
  BARE: "Bare",
  TUNDRA: "Tundra",
  SNOW: "Snow",
  TAIGA: "Taiga",
  STEPPE: "Steppe",
  MARSH: "Marsh",
  TEMPERATE_DESERT: "Temperate Desert",
  SHRUBLAND: "Shrubland",
  GRASSLAND: "Grassland",
  TEMPERATE_DECIDUOUS_FOREST: "Temperate Deciduous Forest",
  TEMPERATE_RAIN_FOREST: "Temperate Rain Forest",
  SUBTROPICAL_DESERT: "Subtropical Desert",
  SAVANNA: "Savanna",
  TROPICAL_SEASONAL_FOREST: "Tropical Seasonal Forest",
  TROPICAL_RAIN_FOREST: "Tropical Rain Forest",
  ALPINE_MEADOW: "Alpine Meadow",
  SCREE: "Rock & Scree",
  GLACIER: "Glacier",
  MONTANE_FOREST: "Montane Forest",
  CHAPARRAL: "Mediterranean Scrub",
  MANGROVE: "Mangrove",
  FLOODPLAIN: "Floodplain",
  BOG: "Bog",
  SALT_FLAT: "Salt Flat",
  BADLANDS: "Badlands",
  COLD_DESERT: "Cold Desert",
  PRAIRIE: "Prairie",
  CLOUD_FOREST: "Cloud Forest",
  DUNES: "Sand Dunes",
} as const;

// GPU palette slot for every biome (see MapShader's classify()).
export const BIOME_INDEX: Record<string, number> = {
  Ocean: 0,
  "Shallow Water": 1,
  Beach: 2,
  Lake: 3,
  Scorched: 4,
  Bare: 5,
  Tundra: 6,
  Snow: 7,
  "Temperate Desert": 8,
  Shrubland: 9,
  Grassland: 10,
  "Temperate Deciduous Forest": 11,
  "Temperate Rain Forest": 12,
  "Subtropical Desert": 13,
  "Tropical Seasonal Forest": 14,
  "Tropical Rain Forest": 15,
  Taiga: 19,
  "Deep Ocean": 20,
  Marsh: 21,
  Savanna: 22,
  Steppe: 23,
  "Alpine Meadow": 24,
  "Rock & Scree": 25,
  Glacier: 26,
  "Montane Forest": 27,
  "Mediterranean Scrub": 28,
  Mangrove: 29,
  Floodplain: 30,
  Bog: 31,
  "Salt Flat": 32,
  Badlands: 33,
  "Cold Desert": 34,
  Prairie: 35,
  "Cloud Forest": 36,
  "Sand Dunes": 37,
};
const BIOME_BY_INDEX: string[] = [];
for (const [k, v] of Object.entries(BIOME_INDEX)) BIOME_BY_INDEX[v] = k;

// Land biome from climate, relief and water. slope: elevation change per
// cell; water: distance (cells) to a river or lake; coast: distance to sea.
// Keep in sync with classify() in MapShader.ts.
export function classifyLandBiome(e: number, t: number, m: number, slope: number, water: number, coast: number): number {
  if (e > 0.86) return t < 0.25 ? 26 : m > 0.45 ? 7 : 25;
  if (slope > 0.06 && e > 0.62) return 25;
  if (e > 0.78) {
    if (t < 0.2) return 26;
    return m > 0.3 ? 24 : 25;
  }
  if (e > 0.68) {
    if (t > 0.6 && m > 0.6) return 36;
    if (m > 0.4) return t < 0.35 ? 19 : 27;
    if (m > 0.2) return 9;
    return t > 0.55 ? 33 : 5;
  }
  if (water < 0.35) {
    if (t < 0.3) return 31;
    if (m < 0.25) return 30;
    if (e < 0.53 && m > 0.55) return 21;
    return 30;
  }
  if (coast < 0.12 && t > 0.68 && m > 0.45 && e < 0.52) return 29;
  if (coast < 0.06 && m < 0.35 && e < 0.5) return 37;
  if (t > 0.66) {
    if (m < 0.08) return 37;
    if (m < 0.16) return e < 0.5 && coast > 3 ? 32 : 13;
    if (m < 0.3) return e > 0.58 ? 33 : 22;
    if (m < 0.45) return 22;
    if (m < 0.62) return 14;
    return 15;
  }
  if (t > 0.33) {
    if (m < 0.12) return 34;
    if (m < 0.25) return t > 0.5 && coast < 10 ? 28 : 23;
    if (m < 0.4) return t > 0.45 ? 35 : 10;
    if (e < 0.53 && m > 0.75) return 21;
    if (m < 0.8) return 11;
    return 12;
  }
  if (m < 0.2) return 6;
  if (m < 0.35) return 9;
  if (e < 0.52 && m > 0.7) return 31;
  return 19;
}

export function biomeFromIndex(i: number): BiomeType {
  return (BIOME_BY_INDEX[i] ?? "Grassland") as BiomeType;
}

export type BiomeType = (typeof BiomeType)[keyof typeof BiomeType];

export const CELL_KM = 5;
export const CELL_KM2 = CELL_KM * CELL_KM;

export interface Nation {
  id: number;
  name: string;
  color: string;
  capitalX: number;
  capitalY: number;
  cultureId?: number;
  religionId?: number;
  government?: string;
  overlord?: number; // index of the nation this one is a vassal of
  flag?: FlagSpec; // custom or generated flag (see flags.ts)
}

export interface Province {
  id: number;
  name: string;
  color: string;
  nationIndex: number;
  capitalCityId: number;
  seatX?: number;
  seatY?: number;
  centroidX?: number;
  centroidY?: number;
  area?: number; // km² of land
  population?: number;
}

export interface Point {
  x: number;
  y: number;
}
export type Polygon = Point[];

export interface River {
  id: number;
  name: string;
  points: Point[]; // world cells, x unwrapped (may exceed [0, W))
  widths: number[]; // meters, one per point
  flow: number; // peak discharge proxy, in threshold units
  parent: number; // river this one flows into, -1 for sea / lake
}

export interface Road {
  points: Point[]; // world cells, x unwrapped
  tier: number; // 0 = track, 1 = road, 2 = highway
  a: number; // city ids
  b: number;
}

export interface City {
  id: number;
  name: string;
  x: number;
  y: number;
  nationIndex: number;
  provinceIndex?: number;
  isCapital: boolean;
  size: number; // 0=village, 1=town, 2=city
  population: number;
  radiusM: number; // radius of the built-up core, meters
  seed: number;
  isPort?: boolean;
  wealth?: number; // income proxy from resources and trade
  wealthTier?: number; // index into WEALTH_TIERS
  resources?: string[]; // notable resource kinds nearby
}

export interface Culture {
  id: number;
  name: string;
  color: string;
  centerX: number;
  centerY: number;
}

export interface Religion {
  id: number;
  name: string;
  color: string;
  centerX: number;
  centerY: number;
}

export type RelationType =
  | "Alliance"
  | "Friendly"
  | "Neutral"
  | "Rival"
  | "War"
  | "Vassal"
  | "Overlord";

export interface CellData {
  elevation: number;
  moisture: number;
  temperature: number;
  biome: BiomeType;
  isWater: boolean;
  hasRiver: boolean;
  plateId: number;
  distanceToBoundary: number;
  populationDensity: number;
  nationIndex?: number;
  provinceIndex?: number;
  isNationBorder?: boolean;
  cultureIndex?: number;
  religionIndex?: number;
}

export const WaterType = { LAND: 0, OCEAN: 1, LAKE: 2 } as const;

export class WorldData {
  public width: number;
  public height: number;
  public seed: number = 0;
  public grid: CellData[][];
  public rivers: River[] = [];
  public worldRoads: Road[] = [];
  public nations: Nation[] = [];
  public provinces: Province[] = [];
  public cities: City[] = [];
  public cultures: Culture[] = [];
  public religions: Religion[] = [];
  public languages: Language[] = []; // one per culture, runtime only
  public pois: Poi[] = [];
  public seaRoutes: SeaRoute[] = [];
  public currents: CurrentField | null = null;
  public resources: Resource[] = [];
  public roadsEdited = false; // roads differ from what the seed generates
  public poisEdited = false; // landmarks were placed, renamed or removed
  // relations[a][b], symmetric except Vassal/Overlord pairs
  public relations: RelationType[][] = [];

  // Flat per-cell arrays (index y * width + x)
  public coastSdf: Uint16Array; // quantized signed distance to coast, see FieldNoise
  public waterType: Uint8Array;
  public landmass: Int32Array; // land component id, -1 for water
  public receiver: Int32Array; // drainage target cell, -1 for outlets
  public flowOrder: Int32Array; // cells from outlets upstream
  public flowOrderLength = 0;
  public flow: Float32Array;

  private _sampler: TerrainSampler | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const N = width * height;
    this.coastSdf = new Uint16Array(N);
    this.waterType = new Uint8Array(N);
    this.landmass = new Int32Array(N).fill(-1);
    this.receiver = new Int32Array(N).fill(-1);
    this.flowOrder = new Int32Array(N);
    this.flow = new Float32Array(N);
    this.grid = new Array(width);
    for (let x = 0; x < width; x++) {
      this.grid[x] = new Array(height);
      for (let y = 0; y < height; y++) {
        this.grid[x][y] = {
          elevation: 0,
          moisture: 0,
          temperature: 0,
          biome: BiomeType.OCEAN,
          isWater: true,
          hasRiver: false,
          plateId: -1,
          distanceToBoundary: 999,
          populationDensity: 0,
        };
      }
    }
  }

  public get sampler(): TerrainSampler {
    if (!this._sampler) this._sampler = new TerrainSampler(this);
    return this._sampler;
  }

  public invalidateSampler() {
    this._sampler = null;
  }

  public getCell(x: number, y: number): CellData | null {
    x = Math.floor(x);
    y = Math.floor(y);
    if (y < 0 || y >= this.height) return null;
    x = ((x % this.width) + this.width) % this.width;
    return this.grid[x][y];
  }

  public static getBiome(
    elevation: number,
    temperature: number,
    moisture: number,
  ): BiomeType {
    if (elevation < 0.1) return BiomeType.DEEP_OCEAN;
    if (elevation < 0.3) return BiomeType.OCEAN;
    if (elevation < 0.45) return BiomeType.SHALLOW_WATER;
    if (elevation < 0.48) return BiomeType.BEACH;

    if (elevation > 0.85) {
      if (moisture > 0.5) return BiomeType.SNOW;
      if (moisture > 0.33) return BiomeType.TUNDRA;
      if (moisture > 0.16) return BiomeType.BARE;
      return BiomeType.SCORCHED;
    }

    // Low Elevation - high moisture check for Marsh
    if (elevation < 0.55 && moisture > 0.7) {
      return BiomeType.MARSH;
    }

    if (temperature > 0.66) {
      // Hot
      if (moisture > 0.66) return BiomeType.TROPICAL_RAIN_FOREST;
      if (moisture > 0.5) return BiomeType.TROPICAL_SEASONAL_FOREST;
      if (moisture > 0.33) return BiomeType.SAVANNA;
      if (moisture > 0.16) return BiomeType.GRASSLAND;
      return BiomeType.SUBTROPICAL_DESERT;
    }

    if (temperature > 0.33) {
      // Temperate
      if (moisture > 0.83) return BiomeType.TEMPERATE_RAIN_FOREST;
      if (moisture > 0.5) return BiomeType.TEMPERATE_DECIDUOUS_FOREST;
      if (moisture > 0.33) return BiomeType.GRASSLAND;
      if (moisture > 0.16) return BiomeType.STEPPE;
      return BiomeType.TEMPERATE_DESERT;
    }

    // Cold
    if (moisture > 0.8) return BiomeType.SNOW;
    if (moisture > 0.5) return BiomeType.TAIGA;
    if (moisture > 0.33) return BiomeType.SHRUBLAND;
    return BiomeType.TUNDRA;
  }

  // Real-world style readings for tooltips
  public static elevationMeters(e: number): number {
    if (e < 0.45) return -Math.round(((0.45 - e) / 0.45) * 6000);
    return Math.round(Math.pow((e - 0.45) / 0.55, 1.6) * 6500);
  }

  public static temperatureC(t: number): number {
    return Math.round(-30 + t * 60);
  }
}

export const BIOME_COLORS: Record<BiomeType, string> = {
  [BiomeType.OCEAN]: "#1C3E5A",
  [BiomeType.DEEP_OCEAN]: "#0D2235",
  [BiomeType.SHALLOW_WATER]: "#35708F",
  [BiomeType.LAKE]: "#3B7A99",
  [BiomeType.BEACH]: "#D3CBA1",
  [BiomeType.SCORCHED]: "#555555",
  [BiomeType.BARE]: "#888888",
  [BiomeType.TUNDRA]: "#C3C3C3",
  [BiomeType.SNOW]: "#F8F8F8",
  [BiomeType.TAIGA]: "#405435",
  [BiomeType.STEPPE]: "#A0A070",
  [BiomeType.MARSH]: "#2F483E",
  [BiomeType.TEMPERATE_DESERT]: "#C4B281",
  [BiomeType.SHRUBLAND]: "#8A9A65",
  [BiomeType.GRASSLAND]: "#74A152",
  [BiomeType.TEMPERATE_DECIDUOUS_FOREST]: "#45773A",
  [BiomeType.TEMPERATE_RAIN_FOREST]: "#285E2E",
  [BiomeType.SUBTROPICAL_DESERT]: "#D1B576",
  [BiomeType.SAVANNA]: "#B9B05C",
  [BiomeType.TROPICAL_SEASONAL_FOREST]: "#66923C",
  [BiomeType.TROPICAL_RAIN_FOREST]: "#215325",
  [BiomeType.ALPINE_MEADOW]: "#8FA067",
  [BiomeType.SCREE]: "#8B8580",
  [BiomeType.GLACIER]: "#EEF3F7",
  [BiomeType.MONTANE_FOREST]: "#3D5E3E",
  [BiomeType.CHAPARRAL]: "#A39A63",
  [BiomeType.MANGROVE]: "#3E5B3A",
  [BiomeType.FLOODPLAIN]: "#6E9E48",
  [BiomeType.BOG]: "#5F6B4A",
  [BiomeType.SALT_FLAT]: "#E6E0D2",
  [BiomeType.BADLANDS]: "#B07650",
  [BiomeType.COLD_DESERT]: "#B9AE8E",
  [BiomeType.PRAIRIE]: "#9AAA5A",
  [BiomeType.CLOUD_FOREST]: "#2E5A38",
  [BiomeType.DUNES]: "#E1C48A",
};
