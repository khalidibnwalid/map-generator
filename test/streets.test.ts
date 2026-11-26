import { expect, test } from "vitest";
import { StreetGraph } from "../src/game/city/streets";

test("a 3x3 grid of streets laid as lines gives 4 blocks; crossings become junctions", () => {
  const g = new StreetGraph(40);
  for (const y of [0, 100, 200]) g.addPolyline([{ x: 0, y }, { x: 200, y }], 8, "street", 10);
  for (const x of [0, 100, 200]) g.addPolyline([{ x, y: 0 }, { x, y: 200 }], 8, "street", 10);
  g.pruneDeadEnds();
  const faces = g.faces();
  expect(faces.length).toBe(4);
  for (const f of faces) expect(f.area).toBeCloseTo(100 * 100, 0);
  // Every crossing is shared: 9 junctions
  expect(g.nodes.length).toBe(9);
});

test("a dead end bounds no block, and a street running into another stops there", () => {
  const g = new StreetGraph(40);
  g.addPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }], 8, "street", 10);
  // A spur into the block
  const a = g.nearNode(100, 0, 1);
  const r = g.extend(a, { x: 100, y: -60 }, 6, "lane", 10);
  expect(r).not.toBeNull();
  // A street from inside heading out crosses the square's side and stops there
  const inside = g.addNode(50, 50);
  const hit = g.extend(inside, { x: 50, y: -80 }, 6, "street", 10)!;
  expect(hit.hit).toBe(true);
  expect(g.nodes[hit.node].y).toBeCloseTo(0, 5);
  g.pruneDeadEnds();
  expect(g.edges.filter((e) => e.dead).length).toBeGreaterThanOrEqual(2);
  expect(g.faces().length).toBe(1);
});
