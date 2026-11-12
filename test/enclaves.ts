import type { WorldData } from "../src/game/WorldData";
import { labelComponents } from "../src/game/util/grid";

// Patches of each culture (or race) beyond its largest one, and those of
// them that are enclaves: every land cell around them belongs to another
// people (no coast, no empty land on the rim).
export function patchStats(world: WorldData, field: "cultureIndex" | "raceIndex", minSize = 4) {
  const W = world.width;
  const H = world.height;
  const count = field === "cultureIndex" ? world.cultures.length : world.races.length;
  const groups: { id: number; patches: number; enclaves: number[] }[] = [];
  for (let id = 0; id < count; id++) {
    const mask = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (world.grid[x][y][field] === id) mask[y * W + x] = 1;
    const { labels, sizes } = labelComponents(W, H, mask);
    if (!sizes.length) continue;
    const largest = sizes.indexOf(Math.max(...sizes));
    const enclosed = sizes.map(() => true);
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        const n = world.grid[(x + dx + W) % W][ny];
        if (n.isWater || n[field] === undefined) enclosed[labels[i]] = false;
      }
    }
    const small = sizes.map((_s, k) => k).filter((k) => k !== largest && sizes[k] >= minSize);
    groups.push({ id, patches: small.length + 1, enclaves: small.filter((k) => enclosed[k]).map((k) => sizes[k]) });
  }
  return {
    fragmented: groups.filter((g) => g.patches > 1).length,
    enclaves: groups.reduce((a, g) => a + g.enclaves.length, 0),
    sizes: groups.flatMap((g) => g.enclaves).sort((a, b) => a - b),
  };
}
