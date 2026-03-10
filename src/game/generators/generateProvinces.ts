import type { GeneratorContext } from "./types";
import type { Province, City } from "../WorldData";

export async function generateProvinces(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width, height, onProgress } = ctx;
  world.provinces = [];

  // 1. Group land cells by nation
  const nationCells: Map<number, { x: number; y: number }[]> = new Map();
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      if (cell.nationIndex === undefined || cell.nationIndex < 0) continue;

      const list = nationCells.get(cell.nationIndex) || [];
      list.push({ x, y });
      nationCells.set(cell.nationIndex, list);
    }
  }

  // 2. Seed provinces based on nation area
  // Target roughly 1 province per ~1200 land cells, but at least 1 per nation
  const CELLS_PER_PROVINCE = 1200;

  for (const [nationId, cells] of nationCells.entries()) {
    const nation = world.nations[nationId];
    if (!nation) continue;

    const targetCount = Math.max(
      1,
      Math.round(cells.length / CELLS_PER_PROVINCE),
    );
    const nationSeeds: { x: number; y: number }[] = [];

    // Use nation cities as primary seeds
    const nationCities = world.cities.filter(
      (c: City) => c.nationIndex === nationId,
    );
    for (const city of nationCities) {
      if (nationSeeds.length < targetCount) {
        nationSeeds.push({ x: city.x, y: city.y });
      }
    }

    // If we need more seeds, pick random land cells deep in the interior
    const shuffledCells = [...cells].sort(() => Math.random() - 0.5);
    for (const cell of shuffledCells) {
      if (nationSeeds.length >= targetCount) break;

      // Basic Poisson-ish check: don't seed too close to existing seeds
      const tooClose = nationSeeds.some(
        (s) => Math.hypot(s.x - cell.x, s.y - cell.y) < 20,
      );
      if (!tooClose) {
        nationSeeds.push(cell);
      }
    }

    // Create province objects
    for (let i = 0; i < nationSeeds.length; i++) {
      const seed = nationSeeds[i];
      const province: Province = {
        id: world.provinces.length,
        name: `${nation.name} ${i + 1}`,
        color: nation.color,
        nationIndex: nationId,
        capitalCityId: -1, // Will assign below
      };
      // Reuse seed as a temporary position for assignment
      (province as any)._seedX = seed.x;
      (province as any)._seedY = seed.y;
      world.provinces.push(province);
    }
  }

  // 3. Assign cells to provinces
  const invResScale = 800 / width;
  for (let x = 0; x < width; x++) {
    if (x % 50 === 0) {
      onProgress?.((x / width) * 100);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let y = 0; y < height; y++) {
      const cell = world.grid[x][y];
      if (cell.nationIndex === undefined || cell.nationIndex < 0) {
        cell.provinceIndex = undefined;
        continue;
      }

      const nationId = cell.nationIndex;
      const nationProvinces = world.provinces.filter(
        (p: Province) => p.nationIndex === nationId,
      );
      if (nationProvinces.length === 0) continue;

      let minScore = Infinity;
      let closestProvince = -1;

      // Noise for natural boundaries
      const noiseScale = 0.04 * invResScale;
      const noiseStrength = 10 * (width / 800);
      const nx =
        noise.fbmCylinder(x, y, width, 2, 0.5, 2.0, noiseScale) * noiseStrength;
      const ny =
        noise.fbmCylinder(x + 500, y + 500, width, 2, 0.5, 2.0, noiseScale) *
        noiseStrength;

      const px = x + nx;
      const py = y + ny;

      for (const prop of nationProvinces) {
        const seedX = (prop as any)._seedX;
        const seedY = (prop as any)._seedY;

        let dx = Math.abs(px - seedX);
        if (dx > width / 2) dx = width - dx;
        const dy = py - seedY;
        const distSq = dx * dx + dy * dy;

        if (distSq < minScore) {
          minScore = distSq;
          closestProvince = prop.id;
        }
      }

      cell.provinceIndex = closestProvince;
    }
  }

  // 4. Finalize province metadata
  for (const city of world.cities) {
    const cell = world.grid[Math.floor(city.x)][Math.floor(city.y)];
    if (cell && cell.provinceIndex !== undefined) {
      city.provinceIndex = cell.provinceIndex;
    }
  }

  // Cleanup temporary properties
  for (const p of world.provinces) {
    delete (p as any)._seedX;
    delete (p as any)._seedY;
  }
}
