import type { GeneratorContext } from "./types";
import type { City, Point, Polygon } from "../WorldData";

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

export async function generateRoads(ctx: GeneratorContext): Promise<void> {
  const { world, width, height, onProgress } = ctx;

  const roads: Polygon[] = [];

  world.worldRoads = roads;
}
