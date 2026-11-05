import { beforeAll, expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { EditHistory } from "../src/game/EditHistory";
import type { WorldData } from "../src/game/WorldData";
import { fingerprint } from "./fingerprint";

let world: WorldData;
beforeAll(async () => {
  const g = new MapGenerator(400, 225, 2468);
  g.currentPreset = "Earthlike";
  world = await g.generate();
});

function paintBorders(w: WorldData, from: number, to: number) {
  let n = 0;
  for (let x = 0; x < w.width; x++)
    for (let y = 0; y < w.height; y++)
      if (w.grid[x][y].nationIndex === from) {
        w.grid[x][y].nationIndex = to;
        n++;
      }
  return n;
}

test("undo restores the world before an edit and redo replays it", () => {
  const h = new EditHistory(world);
  h.ensureBaseline();
  const original = fingerprint(world);
  const firstNation = world.nations[0];
  const firstCity = world.cities[0];

  // One step: borders, a rename, a removed city and a declared war
  expect(paintBorders(world, 1, 0)).toBeGreaterThan(0);
  world.nations[0].name = "Undoland";
  world.cities.splice(0, 1);
  world.relations[0][2] = world.relations[2][0] = "War";
  const step = h.commit();
  expect(step?.label).toContain("borders");
  expect(step?.label).toContain("cities");
  expect(step?.label).toContain("diplomacy");
  const edited = fingerprint(world);
  expect(edited).not.toEqual(original);

  const undone = h.undo();
  expect(undone?.rows).not.toBeNull();
  expect(fingerprint(world)).toEqual(original);
  // Same objects come back, so state keyed by identity survives
  expect(world.nations[0]).toBe(firstNation);
  expect(world.cities[0]).toBe(firstCity);
  expect(h.canRedo).toBe(true);

  h.redo();
  expect(fingerprint(world)).toEqual(edited);
  expect(world.nations[0]).toBe(firstNation);
  h.undo();
  expect(fingerprint(world)).toEqual(original);
});

test("an interaction that changes nothing records no step", () => {
  const h = new EditHistory(world);
  h.ensureBaseline();
  expect(h.commit()).toBeNull();
  expect(h.canUndo).toBe(false);
});

test("a new edit after undo drops the redo branch", () => {
  const h = new EditHistory(world);
  h.ensureBaseline();
  world.nations[1].name = "First";
  h.commit();
  h.undo();
  world.nations[2].name = "Second";
  h.commit();
  expect(h.canRedo).toBe(false);
  h.undo();
  expect(world.nations[1].name).not.toBe("First");
  expect(world.nations[2].name).not.toBe("Second");
});

test("uncommitted edits are captured before undoing", () => {
  const h = new EditHistory(world);
  h.ensureBaseline();
  const name = world.nations[3].name;
  world.nations[3].name = "Pending";
  h.undo();
  expect(world.nations[3].name).toBe(name);
});
