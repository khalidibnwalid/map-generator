import type { WorldData } from "../src/game/WorldData";

// FNV-1a over a stream of 32-bit words. Cheap, stable and good enough to tell
// "this stage produced something different" apart from "identical".
class Hasher {
  private h = 0x811c9dc5;
  private f = new Float32Array(1);
  private u = new Uint32Array(this.f.buffer);
  int(v: number) {
    v |= 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= (v >>> (i * 8)) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
    return this;
  }
  // Floats are rounded first so a harmless last-bit difference between JS
  // engines does not fail the test; anything visible on the map still does.
  num(v: number, digits = 4) {
    this.f[0] = Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : -1;
    return this.int(this.u[0]);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.int(s.charCodeAt(i));
    return this.int(-1);
  }
  any(v: unknown): this {
    if (v === undefined || v === null) return this.int(-7);
    if (typeof v === "number") return this.num(v);
    if (typeof v === "string") return this.str(v);
    if (typeof v === "boolean") return this.int(v ? 1 : 0);
    if (ArrayBuffer.isView(v)) {
      const a = v as unknown as ArrayLike<number>;
      for (let i = 0; i < a.length; i++) this.num(a[i]);
      return this;
    }
    if (Array.isArray(v)) {
      this.int(v.length);
      for (const x of v) this.any(x);
      return this;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (typeof x === "function") continue;
        this.str(k).any(x);
      }
      return this;
    }
    return this;
  }
  hex() {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

const hash = (fn: (h: Hasher) => void) => {
  const h = new Hasher();
  fn(h);
  return h.hex();
};

function cells(world: WorldData, pick: (c: WorldData["grid"][0][0]) => unknown) {
  return hash((h) => {
    for (let y = 0; y < world.height; y++) for (let x = 0; x < world.width; x++) h.any(pick(world.grid[x][y]));
  });
}

// One hash per layer, so a failing snapshot points at the stage that changed
export function fingerprint(world: WorldData) {
  return {
    elevation: cells(world, (c) => c.elevation),
    climate: cells(world, (c) => [c.temperature, c.moisture]),
    biomes: cells(world, (c) => c.biome),
    rivers: hash((h) => h.any(world.rivers)),
    coast: hash((h) => h.any(world.coastSdf).any(world.waterType)),
    population: cells(world, (c) => c.populationDensity),
    cultures: hash((h) => h.any(world.cultures).any(world.races)) + "/" + cells(world, (c) => [c.cultureIndex ?? -1, c.raceIndex ?? -1]),
    nations: hash((h) => h.any(world.nations)) + "/" + cells(world, (c) => c.nationIndex ?? -1),
    provinces: hash((h) => h.any(world.provinces)) + "/" + cells(world, (c) => c.provinceIndex ?? -1),
    cities: hash((h) => h.any(world.cities)),
    roads: hash((h) => h.any(world.worldRoads)),
    seaRoutes: hash((h) => h.any(world.seaRoutes)),
    pois: hash((h) => h.any(world.pois)),
    relations: hash((h) => h.any(world.relations)),
    counts: `${world.nations.length} nations, ${world.provinces.length} provinces, ${world.cities.length} cities`,
  };
}
