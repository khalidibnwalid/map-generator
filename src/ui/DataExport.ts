import type { MapGenerator } from "../game/MapGenerator";
import { buildGameExport, type RasterImage } from "../game/export/GameExport";
import { zip, type ZipEntry } from "../game/export/zip";
import { buildSvg, realmsImage, terrainImage } from "../game/export/SvgExport";
import { downloadBlob, yieldToUI } from "./AtlasRender";

async function png(im: RasterImage): Promise<Uint8Array> {
  const data = new ImageData(im.rgba, im.width, im.height);
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(im.width, im.height);
    c.getContext("2d")!.putImageData(data, 0, 0);
    blob = await c.convertToBlob({ type: "image/png" });
  } else {
    const c = document.createElement("canvas");
    c.width = im.width;
    c.height = im.height;
    c.getContext("2d")!.putImageData(data, 0, 0);
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  }
  if (!blob) throw new Error(`Could not encode ${im.name}`);
  return new Uint8Array(await blob.arrayBuffer());
}

// File > Export for game engines: world.json, a 16-bit heightmap and lookup
// images in one zip
export async function downloadGameExport(generator: MapGenerator) {
  const ex = buildGameExport(generator);
  const entries: ZipEntry[] = [
    { name: "README.txt", data: ex.readme },
    { name: "world.json", data: ex.json },
    { name: "heightmap.r16", data: ex.heightmap16 },
  ];
  for (const im of ex.images) {
    entries.push({ name: im.name, data: await png(im) });
    await yieldToUI();
  }
  downloadBlob(new Blob([zip(entries)], { type: "application/zip" }), `world-${generator.currentSeed}-data.zip`);
}

async function dataUrl(im: RasterImage): Promise<string> {
  const bytes = await png(im);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(s);
}

// File > Export SVG: the world as a layered vector map
export async function downloadSvg(generator: MapGenerator, title: string) {
  const world = generator.getWorld();
  const terrain = await dataUrl(terrainImage(world));
  await yieldToUI();
  const realms = await dataUrl(realmsImage(world));
  await yieldToUI();
  const svg = buildSvg(world, { terrain, realms }, title);
  downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `world-${generator.currentSeed}.svg`);
}
