import { expect, test } from "vitest";
import { area, insetPoly } from "../src/game/city/geom";

test("insetPoly shrinks squares and L-shapes, per edge, and drops collapsed edges", () => {
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const a = insetPoly(sq, 10)!;
  expect(Math.abs(area(a))).toBeCloseTo(80 * 80, 3);
  const b = insetPoly(sq, [0, 10, 20, 30])!;
  expect(Math.abs(area(b))).toBeCloseTo(60 * 80, 3); // x 30..90, y 0..80
  // L-shape (concave)
  const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }];
  const c = insetPoly(L, 5)!;
  expect(c).not.toBeNull();
  expect(Math.abs(area(c))).toBeLessThan(Math.abs(area(L)));
  expect(Math.abs(area(c))).toBeGreaterThan(Math.abs(area(L)) * 0.6);
  // Too much: gone
  expect(insetPoly(sq, 60)).toBeNull();
  // A thin sliver edge collapses but the rest survives
  const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 2 }, { x: 50, y: 60 }];
  expect(insetPoly(tri, 4)).not.toBeNull();
});
