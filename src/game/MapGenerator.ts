import { NoiseEngine } from "../core/NoiseEngine";
import { WorldData } from "./WorldData";
import { yieldFrame } from "./util/grid";
import { sampleGuide, type TerrainGuide } from "./ImageGuide";
import { unpackWorld } from "./WorldTransfer";
import type { WorkerMessage } from "./generate.worker";
import { APP_VERSION, atLeast } from "./version";
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
  generateCoalitions,
  generateProvinceTypes,
  generatePOIs,
  generateSeaRoutes,
  generateCurrents,
  generateEconomy,
  generateTrade,
  type GeneratorContext,
  type WorldSettings,
  DEFAULT_SETTINGS,
} from "./generators";

export type Preset =
  | "Heavy Landmass"
  | "Realistic Continents"
  | "Earthlike"
  | "Pangea"
  | "Landworld";

// Everything a generation depends on, as sent to the worker
export interface GenerateRequest {
  width: number;
  height: number;
  seed: number;
  preset: Preset;
  greatPowers: number;
  settings: WorldSettings;
  guide: TerrainGuide | null;
  version: string; // rules to generate under (see version.ts)
  politicsSeed: number; // 0.2+: seeds realms, provinces and what follows them
}

// The worker could not start at all (blocked, unsupported): generate here instead
class WorkerUnavailable extends Error {}

export class MapGenerator {
  private width: number;
  private height: number;
  private world: WorldData;
  private noise: NoiseEngine;

  public currentPreset: Preset = "Heavy Landmass";
  public currentSeed: number;
  public isGenerating = false;
  public greatPowers = 1;
  public settings: WorldSettings = { ...DEFAULT_SETTINGS };
  // Imported picture shaping the land; null for the preset generators
  public guide: TerrainGuide | null = null;
  // Generate in a Web Worker when the platform has one (browsers); tests and
  // the worker itself run the stages in place
  public useWorker = typeof Worker !== "undefined" && typeof window !== "undefined";
  // Version and politics seed the last generation used (see version.ts)
  public version = APP_VERSION;
  public politicsSeed = 0;
  // Set by pin() for the next generation only: a link or file reproducing a world
  private pinned: { version: string; politicsSeed?: number } | null = null;

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

  // The next generate() reproduces a world of this version (and politics seed,
  // when given) instead of making a new one with fresh politics
  public pin(version: string, politicsSeed?: number) {
    this.pinned = { version, politicsSeed };
  }

  public async generate(onProgress?: (pct: number) => void) {
    // A new world uses the current rules and rolls its own politics; a pinned
    // one (link, file) brings back what it was made with
    const pin = this.pinned;
    this.pinned = null;
    this.version = pin?.version ?? APP_VERSION;
    this.politicsSeed = pin?.politicsSeed ?? Math.floor(Math.random() * 0x7fffffff) + 1;
    this.isGenerating = true;
    try {
      if (this.useWorker) {
        try {
          return await this.generateInWorker(onProgress);
        } catch (e) {
          if (!(e instanceof WorkerUnavailable)) throw e;
          console.warn("[MapGenerator] Worker unavailable, generating on the main thread:", e.message);
          this.useWorker = false;
        }
      }
      return await this.runStages(onProgress);
    } finally {
      this.isGenerating = false;
    }
  }

  private generateInWorker(onProgress?: (pct: number) => void): Promise<WorldData> {
    const request: GenerateRequest = {
      width: this.width,
      height: this.height,
      seed: this.currentSeed,
      preset: this.currentPreset,
      greatPowers: this.greatPowers,
      settings: { ...this.settings },
      guide: this.guide,
      version: this.version,
      politicsSeed: this.politicsSeed,
    };
    return new Promise<WorldData>((resolve, reject) => {
      const worker = new Worker(new URL("./generate.worker.ts", import.meta.url), { type: "module", name: "world-generation" });
      let started = false;
      const finish = () => worker.terminate();
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const m = e.data;
        started = true;
        if (m.type === "progress") onProgress?.(m.pct);
        else if (m.type === "error") {
          finish();
          const err = new Error(m.message);
          if (m.stack) err.stack = m.stack;
          reject(err);
        } else {
          finish();
          const { world, noise } = unpackWorld(m.packed);
          this.world = world;
          this.noise = noise;
          resolve(world);
        }
      };
      worker.onerror = (e) => {
        finish();
        // Before any message the worker failed to load; after, generation crashed
        const msg = e.message || "worker failed";
        reject(started ? new Error(msg) : new WorkerUnavailable(msg));
      };
      worker.postMessage(request);
    });
  }

  private async runStages(onProgress?: (pct: number) => void) {
    onProgress?.(0);
    // Let the loading state paint (rAF never fires in background tabs, hence the timeout)
    await new Promise((r) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(r);
      setTimeout(r, 50);
    });

    this.noise = new NoiseEngine(this.currentSeed);
    this.world = new WorldData(this.width, this.height);
    this.world.seed = this.currentSeed >>> 0;
    this.world.version = this.version;
    this.world.politicsSeed = this.politicsSeed;

    const ctx: GeneratorContext = {
      world: this.world,
      noise: this.noise,
      width: this.width,
      height: this.height,
      preset: this.currentPreset,
      greatPowers: this.greatPowers,
      settings: this.settings,
      guide: this.guide ? sampleGuide(this.guide, this.width, this.height, this.currentSeed) : undefined,
      version: this.version,
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
      [generateDiplomacy, 99],
      [generateCoalitions, 99], // 0.2+: realms on good terms band together
      [generateProvinceTypes, 99], // 0.2+: capital districts, marches facing rivals, autonomous regions...
      [generateTrade, 100], // last: wars (from diplomacy) close trade links
    ];
    let start = 0;
    const timings: string[] = [];
    for (const [stage, end] of stages) {
      // From 0.2 the seed fixes the land only: realms, and everything that
      // follows from them, draw from the world's own politics seed
      if (stage === generateNations && atLeast(this.version, "0.2")) this.noise.randomState = this.politicsSeed >>> 0;
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
