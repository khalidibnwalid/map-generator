import { NoiseEngine } from '../core/NoiseEngine';
import { WorldData } from './WorldData';
import {
    generateElevation,
    generateMoisture,
    generateTemperature,
    determineBiomes,
    generateRivers,
    generateNations,
    generateCities,
    type GeneratorContext
} from './generators';

export type Preset = 'Heavy Landmass' | 'Realistic Continents' | 'Mediterranean Archipelago' | 'Pangea';

export class MapGenerator {
    private width: number;
    private height: number;
    private world: WorldData;
    private noise: NoiseEngine;

    public currentPreset: Preset = 'Heavy Landmass';
    public currentSeed: number;

    constructor(width: number, height: number, seed: number) {
        this.width = width;
        this.height = height;
        this.currentSeed = seed;
        this.noise = new NoiseEngine(seed);
        this.world = new WorldData(width, height);
    }

    public getWidth() { return this.width; }
    public getHeight() { return this.height; }
    public setSize(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    public generate() {
        this.noise = new NoiseEngine(this.currentSeed);
        this.world = new WorldData(this.width, this.height);

        const ctx: GeneratorContext = {
            world: this.world,
            noise: this.noise,
            width: this.width,
            height: this.height,
            preset: this.currentPreset
        };

        generateElevation(ctx);
        generateMoisture(ctx);
        generateTemperature(ctx);
        determineBiomes(ctx);
        generateRivers(ctx);
        generateNations(ctx);
        generateCities(ctx);

        return this.world;
    }

    public getWorld() {
        return this.world;
    }
}
