import { expect, test } from "vitest";
import { recipeFromLocation, recipeFromQuery, recipeToQuery, type WorldRecipe } from "../src/game/WorldLink";
import { DEFAULT_SETTINGS } from "../src/game/generators/types";

const base: WorldRecipe = { seed: 982332, preset: "Earthlike", width: 800, height: 450, greatPowers: 1, settings: { ...DEFAULT_SETTINGS }, version: "0.1" };

test("a default 0.1 world makes a short link", () => {
  expect(recipeToQuery(base)).toBe("?seed=982332&land=medium");
});

test("links from before versions open as 0.1 worlds", () => {
  expect(recipeFromQuery("?seed=982332&land=medium")).toEqual({ ...base, politicsSeed: undefined });
});

test("older #hash links still open, and the query wins over them", () => {
  expect(recipeFromLocation("", "#seed=982332&land=medium")).toEqual({ ...base, politicsSeed: undefined });
  expect(recipeFromLocation("?seed=5&land=medium", "#seed=982332&land=medium")?.seed).toBe(5);
  expect(recipeFromLocation("", "")).toBeNull();
});

test("0.2 links carry their version and politics seed", () => {
  const r: WorldRecipe = { ...base, version: "0.2", politicsSeed: 123456 };
  expect(recipeToQuery(r)).toBe("?v=0.2&seed=982332&pol=123456&land=medium");
  expect(recipeFromQuery(recipeToQuery(r))).toEqual(r);
});

test("every option survives the round trip", () => {
  const r: WorldRecipe = {
    seed: 7,
    preset: "Pangea",
    width: 1600,
    height: 900,
    greatPowers: 3,
    settings: { seaLevel: 0.52, mountains: 1.35, climate: -0.1, rainfall: 0.07, settlements: 0.6, nations: 40 },
    version: "0.2",
    politicsSeed: 99,
  };
  expect(recipeFromQuery(recipeToQuery(r))).toEqual(r);
});

test("links that are not worlds are ignored", () => {
  for (const h of ["", "?", "#", "#about", "?seed=abc", "?seed=1&land=moon", "?seed=1&size=10x10", "?seed=-4", "?utm_source=x"]) expect(recipeFromQuery(h)).toBeNull();
});
