import { expect, test } from "vitest";
import { recipeFromHash, recipeToHash, type WorldRecipe } from "../src/game/WorldLink";
import { DEFAULT_SETTINGS } from "../src/game/generators/types";

const base: WorldRecipe = { seed: 982332, preset: "Earthlike", width: 800, height: 450, greatPowers: 1, settings: { ...DEFAULT_SETTINGS } };

test("a default world makes a short link", () => {
  expect(recipeToHash(base)).toBe("#seed=982332&land=medium");
});

test("every option survives the round trip", () => {
  const r: WorldRecipe = {
    seed: 7,
    preset: "Pangea",
    width: 1600,
    height: 900,
    greatPowers: 3,
    settings: { seaLevel: 0.52, mountains: 1.35, climate: -0.1, rainfall: 0.07, settlements: 0.6, nations: 40 },
  };
  expect(recipeFromHash(recipeToHash(r))).toEqual(r);
});

test("links that are not worlds are ignored", () => {
  for (const h of ["", "#", "#about", "#seed=abc", "#seed=1&land=moon", "#seed=1&size=10x10", "#seed=-4"]) expect(recipeFromHash(h)).toBeNull();
});
