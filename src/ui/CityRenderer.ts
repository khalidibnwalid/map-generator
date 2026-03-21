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

    ctx.restore();
  }
}
