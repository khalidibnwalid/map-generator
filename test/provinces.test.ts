import { describe, expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { loadWorld, saveWorld } from "../src/game/WorldFile";
import { EditHistory } from "../src/game/EditHistory";
import { PROVINCE_TYPES, assignProvinceTypes, refreshProvinceTypes, setProvinceType } from "../src/game/provinceTypes";
import type { WorldData } from "../src/game/WorldData";

// Province types: capital districts, autonomous regions, marches, territories
// and colonies, generated for 0.2 worlds and carried by .world files

async function generate(version: string, politicsSeed?: number) {
  const g = new MapGenerator(400, 225, 4242);
  g.currentPreset = "Earthlike";
  g.pin(version, politicsSeed);
  return { g, world: await g.generate() };
}

const counts = (world: WorldData) => {
  const m = new Map<string, number>();
  for (const p of world.provinces) m.set(p.type ?? "province", (m.get(p.type ?? "province") ?? 0) + 1);
  return m;
};

describe("province types", () => {
  test("a 0.2 world has one capital district per realm with a capital, and other kinds too", async () => {
    const { world } = await generate("0.2", 123);
    const known = new Set(PROVINCE_TYPES.map((t) => t.id));
    for (const p of world.provinces) if (p.type !== undefined) expect(known.has(p.type)).toBe(true);
    // "province" is never stored: ordinary provinces have no type
    expect(world.provinces.some((p) => p.type === "province")).toBe(false);

    world.nations.forEach((_, n) => {
      const capital = world.cities.find((c) => c.nationIndex === n && c.isCapital);
      const districts = world.provinces.filter((p) => p.nationIndex === n && p.type === "capital");
      if (!capital) return;
      expect(districts.length).toBe(1);
      expect(world.getCell(capital.x, capital.y)?.provinceIndex).toBe(districts[0].id);
    });

    const c = counts(world);
    const special = world.provinces.filter((p) => p.type && p.type !== "capital").length;
    expect(special).toBeGreaterThan(0);
    // Most provinces stay ordinary
    expect(c.get("province") ?? 0).toBeGreaterThan(world.provinces.length / 3);
  });

  test("a 0.1 world has no province types", async () => {
    const { world } = await generate("0.1");
    expect(world.provinces.length).toBeGreaterThan(0);
    expect(world.provinces.every((p) => p.type === undefined)).toBe(true);
    // Refreshing (as the editor and history do) leaves old worlds alone
    refreshProvinceTypes(world);
    expect(world.provinces.every((p) => p.type === undefined)).toBe(true);
  });

  test("types are the same each time a world is made, and refreshing keeps them", async () => {
    const a = (await generate("0.2", 123)).world;
    const b = (await generate("0.2", 123)).world;
    expect(b.provinces.map((p) => p.type)).toEqual(a.provinces.map((p) => p.type));
    const before = a.provinces.map((p) => p.type);
    refreshProvinceTypes(a);
    expect(a.provinces.map((p) => p.type)).toEqual(before);
    assignProvinceTypes(a);
    expect(a.provinces.map((p) => p.type)).toEqual(before);
  });

  test("a user's choice survives a refresh; a capital district without the capital does not", async () => {
    const { world } = await generate("0.2", 123);
    // A province with a town of its own, away from its realm's capital district
    const other = world.provinces.find(
      (p) => p.type !== "capital" && world.cities.some((c) => c.provinceIndex === p.id && c.nationIndex === p.nationIndex && !c.isCapital),
    )!;
    expect(other).toBeDefined();
    const n = other.nationIndex;
    other.type = "autonomous";
    refreshProvinceTypes(world);
    expect(other.type).toBe("autonomous");

    // The capital moves into it
    const cap = world.provinces.find((p) => p.nationIndex === n && p.type === "capital")!;
    const city = world.cities.find((c) => c.nationIndex === n && c.isCapital)!;
    const target = world.cities.find((c) => c.nationIndex === n && c.provinceIndex === other.id && !c.isCapital)!;
    city.isCapital = false;
    target.isCapital = true;
    world.nations[n].capitalX = target.x;
    world.nations[n].capitalY = target.y;
    refreshProvinceTypes(world);
    expect(other.type).toBe("capital");
    expect(cap.type).not.toBe("capital");
  });

  test("changing a type is an undoable edit", async () => {
    const { world } = await generate("0.2", 123);
    const p = world.provinces.find((q) => q.type === "autonomous") ?? world.provinces[0];
    const before = p.type;
    const h = new EditHistory(world);
    h.ensureBaseline();
    setProvinceType(p, "march");
    expect(h.commit()?.label).toContain("province");
    h.undo();
    expect(world.provinces[p.id].type).toBe(before);
    h.redo();
    expect(world.provinces[p.id].type).toBe("march");
    // Back to ordinary stores no type at all
    setProvinceType(world.provinces[p.id], "province");
    expect("type" in world.provinces[p.id]).toBe(false);
  });

  test("save and load keep the types", async () => {
    const { g, world } = await generate("0.2", 123);
    const p = world.provinces.find((q) => q.type === undefined)!;
    p.type = "colony";
    const types = world.provinces.map((q) => q.type);
    const reopened = await loadWorld(await saveWorld(g), new MapGenerator(10, 10, 1));
    expect(reopened.provinces.map((q) => q.type)).toEqual(types);
  });
});
