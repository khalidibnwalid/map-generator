import { beforeEach, expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { EditHistory } from "../src/game/EditHistory";
import { loadWorld, saveWorld } from "../src/game/WorldFile";
import { buildGameExport } from "../src/game/export/GameExport";
import { makeVassal, removeNation } from "../src/game/politics";
import { createCoalition, dissolveCoalition, formCoalition, joinCoalition, leaveCoalition, membersOf, pruneCoalitions, coalitionsOf } from "../src/game/coalitions";
import type { WorldData } from "../src/game/WorldData";

let g: MapGenerator;
let world: WorldData;
beforeEach(async () => {
  g = new MapGenerator(400, 225, 13579);
  g.currentPreset = "Earthlike";
  g.pin("0.1");
  world = await g.generate();
});

// Independent realms to unite
const free = (w: WorldData) => w.nations.map((n, i) => (n.overlord === undefined ? i : -1)).filter((i) => i >= 0);
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

test("0.1 worlds are generated without coalitions", () => {
  expect(world.coalitions).toEqual([]);
  expect(world.nations.some((n) => n.coalitions)).toBe(false);
});

test("form, join and leave", () => {
  const [a, b, c, d, e] = free(world);
  expect(e).toBeDefined();
  const u = formCoalition(world, a, b)!;
  expect(u.name).toMatch(new RegExp(world.nations[a].name));
  expect(membersOf(world, u.id)).toEqual(sorted([a, b]));
  expect(coalitionsOf(world, a)).toEqual([u]);

  expect(joinCoalition(world, c, u.id)).toBe(u);
  expect(membersOf(world, u.id)).toHaveLength(3);

  const v = formCoalition(world, d, e)!;
  expect(v.id).not.toBe(u.id);
  expect(v.color).not.toBe(u.color);

  leaveCoalition(world, c, u.id);
  expect(coalitionsOf(world, c)).toEqual([]);
  expect(world.nations[c].coalitions).toBeUndefined();
  expect(membersOf(world, u.id)).toHaveLength(2);
  // Down to one member: the coalition dissolves
  leaveCoalition(world, b, u.id);
  expect(world.coalitions).toEqual([v]);
  expect(world.nations[a].coalitions).toBeUndefined();
});

test("a realm can be in several coalitions", () => {
  const [a, b, c, d] = free(world);
  const u = formCoalition(world, a, b)!;
  // Forming with a member founds a new coalition rather than joining its
  const v = formCoalition(world, a, c)!;
  expect(v.id).not.toBe(u.id);
  expect(coalitionsOf(world, a)).toEqual([u, v]);
  // Joining keeps the other memberships
  joinCoalition(world, b, v.id);
  joinCoalition(world, d, u.id);
  expect(membersOf(world, u.id)).toEqual(sorted([a, b, d]));
  expect(membersOf(world, v.id)).toEqual(sorted([a, b, c]));
  expect(joinCoalition(world, b, v.id)).toBe(v); // already in: no duplicate
  expect(world.nations[b].coalitions).toEqual([u.id, v.id]);

  // Pruning one coalition leaves the other
  leaveCoalition(world, b, u.id);
  leaveCoalition(world, d, u.id);
  expect(world.coalitions).toEqual([v]);
  expect(coalitionsOf(world, a)).toEqual([v]);
  dissolveCoalition(world, v.id);
  expect(world.coalitions).toEqual([]);
  expect(world.nations.some((n) => n.coalitions)).toBe(false);
});

test("createCoalition needs two independent realms", () => {
  const [a, b, c] = free(world);
  makeVassal(world, c, a);
  expect(createCoalition(world, [a, c])).toBeNull();
  expect(createCoalition(world, [a, a])).toBeNull();
  const u = createCoalition(world, [a, b, c], "Crowns", "#123456")!;
  expect(u).toMatchObject({ name: "Crowns", color: "#123456" });
  expect(membersOf(world, u.id)).toEqual(sorted([a, b]));
});

test("vassals can't join and leave every coalition when vassalized", () => {
  const [a, b, c, d] = free(world);
  makeVassal(world, c, a);
  expect(formCoalition(world, a, c)).toBeNull();
  const u = createCoalition(world, [a, b, d])!;
  const v = formCoalition(world, b, d)!;
  makeVassal(world, b, a);
  expect(world.nations[b].coalitions).toBeUndefined();
  expect(membersOf(world, u.id)).toHaveLength(2);
  // v is down to d alone and dissolves
  expect(world.coalitions).toEqual([u]);
  expect(v.id).not.toBe(u.id);
});

test("removing nations keeps membership on the right realms", () => {
  const [a, b, c] = free(world).slice(-3);
  const u = createCoalition(world, [a, b, c])!;
  const v = formCoalition(world, a, b)!;
  const names = [a, b, c].map((i) => world.nations[i].name);
  const at = (name: string) => world.nations.findIndex((n) => n.name === name);
  // An unrelated nation before them: indices shift, membership follows
  removeNation(world, 0);
  expect(membersOf(world, u.id).map((i) => world.nations[i].name).sort()).toEqual([...names].sort());
  expect(coalitionsOf(world, at(names[0]))).toEqual([u, v]);
  // A member of both goes: u keeps two members, v dissolves
  removeNation(world, at(names[0]));
  expect(world.coalitions).toEqual([u]);
  expect(membersOf(world, u.id)).toHaveLength(2);
  expect(coalitionsOf(world, at(names[1]))).toEqual([u]);
  // Another: u dissolves too
  removeNation(world, at(names[1]));
  expect(world.coalitions).toEqual([]);
  expect(world.nations.some((n) => n.coalitions)).toBe(false);
});

test("pruneCoalitions drops dangling memberships", () => {
  const [a, b, c] = free(world);
  const u = formCoalition(world, a, b)!;
  world.nations[c].coalitions = [99];
  world.nations[a].coalitions = [u.id, 99, u.id];
  pruneCoalitions(world);
  expect(world.nations[c].coalitions).toBeUndefined();
  expect(world.nations[a].coalitions).toEqual([u.id]);
  expect(world.coalitions).toHaveLength(1);
});

test("coalition edits undo and redo", () => {
  const [a, b, c] = free(world);
  const h = new EditHistory(world);
  h.ensureBaseline();
  const u = formCoalition(world, a, b)!;
  const step = h.commit();
  expect(step?.label).toContain("coalitions");
  u.name = "Renamed Coalition";
  formCoalition(world, a, c);
  h.commit();

  h.undo();
  expect(world.coalitions).toEqual([u]);
  expect(u.name).not.toBe("Renamed Coalition");
  h.undo();
  expect(world.coalitions).toEqual([]);
  expect(world.nations[a].coalitions).toBeUndefined();
  h.redo();
  h.redo();
  expect(world.coalitions).toHaveLength(2);
  expect(world.coalitions[0]).toBe(u); // restored in place
  expect(u.name).toBe("Renamed Coalition");
  expect(coalitionsOf(world, a)).toHaveLength(2);
});

test("coalitions survive saving and reopening, and reach the game export", async () => {
  const [a, b, c] = free(world);
  const u = formCoalition(world, a, b, "Crowns of Proof")!;
  const v = formCoalition(world, c, a)!;
  const blob = await saveWorld(g);
  const reopened = await loadWorld(blob, new MapGenerator(10, 10, 1));
  // Saving trims floats (flag emblem sizes) to 3 decimals; compare like with like
  const trim = <T>(x: T): T => JSON.parse(JSON.stringify(x, (_k, n) => (typeof n === "number" && !Number.isInteger(n) ? Math.round(n * 1000) / 1000 : n)));
  expect(reopened.coalitions).toEqual(trim([u, v]));
  expect(reopened.coalitions[0].flag).toBeDefined();
  expect(membersOf(reopened, u.id)).toEqual(membersOf(world, u.id));
  expect(reopened.nations[a].coalitions).toEqual([u.id, v.id]);

  const data = JSON.parse(buildGameExport(g).json);
  expect(data.nations[a].coalitions).toEqual([u.id, v.id]);
  expect(data.coalitions.map((x: { members: number[] }) => x.members)).toEqual([membersOf(world, u.id), membersOf(world, v.id)]);

  // Without coalitions the file has none to carry
  dissolveCoalition(world, u.id);
  dissolveCoalition(world, v.id);
  const again = await loadWorld(await saveWorld(g), new MapGenerator(10, 10, 1));
  expect(again.coalitions).toEqual([]);
});

// 0.2 worlds found coalitions among their realms
async function world02(politicsSeed: number) {
  const gen = new MapGenerator(400, 225, 13579);
  gen.currentPreset = "Earthlike";
  gen.pin("0.2", politicsSeed);
  return { gen, w: await gen.generate() };
}

test("0.2 worlds generate plausible coalitions, the same for the same politics seed", async () => {
  // Some worlds have none; one of a few politics seeds will have some
  let found: Awaited<ReturnType<typeof world02>> | null = null;
  for (const seed of [123, 456, 789, 1011, 1213]) {
    const r = await world02(seed);
    if (r.w.coalitions.length) {
      found = r;
      break;
    }
  }
  expect(found).not.toBeNull();
  const { gen, w } = found!;
  const ids = new Set(w.coalitions.map((c) => c.id));
  expect(ids.size).toBe(w.coalitions.length);
  for (const c of w.coalitions) {
    const members = membersOf(w, c.id);
    expect(members.length).toBeGreaterThanOrEqual(2);
    expect(members.length).toBeLessThanOrEqual(4);
    expect(c.name).not.toMatch(/union/i);
    expect(c.flag).toBeDefined();
    for (const m of members) {
      expect(w.nations[m].overlord).toBeUndefined();
      for (const o of members) if (o !== m) expect(["War", "Rival"]).not.toContain(w.relations[m][o]);
    }
  }
  for (const n of w.nations) for (const id of n.coalitions ?? []) expect(ids.has(id)).toBe(true);

  // Same seeds, same coalitions
  const again = await world02(gen.politicsSeed);
  expect(again.w.coalitions).toEqual(w.coalitions);
  expect(again.w.nations.map((n) => n.coalitions)).toEqual(w.nations.map((n) => n.coalitions));

  // A saved file brings back its own coalitions, not a second set
  const reopened = await loadWorld(await saveWorld(gen), new MapGenerator(10, 10, 1));
  expect(reopened.coalitions.map((c) => c.name)).toEqual(w.coalitions.map((c) => c.name));
  expect(reopened.nations.map((n) => n.coalitions)).toEqual(w.nations.map((n) => n.coalitions));
  // ...and none when the user dissolved them all
  for (const c of [...w.coalitions]) dissolveCoalition(w, c.id);
  const cleared = await loadWorld(await saveWorld(gen), new MapGenerator(10, 10, 1));
  expect(cleared.coalitions).toEqual([]);
  expect(cleared.nations.some((n) => n.coalitions)).toBe(false);
});
