import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { appendNation, claimFoundingLand } from "../src/game/politics";

// A realm founded in the editor spreads over the land like an offensive: one
// connected piece of land, no water, and never another realm's capital
test("a founded realm claims connected land around its spot", async () => {
  const g = new MapGenerator(400, 225, 2468);
  g.pin("0.1");
  const world = await g.generate();
  const W = world.width;
  // A land cell inside some realm, away from its capital
  const host = world.nations[0];
  let sx = -1;
  let sy = -1;
  for (let y = 0; y < world.height && sx < 0; y++)
    for (let x = 0; x < W; x++) {
      const c = world.grid[x][y];
      if (!c.isWater && c.nationIndex === 0 && Math.hypot(x - host.capitalX, y - host.capitalY) > 15) {
        sx = x;
        sy = y;
        break;
      }
    }
  expect(sx).toBeGreaterThanOrEqual(0);
  const idx = appendNation(world, { id: 0, name: "Testland", color: "#888888", capitalX: sx, capitalY: sy });
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const taken = claimFoundingLand(world, idx, sx, sy, rand);
  expect(taken).toBeGreaterThan(20);

  const mine: number[] = [];
  for (let x = 0; x < W; x++)
    for (let y = 0; y < world.height; y++) {
      const c = world.grid[x][y];
      if (c.nationIndex !== idx) continue;
      expect(c.isWater).toBe(false);
      mine.push(y * W + x);
    }
  expect(mine.length).toBe(taken);
  for (const [i, n] of world.nations.entries()) {
    if (i === idx) continue;
    expect(world.getCell(Math.floor(n.capitalX), Math.floor(n.capitalY))?.nationIndex).not.toBe(idx);
  }
  // One connected piece (4-neighbors, x wraps)
  const set = new Set(mine);
  const seen = new Set([mine[0]]);
  const stack = [mine[0]];
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % W;
    const y = (c - x) / W;
    for (const j of [y * W + ((x + 1) % W), y * W + ((x - 1 + W) % W), c - W, c + W])
      if (set.has(j) && !seen.has(j)) {
        seen.add(j);
        stack.push(j);
      }
  }
  expect(seen.size).toBe(mine.length);
});
