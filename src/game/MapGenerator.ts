import { NoiseEngine } from "../core/NoiseEngine";
import { WorldData } from "./WorldData";
import {
  generateElevation,
  generateMoisture,
  generateTemperature,
  determineBiomes,
  generateRivers,
  generateNations,
  generateCities,
  generateRoads,
  generateCityGeometry,
  type GeneratorContext,
} from "./generators";

export type Preset =
  | "Heavy Landmass"
  | "Realistic Continents"
  | "Mediterranean Archipelago"
  | "Pangea";

export class MapGenerator {
  private width: number;
  private height: number;
  private world: WorldData;
  private noise: NoiseEngine;

  public currentPreset: Preset = "Heavy Landmass";
  public currentSeed: number;

  constructor(width: number, height: number, seed: number) {
    this.width = width;
    this.height = height;
    this.currentSeed = seed;
    this.noise = new NoiseEngine(seed);
    this.world = new WorldData(width, height);
  }

  public getWidth() {
    return this.width;
  }
  public getHeight() {
    return this.height;
  }
  public setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  public async generate(onProgress?: (pct: number) => void) {
    onProgress?.(0);
    await new Promise((r) => requestAnimationFrame(r)); // Yield to paint loading state

    this.noise = new NoiseEngine(this.currentSeed);
    this.world = new WorldData(this.width, this.height);

    const ctx: GeneratorContext = {
      world: this.world,
      noise: this.noise,
      width: this.width,
      height: this.height,
      preset: this.currentPreset,
    };

    // Helper to report sub-ranges smoothly
    const report = (start: number, end: number) => (subPct: number) => {
      if (onProgress) {
        const totalPct = start + (subPct / 100) * (end - start);
        onProgress(Math.floor(totalPct));
      }
    };

    // Stages with fixed starting points and granular sub-progress
    ctx.onProgress = report(0, 30);
    await generateElevation(ctx);
    onProgress?.(30);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(30, 40);
    await generateMoisture(ctx);
    onProgress?.(40);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(40, 45);
    await generateTemperature(ctx);
    onProgress?.(45);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(45, 50);
    await determineBiomes(ctx);
    onProgress?.(50);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(50, 85);
    await generateRivers(ctx);
    onProgress?.(85);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(85, 90);
    await determineBiomes(ctx); // Re-run to update biomes for carved rivers
    onProgress?.(90);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(90, 95);
    await generateNations(ctx);
    onProgress?.(95);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(95, 97);
    await generateCities(ctx);
    onProgress?.(97);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(97, 98);
    await generateRoads(ctx);
    onProgress?.(98);
    await new Promise((r) => requestAnimationFrame(r));

    ctx.onProgress = report(98, 100);
    await generateCityGeometry(ctx);
    onProgress?.(100);

    return this.world;
  }

  public getWorld() {
    return this.world;
  }
}
