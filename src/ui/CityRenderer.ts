import { WorldData } from "../game/WorldData";

export class CityRenderer {
  public render(
    ctx: CanvasRenderingContext2D,
    _world: WorldData,
    _width: number,
    _height: number,
    scale: number,
    _offsetX: number,
    _offsetY: number,
  ) {
    // Only draw city geometry at high zoom levels (LOD)
    if (scale < 10) return;

    ctx.restore();
  }
}
