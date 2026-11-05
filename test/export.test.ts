import { crc32 as nodeCrc } from "node:zlib";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MapGenerator } from "../src/game/MapGenerator";
import { buildGameExport, EXPORT_FORMAT } from "../src/game/export/GameExport";
import { crc32, zip } from "../src/game/export/zip";

test("crc32 matches zlib", () => {
  const data = new TextEncoder().encode("The Known World, year 120 ✦");
  expect(crc32(data)).toBe(nodeCrc(data));
});

test("zip lists every entry in its central directory", () => {
  const out = zip([
    { name: "a.txt", data: "hello" },
    { name: "dir/b.bin", data: new Uint8Array([1, 2, 3]) },
  ]);
  const v = new DataView(out.buffer);
  const eocd = out.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  expect(v.getUint16(eocd + 10, true)).toBe(2);
  // First local header: name and stored content
  expect(v.getUint32(0, true)).toBe(0x04034b50);
  expect(new TextDecoder().decode(out.subarray(30, 35))).toBe("a.txt");
  expect(new TextDecoder().decode(out.subarray(35, 40))).toBe("hello");
  if (process.env.ZIP_OUT) writeFileSync(join(tmpdir(), "map-export-test.zip"), out);
});

test("the game export describes the world consistently", async () => {
  const g = new MapGenerator(400, 225, 4242);
  g.currentPreset = "Earthlike";
  const world = await g.generate();
  const ex = buildGameExport(g);
  const data = JSON.parse(ex.json);

  expect(data.format).toBe(EXPORT_FORMAT);
  expect(data.grid).toMatchObject({ width: 400, height: 225, cellKm: 5 });
  expect(data.nations).toHaveLength(world.nations.length);
  expect(data.cities).toHaveLength(world.cities.length);
  // References point at things that exist
  const nations = data.nations.length;
  for (const c of data.cities) expect(c.nation).toBeLessThan(nations);
  const cityIds = new Set(data.cities.map((c: { id: number }) => c.id));
  for (const r of data.roads) {
    expect(cityIds.has(r.from)).toBe(true);
    expect(cityIds.has(r.to)).toBe(true);
  }
  for (const p of data.provinces) if (p.capitalCity !== null) expect(cityIds.has(p.capitalCity)).toBe(true);
  expect(data.generator.link).toBe("#seed=4242&land=medium&size=400x225");

  expect(ex.heightmap16.length).toBe(400 * 225 * 2);
  for (const im of ex.images) expect(im.rgba.length).toBe(im.width * im.height * 4);
  // The nation index image decodes back to the grid
  const idx = ex.images.find((i) => i.name === "index/nations.png")!;
  const x = Math.round(world.nations[0].capitalX);
  const y = Math.round(world.nations[0].capitalY);
  const o = (y * 400 + x) * 4;
  expect(idx.rgba[o] + idx.rgba[o + 1] * 256 - 1).toBe(world.grid[x][y].nationIndex ?? -1);
});
