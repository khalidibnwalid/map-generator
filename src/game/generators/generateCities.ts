import type { GeneratorContext } from "./types";
import type { City, WorldData } from "../WorldData";
import { hashU } from "../../core/FieldNoise";
import { yieldFrame } from "../util/grid";

// Built-up density of a pre-industrial core, people per km²
const CORE_DENSITY = 16000;

export function cityRadiusM(population: number): number {
  // Past ~120k people cities grow denser rather than wider (keeps layouts cheap)
  const p = population <= 120000 ? population : 120000 * Math.sqrt(population / 120000);
  return Math.max(110, 1000 * Math.sqrt(p / CORE_DENSITY / Math.PI));
}

// Sets a settlement's population; its tier and built-up size follow
export function setCityPopulation(city: City, population: number) {
  city.population = Math.max(50, Math.round(population));
  city.size = city.population >= 60000 ? 2 : city.population >= 5000 ? 1 : 0;
  city.radiusM = cityRadiusM(city.population);
}

// Fills in population/radius/port flags for a city placed at (x, y).
export function finalizeCity(world: WorldData, city: City, density: number) {
  const r = hashU(Math.floor(city.x * 16), Math.floor(city.y * 16), world.seed);
  let pop: number;
  // Settlement hierarchy follows how settled the land is: hamlets of a few
  // hundred in sparse country, market towns of thousands in farmed land
  const d = Math.max(0, density);
  if (city.size >= 2) pop = 45000 + 150000 * Math.pow(d, 1.2) * (0.6 + r);
  else if (city.size === 1) pop = 5000 + 30000 * Math.pow(d, 1.3) * (0.5 + r);
  else pop = 250 + 9000 * Math.pow(d, 1.6) * (0.5 + r);
  if (city.isCapital) pop *= 1.8;

  const sampler = world.sampler;
  let nearSea = false;
  for (let a = 0; a < 8 && !nearSea; a++) {
    const ang = (a / 8) * Math.PI * 2;
    if (sampler.coastField(city.x + Math.cos(ang) * 0.6, city.y + Math.sin(ang) * 0.6, 4) < 0)
      nearSea = true;
  }
  const cell = world.getCell(city.x, city.y);
  if (nearSea) pop *= 1.25;
  if (cell?.hasRiver) pop *= 1.15;

  city.population = Math.round(pop);
  city.radiusM = cityRadiusM(city.population);
  city.isPort = nearSea;
  city.seed = (hashU(city.id + 1, Math.floor(city.x * 97), world.seed) * 4294967296) >>> 0;
}

export function cityNameFor(world: WorldData, x: number, y: number, rand: () => number): string {
  const cell = world.getCell(x, y);
  const lang = world.languages[cell?.cultureIndex ?? 0];
  if (lang) return lang.townName();
  return `Settlement ${Math.floor(rand() * 1000)}`;
}

export async function generateCities(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width, height, onProgress } = ctx;
  world.cities = [];

  // Bucket land cells by nation in a single pass
  const byNation: { x: number; y: number; density: number }[][] = world.nations.map(() => []);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      const n = cell.nationIndex ?? -1;
      if (cell.isWater || n < 0 || n >= byNation.length) continue;
      byNation[n].push({ x, y, density: cell.populationDensity });
    }
  }

  // Capitals sit on the most populous spot of each nation
  for (const nation of world.nations) {
    const cells = byNation[nation.id];
    let best = { x: nation.capitalX, y: nation.capitalY, density: -1 };
    for (const c of cells) if (c.density > best.density) best = c;
    nation.capitalX = best.x + 0.5;
    nation.capitalY = best.y + 0.5;
    const city: City = {
      id: world.cities.length,
      name: cityNameFor(world, best.x, best.y, noise.random),
      x: best.x + 0.5,
      y: best.y + 0.5,
      nationIndex: nation.id,
      isCapital: true,
      size: 2,
      population: 0,
      radiusM: 0,
      seed: 0,
    };
    finalizeCity(world, city, Math.max(0, best.density));
    world.cities.push(city);
  }

  const resScale = width / 800;
  const minCityDist = 12 * resScale; // towns & cities
  const minVillageDist = 3.2 * resScale; // hamlets and villages
  const W = width;
  // Spatial hash for the spacing check
  const bucket = Math.ceil(minCityDist);
  const bucketsX = Math.ceil(W / bucket);
  const grid = new Map<number, City[]>();
  const addToGrid = (c: City) => {
    const key = Math.floor(c.y / bucket) * bucketsX + (Math.floor(c.x / bucket) % bucketsX);
    const list = grid.get(key) ?? [];
    list.push(c);
    grid.set(key, list);
  };
  world.cities.forEach(addToGrid);
  const tooClose = (x: number, y: number, minD: number = minCityDist) => {
    const bx = Math.floor(x / bucket);
    const by = Math.floor(y / bucket);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const key = (by + oy) * bucketsX + ((bx + ox + bucketsX) % bucketsX);
        for (const c of grid.get(key) ?? []) {
          let dx = Math.abs(x - c.x);
          if (dx > W / 2) dx = W - dx;
          if (Math.hypot(dx, y - c.y) < minD) return true;
        }
      }
    }
    return false;
  };

  const totalNations = world.nations.length;
  for (let i = 0; i < totalNations; i++) {
    const nation = world.nations[i];
    if (i % 4 === 0) {
      onProgress?.((i / totalNations) * 100);
      await yieldFrame();
    }

    const validCells = byNation[i];
    // Sort by density descending to check the hot spots first
    validCells.sort((a, b) => b.density - a.density);

    let placed = 1; // 1 for capital
    const maxCitiesPerNation = 300;

    for (const cell of validCells) {
      if (placed >= maxCitiesPerNation) break;

      let chance = 0;
      if (cell.density >= 0.8) chance = 1.0;
      else if (cell.density >= 0.6) chance = 0.2;
      else if (cell.density >= 0.4) chance = 0.012;
      else if (cell.density >= 0.2) chance = 0.0012;
      else chance = 0.0001;

      if (noise.random() >= chance) continue;
      const cx = cell.x + 0.5;
      const cy = cell.y + 0.5;
      if (tooClose(cx, cy)) continue;

      const size = cell.density >= 0.85 && noise.random() < 0.5 ? 2 : cell.density >= 0.62 ? 1 : 0;
      const city: City = {
        id: world.cities.length,
        name: cityNameFor(world, cell.x, cell.y, noise.random),
        x: cx,
        y: cy,
        nationIndex: nation.id,
        isCapital: false,
        size,
        population: 0,
        radiusM: 0,
        seed: 0,
      };
      finalizeCity(world, city, cell.density);
      world.cities.push(city);
      addToGrid(city);
      placed++;
    }

    // Villages and hamlets fill the countryside, thicker where land is fertile
    for (const cell of validCells) {
      if (noise.random() >= 0.07 * Math.pow(cell.density + 0.05, 1.2)) continue;
      const cx = cell.x + 0.2 + noise.random() * 0.6;
      const cy = cell.y + 0.2 + noise.random() * 0.6;
      if (world.sampler.coastField(cx, cy, 6) < 0.08) continue;
      if (tooClose(cx, cy, minVillageDist)) continue;
      const city: City = {
        id: world.cities.length,
        name: cityNameFor(world, cell.x, cell.y, noise.random),
        x: cx,
        y: cy,
        nationIndex: nation.id,
        isCapital: false,
        size: 0,
        population: 0,
        radiusM: 0,
        seed: 0,
      };
      finalizeCity(world, city, cell.density * 0.35);
      world.cities.push(city);
      addToGrid(city);
    }
  }
}
