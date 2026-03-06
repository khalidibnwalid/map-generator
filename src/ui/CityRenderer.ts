import { WorldData, DistrictType } from "../game/WorldData";

export class CityRenderer {
  public render(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
  ) {
    // Only draw city geometry at high zoom levels (LOD)
    if (scale < 10) return;

    const mapPixelWidth = world.width * scale;
    const startCopy = Math.floor(-offsetX / mapPixelWidth);
    const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Sort cities to render villages first, capitals last (z-indexing)
    const sortedCities = [...world.cities].sort((a, b) => a.size - b.size);

    for (const city of sortedCities) {
      if (!city.geometry) continue;

      const nation = world.nations[city.nationIndex];
      if (!nation) continue;

      for (let copy = startCopy; copy <= endCopy; copy++) {
        const cxOffset = copy * world.width;

        // Fast bounding box check to only render cities roughly on screen
        const maxRadius = city.isCapital ? 2.5 : city.size === 1 ? 1.5 : 0.8;
        const viewCx = (city.x + cxOffset) * scale + offsetX;
        const viewCy = city.y * scale + offsetY;
        const viewRadius = maxRadius * scale;
        if (
          viewCx + viewRadius < 0 ||
          viewCx - viewRadius > width ||
          viewCy + viewRadius < 0 ||
          viewCy - viewRadius > height
        ) {
          continue;
        }

        const drawBuildings = scale >= 50; // Draw simpler versions sooner

        // Render City Ground/Streets (Outline)
        if (city.geometry.outline) {
          ctx.beginPath();
          for (let i = 0; i < city.geometry.outline.length; i++) {
            const p = city.geometry.outline[i];
            const vx = (p.x + cxOffset) * scale + offsetX;
            const vy = p.y * scale + offsetY;
            if (i === 0) ctx.moveTo(vx, vy);
            else ctx.lineTo(vx, vy);
          }
          ctx.closePath();
          // Dirt/Pavement color for streets and empty plazas (parchment-like)
          ctx.fillStyle = "rgba(224, 215, 198, 0.9)";
          ctx.fill();

          // If city has walls, draw a prominent dark outline for the wall
          if (city.geometry.hasWall) {
            ctx.strokeStyle = "rgba(60, 55, 50, 0.9)";
            ctx.lineWidth = Math.max(1, scale * 0.04);
            ctx.stroke();
          }

          // Render Towers
          if (city.geometry.towers && city.geometry.towers.length > 0) {
            ctx.fillStyle = "rgba(70, 65, 60, 1.0)";
            const towerRad = Math.max(1.5, scale * 0.05);
            for (const tower of city.geometry.towers) {
              const vx = (tower.x + cxOffset) * scale + offsetX;
              const vy = tower.y * scale + offsetY;
              ctx.beginPath();
              ctx.arc(vx, vy, towerRad, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }

        // Render Blocks (Road background/Foundations)
        for (const block of city.geometry.blocks) {
          ctx.beginPath();
          for (let i = 0; i < block.polygon.length; i++) {
            const p = block.polygon[i];
            const vx = (p.x + cxOffset) * scale + offsetX;
            const vy = p.y * scale + offsetY;
            if (i === 0) ctx.moveTo(vx, vy);
            else ctx.lineTo(vx, vy);
          }
          ctx.closePath();

          const nationRgb = this.hexToRgb(nation.color);

          let distColor = [200, 150, 100]; // fallback
          if (block.district === DistrictType.CASTLE)
            distColor = [160, 50, 50]; // Reddish
          else if (block.district === DistrictType.WEALTHY)
            distColor = [220, 140, 40]; // Orange/Gold
          else if (block.district === DistrictType.MARKET)
            distColor = [230, 200, 100]; // Yellow
          else if (block.district === DistrictType.SLUM)
            distColor = [130, 120, 110]; // Grey/Brown
          else if (block.district === DistrictType.HARBOR)
            distColor = [100, 140, 180]; // Blueish
          else distColor = [210, 160, 90]; // Residential (warm orange/brown)

          // Mix district color slightly with nation color, mostly district color though
          const roofColor = this.mixColors(distColor, nationRgb, 0.15);

          // If zoomed far out, fill blocks directly with roof color to look like dense buildings
          if (drawBuildings) {
            ctx.fillStyle = "rgba(235, 230, 215, 0.3)"; // slight shading for block base
          } else {
            ctx.fillStyle = `rgba(${roofColor[0]}, ${roofColor[1]}, ${roofColor[2]}, 0.8)`;
          }
          ctx.fill();

          // Render detailed Buildings only when zoomed in closely (LOD)
          if (drawBuildings) {
            for (const building of block.buildings) {
              ctx.beginPath();
              for (let i = 0; i < building.polygon.length; i++) {
                const p = building.polygon[i];
                const vx = (p.x + cxOffset) * scale + offsetX;
                const vy = p.y * scale + offsetY;
                if (i === 0) ctx.moveTo(vx, vy);
                else ctx.lineTo(vx, vy);
              }
              ctx.closePath();

              ctx.fillStyle = `rgb(${roofColor[0]}, ${roofColor[1]}, ${roofColor[2]})`;
              ctx.fill();

              // Building outline - darker, crisp outline
              ctx.strokeStyle = "rgba(40, 35, 30, 0.85)";
              ctx.lineWidth = 1; // Always thin crisp line for illustratative look
              ctx.stroke();
            }
          }
        }
      }
    }

    ctx.restore();
  }

  private hexToRgb(hex: string): number[] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? [
          parseInt(result[1], 16),
          parseInt(result[2], 16),
          parseInt(result[3], 16),
        ]
      : [200, 200, 200];
  }

  private mixColors(c1: number[], c2: number[], t: number): number[] {
    return [
      Math.round(c1[0] * (1 - t) + c2[0] * t),
      Math.round(c1[1] * (1 - t) + c2[1] * t),
      Math.round(c1[2] * (1 - t) + c2[2] * t),
    ];
  }
}
