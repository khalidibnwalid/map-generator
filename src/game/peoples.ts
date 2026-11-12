import type { CellData, WorldData } from "./WorldData";

// Cultures and races of a cell. From 0.2 land can be uninhabited (deserts,
// peaks, ice: no culture or race at all), and a cell can hold a second group
// (culture2Index / race2Index) where two peoples live mixed.

// The groups living in a cell, majority first (empty when uninhabited)
export function culturesOf(cell: CellData | null | undefined): number[] {
  if (!cell || cell.cultureIndex === undefined) return [];
  return cell.culture2Index !== undefined && cell.culture2Index !== cell.cultureIndex ? [cell.cultureIndex, cell.culture2Index] : [cell.cultureIndex];
}

export function racesOf(cell: CellData | null | undefined): number[] {
  if (!cell || cell.raceIndex === undefined) return [];
  return cell.race2Index !== undefined && cell.race2Index !== cell.raceIndex ? [cell.raceIndex, cell.race2Index] : [cell.raceIndex];
}

// Field of the nearest cell (by rings around x, y) where it is set: the
// people of empty land are those who live closest to it
function nearest(world: WorldData, x: number, y: number, field: "cultureIndex" | "raceIndex", maxR: number): number | undefined {
  const W = world.width;
  const H = world.height;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const at = (px: number, py: number) => (py < 0 || py >= H ? undefined : world.grid[((px % W) + W) % W][py][field]);
  const here = at(cx, cy);
  // Only empty land looks around; water keeps "nobody" as before
  if (here !== undefined || cy < 0 || cy >= H || world.grid[((cx % W) + W) % W][cy].isWater) return here;
  for (let r = 1; r <= maxR; r++) {
    let best: number | undefined;
    let bestD = Infinity;
    for (let d = -r; d <= r; d++) {
      for (const [px, py] of [[cx + d, cy - r], [cx + d, cy + r], [cx - r, cy + d], [cx + r, cy + d]]) {
        const v = at(px, py);
        if (v === undefined) continue;
        const dd = (px - cx) ** 2 + (py - cy) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = v;
        }
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

// Culture of a land cell, or of the nearest inhabited land when it is empty
// (undefined on water, or when nobody lives within reach)
export function cultureNear(world: WorldData, x: number, y: number, maxR = 96): number | undefined {
  return nearest(world, x, y, "cultureIndex", maxR);
}

export function raceNear(world: WorldData, x: number, y: number, maxR = 96): number | undefined {
  return nearest(world, x, y, "raceIndex", maxR);
}
