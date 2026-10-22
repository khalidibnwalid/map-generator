import { makeVassal } from "../politics";
import type { GeneratorContext } from "./types";
import type { RelationType, WorldData } from "../WorldData";

// Counts shared land-border cells between every pair of nations.
export function borderMatrix(world: WorldData): number[][] {
  const n = world.nations.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  const W = world.width;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      if (c.isWater || c.nationIndex === undefined || c.nationIndex < 0) continue;
      const a = c.nationIndex;
      const right = world.grid[(x + 1) % W][y];
      const down = y + 1 < world.height ? world.grid[x][y + 1] : null;
      for (const nb of [right, down]) {
        if (!nb || nb.isWater) continue;
        const b = nb.nationIndex ?? -1;
        if (b >= 0 && b !== a && a < n && b < n) {
          m[a][b]++;
          m[b][a]++;
        }
      }
    }
  }
  return m;
}

// Relations come from shared culture/faith (affinity) vs. long contested
// borders and size imbalance (tension), with a dash of history (randomness).
export async function generateDiplomacy(ctx: GeneratorContext): Promise<void> {
  const { world, noise } = ctx;
  const n = world.nations.length;
  const border = borderMatrix(world);
  const area = new Array(n).fill(0);
  const coastal: boolean[] = new Array(n).fill(false);
  for (let x = 0; x < world.width; x++) {
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      const id = c.nationIndex ?? -1;
      if (id < 0 || id >= n) continue;
      if (c.isWater) coastal[id] = true;
      else area[id]++;
    }
  }
  const maxArea = Math.max(1, ...area);
  // The largest realms gather vassals among their small neighbors
  const bigRank = [...area.keys()].sort((p, q) => area[q] - area[p]);
  const isBig = new Set(bigRank.slice(0, Math.max(2, Math.round(n * 0.08))));

  for (const nation of world.nations) {
    const lang = world.languages[nation.cultureId ?? 0];
    const size = Math.sqrt(area[nation.id] / maxArea);
    nation.government = lang ? lang.government(size, coastal[nation.id]) : "Kingdom";
  }

  const bonds: { v: number; o: number }[] = []; // vassal candidates
  const rel: RelationType[][] = Array.from({ length: n }, () =>
    new Array<RelationType>(n).fill("Neutral"),
  );
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const A = world.nations[a];
      const B = world.nations[b];
      const neighbors = border[a][b] > 0;
      let score = (noise.random() - 0.5) * 1.2;
      if (A.cultureId === B.cultureId) score += 0.5;
      if (A.religionId === B.religionId) score += 0.45;
      else score -= 0.25;
      if (neighbors) score -= Math.min(0.9, border[a][b] / 60);

      let r: RelationType = "Neutral";
      if (!neighbors) {
        if (score > 0.75) r = "Alliance";
        else if (score > 0.35) r = "Friendly";
        else if (score < -0.7) r = "Rival";
      } else {
        const ratio = area[a] / Math.max(1, area[b]);
        const bigger = ratio > 1 ? a : b;
        let vassalChance = A.cultureId === B.cultureId ? 0.5 : 0.25;
        if (isBig.has(bigger)) vassalChance += 0.3;
        if ((ratio > 2.5 || ratio < 0.4) && score > -0.45 && noise.random() < vassalChance) {
          bonds.push(ratio > 1 ? { v: b, o: a } : { v: a, o: b });
          r = "Friendly";
        } else if (score < -0.75) r = "War";
        else if (score < -0.3) r = "Rival";
        else if (score > 0.7) r = "Alliance";
        else if (score > 0.3) r = "Friendly";
      }
      rel[a][b] = r;
      rel[b][a] = r;
    }
  }
  world.relations = rel;

  // Vassal bonds go through makeVassal: overlord link, paler color, shared
  // highlight. One overlord per vassal and no chains of vassals.
  for (let i = bonds.length - 1; i > 0; i--) {
    const j = Math.floor(noise.random() * (i + 1));
    [bonds[i], bonds[j]] = [bonds[j], bonds[i]];
  }
  const isOverlord = new Set<number>();
  for (const { v, o } of bonds) {
    if (world.nations[v].overlord !== undefined || world.nations[o].overlord !== undefined || isOverlord.has(v)) continue;
    makeVassal(world, v, o);
    isOverlord.add(o);
  }
}

export const RELATION_COLORS: Record<RelationType, string> = {
  Alliance: "#3f8fd8",
  Friendly: "#6cc28a",
  Neutral: "#b9b4a6",
  Rival: "#e3a03c",
  War: "#d8433a",
  Vassal: "#9a6bd1",
  Overlord: "#5b3c96",
};
