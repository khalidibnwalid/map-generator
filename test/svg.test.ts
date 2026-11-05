import { beforeAll, expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import type { WorldData } from "../src/game/WorldData";
import { buildSvg, smooth, traceBorders } from "../src/game/export/SvgExport";

let world: WorldData;
beforeAll(async () => {
  const g = new MapGenerator(400, 225, 1357);
  g.currentPreset = "Earthlike";
  world = await g.generate();
});

test("border chains cover every edge between differently owned land", () => {
  const W = world.width;
  const owner = (x: number, y: number) => {
    const c = world.grid[(x + W) % W][y];
    return c.isWater ? -2 : (c.nationIndex ?? -1);
  };
  let edges = 0;
  for (let y = 0; y < world.height; y++)
    for (let x = 0; x < W; x++) {
      const o = owner(x, y);
      if (o === -2) continue;
      const e = owner(x + 1, y);
      if (e !== -2 && e !== o) edges++;
      if (y + 1 < world.height) {
        const s = owner(x, y + 1);
        if (s !== -2 && s !== o) edges++;
      }
    }
  const lines = traceBorders(world);
  const segs = lines.reduce((n, l) => n + l.length - 1, 0);
  expect(edges).toBeGreaterThan(0);
  expect(segs).toBe(edges);
  // Each step is one cell edge long
  for (const l of lines) for (let i = 1; i < l.length; i++) expect(Math.abs(l[i].x - l[i - 1].x) + Math.abs(l[i].y - l[i - 1].y)).toBe(1);
});

test("smoothing keeps the ends where borders meet", () => {
  const p = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ];
  const s = smooth(p);
  expect(s[0]).toEqual(p[0]);
  expect(s.at(-1)).toEqual(p.at(-1));
});

test("the SVG has every layer and no broken numbers", () => {
  const svg = buildSvg(world, { terrain: "data:image/png;base64,AA==", realms: "data:image/png;base64,AA==" }, "Test & <world>");
  for (const id of ["terrain", "realms", "rivers", "sea-routes", "roads", "borders", "settlements", "town-labels", "realm-labels"]) expect(svg).toContain(`id="${id}"`);
  expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  expect(svg).toContain("Test &amp; &lt;world&gt;");
  const open = (svg.match(/<g[\s>]/g) ?? []).length;
  expect((svg.match(/<\/g>/g) ?? []).length).toBe(open);
});
