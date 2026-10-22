import { NoiseEngine } from "../core/NoiseEngine";
import { WorldData } from "./WorldData";
import { yieldFrame } from "./util/grid";
import {
  generateElevation,
  generateCoast,
  generateMoisture,
  generateTemperature,
  determineBiomes,
  generateRivers,
  generateNations,
  generateCities,
  generateRoads,
  generateProvinces,
  generatePopulationDensity,
  generateCultures,
  generateDiplomacy,
  generatePOIs,
  generateSeaRoutes,
  generateCurrents,
  generateEconomy,
  type GeneratorContext,
} from "./generators";

export type Preset =
  | "Heavy Landmass"
  | "Realistic Continents"
  | "Earthlike"
  | "Pangea";

export class MapGenerator {
  private width: number;
  private height: number;
  private world: WorldData;
  private noise: NoiseEngine;

  public currentPreset: Preset = "Heavy Landmass";
  public currentSeed: number;
  public isGenerating = false;
  public greatPowers = 1;

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
  public getNoise() {
    return this.noise;
  }

  public async generate(onProgress?: (pct: number) => void) {
    this.isGenerating = true;
    try {
      return await this.runStages(onProgress);
    } finally {
      this.isGenerating = false;
    }
  }

  private async runStages(onProgress?: (pct: number) => void) {
    onProgress?.(0);
    // Let the loading state paint (rAF never fires in background tabs, hence the timeout)
    await new Promise((r) => {
      requestAnimationFrame(r);
      setTimeout(r, 50);
    });

    this.noise = new NoiseEngine(this.currentSeed);
    this.world = new WorldData(this.width, this.height);
    this.world.seed = this.currentSeed >>> 0;

    const ctx: GeneratorContext = {
      world: this.world,
      noise: this.noise,
      width: this.width,
      height: this.height,
      preset: this.currentPreset,
      greatPowers: this.greatPowers,
    };

    // Helper to report sub-ranges smoothly
    const report = (start: number, end: number) => (subPct: number) => {
      if (onProgress) {
        const totalPct = start + (subPct / 100) * (end - start);
        onProgress(Math.floor(totalPct));
      }
    };

    // Stages with the progress percentage reached when each one finishes
    const stages: [(c: GeneratorContext) => Promise<void>, number][] = [
      [generateElevation, 22],
      [generateCoast, 32],
      [generateMoisture, 36],
      [generateTemperature, 39],
      [generateRivers, 48],
      [generateCurrents, 50],
      [determineBiomes, 52],
      [generatePopulationDensity, 56],
      [generateCultures, 64],
      [generateNations, 74],
      [generateCities, 80],
      [generateEconomy, 82],
      [generateProvinces, 90],
      [generateRoads, 94],
      [generateSeaRoutes, 96],
      [generatePOIs, 98],
      [generateDiplomacy, 100],
    ];
    let start = 0;
    const timings: string[] = [];
    for (const [stage, end] of stages) {
      ctx.onProgress = report(start, end);
      const t0 = performance.now();
      await stage(ctx);
      timings.push(`${stage.name.replace("generate", "")} ${Math.round(performance.now() - t0)}ms`);
      onProgress?.(end);
      await yieldFrame(true);
      start = end;
    }

    console.log(`[MapGenerator] ${timings.join(" · ")}`);
    return this.world;
  }

  public getWorld() {
    return this.world;
  }
}
