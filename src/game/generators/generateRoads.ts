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
  const connections = new Set<string>();

  // A* implementation
  const findPath = (startCity: City, targetCity: City): Point[] | null => {
    const startX = Math.round(startCity.x);
    const startY = Math.round(startCity.y);
    const targetX = Math.round(targetCity.x);
    const targetY = Math.round(targetCity.y);

    const openList: Node[] = [];
    const closedList = new Map<number, boolean>();

    const getIndex = (x: number, y: number) => {
      const cx = ((x % width) + width) % width;
      return cx + y * width;
    };

    const getH = (x: number, y: number) => {
      let dx = Math.abs(x - targetX);
      if (dx > width / 2) dx = width - dx;
      const dy = Math.abs(y - targetY);
      return Math.hypot(dx, dy);
    };

    openList.push({
      x: startX,
      y: startY,
      g: 0,
      h: getH(startX, startY),
      f: getH(startX, startY),
      parent: null,
    });

    // Safety limit to prevent infinite loops on impossible paths
    const maxIterations = 50000;
    let iterations = 0;

    while (openList.length > 0 && iterations < maxIterations) {
      iterations++;

      // Get lowest f value
      let lowestIndex = 0;
      for (let i = 1; i < openList.length; i++) {
        if (openList[i].f < openList[lowestIndex].f) {
          lowestIndex = i;
        }
      }
      const current = openList.splice(lowestIndex, 1)[0];

      // Check if reached target (within 0.5 tiles of target integer coordinate)
      let dx = Math.abs(current.x - targetX);
      if (dx > width / 2) dx = width - dx;
      if (dx === 0 && current.y === targetY) {
        // Reconstruct path
        const path: Point[] = [];

        // Add exact sub-pixel target coordinate at the VERY end
        path.push({ x: targetCity.x, y: targetCity.y });

        let currNode: Node | null = current;
        while (currNode !== null) {
          path.push({
            x: ((currNode.x % width) + width) % width,
            y: currNode.y,
          });
          currNode = currNode.parent;
        }

        // Add exact sub-pixel start coordinate at the VERY beginning
        path.push({ x: startCity.x, y: startCity.y });

        return path.reverse();
      }

      const idx = getIndex(current.x, current.y);
      closedList.set(idx, true);

      // Neighbors (orthangonal and diagonal)
      const neighbors = [
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
        { dx: 1, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: -1 },
      ];

      for (const edge of neighbors) {
        const nx = current.x + edge.dx;
        const ny = current.y + edge.dy;

        // Wrap X, clamp Y
        if (ny < 0 || ny >= height) continue;
        const cx = ((nx % width) + width) % width;
        const nIdx = cx + ny * width;

        if (closedList.get(nIdx)) continue;

        const cell = world.grid[cx][ny];

        // Extreme penalty or absolute block for water
        if (cell.isWater) continue;

        // Terrain cost modifiers
        let cost = current.g + (edge.dx !== 0 && edge.dy !== 0 ? 1.414 : 1.0);

        // Add organic "jitter" based on position to avoid perfectly straight lines
        // This makes roads feel more worn and organic
        const jitter = (Math.sin(nx * 0.5) * Math.cos(ny * 0.5) + 1.0) * 0.2;
        cost += jitter;

        // Elevation change penalty
        const currentCell =
          world.grid[((current.x % width) + width) % width][current.y];
        const elevDiff = Math.abs(cell.elevation - currentCell.elevation);
        cost += elevDiff * 100; // Increased penalty to follow contours better

        // Biome preferences (prefer plains/grassland)
        if (
          cell.biome === "Bare" ||
          cell.biome === "Snow" ||
          cell.elevation > 0.7
        ) {
          cost += 5; // Heavier penalty for rugged terrain
        }
        if (cell.hasRiver) {
          cost += 8; // Bridges are very expensive
        }

        const h = getH(nx, ny);
        const f = cost + h;

        let inOpen = false;
        let p = 0;
        for (let i = 0; i < openList.length; i++) {
          if (openList[i].x === nx && openList[i].y === ny) {
            inOpen = true;
            p = i;
            break;
          }
        }

        if (inOpen && cost < openList[p].g) {
          openList[p].g = cost;
          openList[p].f = f;
          openList[p].parent = current;
        } else if (!inOpen) {
          openList.push({ x: nx, y: ny, g: cost, h, f, parent: current });
        }
      }
    }

    return null; // No path found
  };

  const totalCities = world.cities.length;
  if (totalCities < 2) return;

  // Build connection graph: connect each city to its nearest neighbor
  for (let i = 0; i < totalCities; i++) {
    if (i % 5 === 0) {
      onProgress?.(80 + (i / totalCities) * 15);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const cityA = world.cities[i];

    // Find closest 2 cities
    let distances: { city: City; dist: number }[] = [];
    for (let j = 0; j < totalCities; j++) {
      if (i === j) continue;
      const cityB = world.cities[j];
      let dx = Math.abs(cityA.x - cityB.x);
      if (dx > width / 2) dx = width - dx;
      const dist = Math.hypot(dx, cityA.y - cityB.y);
      distances.push({ city: cityB, dist });
    }

    distances.sort((a, b) => a.dist - b.dist);
    const targets = distances.slice(0, 2).map((d) => d.city);

    for (const target of targets) {
      const connId =
        Math.min(cityA.id, target.id) + "-" + Math.max(cityA.id, target.id);
      if (!connections.has(connId)) {
        connections.add(connId);
        const path = findPath(cityA, target);
        if (path && path.length > 2) {
          roads.push(path);
        }
      }
    }
  }

  world.worldRoads = roads;
}
