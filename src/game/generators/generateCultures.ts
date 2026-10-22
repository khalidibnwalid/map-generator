import type { GeneratorContext } from "./types";
import { Language, familyCount, religionName, hslHex } from "../names";
import { growRegions, fillUnreached, pickSpacedSeeds, warpOwnerArray } from "../util/regionGrow";
import { yieldFrame } from "../util/grid";

// Cultures and religions are independent of political borders: they grow from
// their own hearths over the terrain, so a nation can be multi-ethnic and a
// faith can span several states.
export async function generateCultures(ctx: GeneratorContext): Promise<void> {
  const { world, noise, width: W, height: H, onProgress } = ctx;
  const N = W * H;
  const resScale = W / 800;
  let landCells = 0;
  for (let i = 0; i < N; i++) if (world.waterType[i] === 0) landCells++;

  const density = (c: number) => {
    const x = c % W;
    return world.grid[x][(c - x) / W].populationDensity + 0.15;
  };

  // --- Cultures ---
  const cultureCount = Math.max(3, Math.round(landCells / (9000 * resScale * resScale)));
  const cultureSeeds = pickSpacedSeeds(world, noise.random, cultureCount, 55 * resScale, density);
  const cultureOwner = growRegions(
    world,
    noise,
    cultureSeeds.map((cell) => ({ cell, weight: 0.8 + noise.random() * 0.6 })),
    {
      mountainCost: 3,
      slopeCost: 1.5,
      riverCost: 0.3,
      noiseAmp: 0.45,
      noiseScale: 0.012,
      noiseOffset: 3100,
    },
  );
  fillUnreached(world, cultureOwner);
  warpOwnerArray(world, noise, cultureOwner, 7 * resScale);
  onProgress?.(45);
  await yieldFrame();

  world.cultures = [];
  world.languages = [];
  // Neighboring hearths often share a language family
  const families: number[] = [];
  cultureSeeds.forEach((cell, id) => {
    const x = cell % W;
    const y = (cell - x) / W;
    let fam = Math.floor(noise.random() * familyCount);
    // Climate nudges: hot dry hearths lean "Desert", cold ones "Nordic"
    const t = world.grid[x][y].temperature;
    const m = world.grid[x][y].moisture;
    if (t > 0.7 && m < 0.35 && noise.random() < 0.7) fam = 4;
    else if (t < 0.3 && noise.random() < 0.6) fam = 3;
    if (id > 0 && noise.random() < 0.35) fam = families[Math.floor(noise.random() * id)];
    families.push(fam);
    const lang = new Language(noise.random, fam);
    world.languages.push(lang);
    world.cultures.push({
      id,
      name: lang.cultureName(),
      color: hslHex((id * 137.508 + 20) % 360, 0.45, 0.62),
      centerX: x + 0.5,
      centerY: y + 0.5,
    });
  });

  // --- Religions ---
  const religionCount = Math.max(2, Math.min(9, Math.round(cultureCount / 3)));
  const religionSeeds = pickSpacedSeeds(world, noise.random, religionCount, 90 * resScale, density);
  const religionOwner = growRegions(
    world,
    noise,
    religionSeeds.map((cell) => ({ cell, weight: 0.6 + noise.random() * 1.2 })),
    {
      mountainCost: 1.5,
      slopeCost: 0.5,
      riverCost: 0,
      noiseAmp: 0.6,
      noiseScale: 0.008,
      noiseOffset: 7700,
    },
  );
  fillUnreached(world, religionOwner);
  warpOwnerArray(world, noise, religionOwner, 8 * resScale);
  world.religions = religionSeeds.map((cell, id) => {
    const x = cell % W;
    return {
      id,
      name: religionName(noise.random),
      color: hslHex((id * 97 + 200) % 360, 0.55, 0.5),
      centerX: x + 0.5,
      centerY: (cell - x) / W + 0.5,
    };
  });
  onProgress?.(90);
  await yieldFrame();

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      const cell = world.grid[x][y];
      cell.cultureIndex = cultureOwner[i] >= 0 ? cultureOwner[i] : undefined;
      cell.religionIndex = religionOwner[i] >= 0 ? religionOwner[i] : undefined;
    }
  }
  onProgress?.(100);
}
