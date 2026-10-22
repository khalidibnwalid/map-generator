import { TerrainSampler } from "../core/TerrainSampler";
import type { Language } from "./names";
import type { Poi } from "./generators/generatePOIs";

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
} as const;

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
};
