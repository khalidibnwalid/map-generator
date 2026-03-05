export const BiomeType = {
    OCEAN: "Ocean",
    DEEP_OCEAN: "Deep Ocean",
    SHALLOW_WATER: "Shallow Water",
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
    TROPICAL_RAIN_FOREST: "Tropical Rain Forest"
} as const;

export type BiomeType = typeof BiomeType[keyof typeof BiomeType];

export interface Nation {
    id: number;
    name: string;
    color: string;
    capitalX: number;
    capitalY: number;
}

export interface City {
    id: number;
    name: string;
    x: number;
    y: number;
    nationIndex: number;
    isCapital: boolean;
    size: number; // 0=village, 1=town, 2=city
}

export interface CellData {
    elevation: number;
    moisture: number;
    temperature: number;
    biome: BiomeType;
    isWater: boolean;
    hasRiver: boolean;
    plateId: number;
    distanceToBoundary: number;
    nationIndex?: number;
    isNationBorder?: boolean;
}

export class WorldData {
    public width: number;
    public height: number;
    public grid: CellData[][];
    public rivers: { x: number, y: number }[][] = [];
    public nations: Nation[] = [];
    public cities: City[] = [];

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
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
                    distanceToBoundary: 999
                };
            }
        }
    }

    public getCell(x: number, y: number): CellData | null {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
            return this.grid[x][y];
        }
        return null;
    }

    public static getBiome(elevation: number, temperature: number, moisture: number): BiomeType {
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

        if (temperature > 0.66) { // Hot
            if (moisture > 0.66) return BiomeType.TROPICAL_RAIN_FOREST;
            if (moisture > 0.50) return BiomeType.TROPICAL_SEASONAL_FOREST;
            if (moisture > 0.33) return BiomeType.SAVANNA;
            if (moisture > 0.16) return BiomeType.GRASSLAND;
            return BiomeType.SUBTROPICAL_DESERT;
        }

        if (temperature > 0.33) { // Temperate
            if (moisture > 0.83) return BiomeType.TEMPERATE_RAIN_FOREST;
            if (moisture > 0.50) return BiomeType.TEMPERATE_DECIDUOUS_FOREST;
            if (moisture > 0.33) return BiomeType.GRASSLAND;
            if (moisture > 0.16) return BiomeType.STEPPE;
            return BiomeType.TEMPERATE_DESERT;
        }

        // Cold
        if (moisture > 0.80) return BiomeType.SNOW;
        if (moisture > 0.50) return BiomeType.TAIGA;
        if (moisture > 0.33) return BiomeType.SHRUBLAND;
        return BiomeType.TUNDRA;
    }
}

export const BIOME_COLORS: Record<BiomeType, string> = {
    [BiomeType.OCEAN]: "#1C3E5A",
    [BiomeType.DEEP_OCEAN]: "#0D2235",
    [BiomeType.SHALLOW_WATER]: "#35708F",
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
    [BiomeType.TROPICAL_RAIN_FOREST]: "#215325"
};
