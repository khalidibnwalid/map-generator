import type { WorldData } from "../game/WorldData";
import type { CanvasTheme } from "./themes";
import { settlementFade } from "./CityRenderer";

export class LabelRenderer {
  private occupiedRects: { x: number; y: number; w: number; h: number }[] = [];
  private sortedCities: { key: string; list: WorldData["cities"] } | null = null;
  private widths = new Map<string, number>();

  // Text widths are cached per font+text; measureText dominates label cost
  private textWidth(ctx: CanvasRenderingContext2D, text: string): number {
    const key = ctx.font + "|" + text;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (this.widths.size > 20000) this.widths.clear();
      w = ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  public render(
    ctx: CanvasRenderingContext2D,
    world: WorldData,
    width: number,
    height: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    isInteracting: boolean,
    nationSizes: number[],
    nationCentroids: { x: number; y: number }[],
    theme: CanvasTheme,
    showProvinces: boolean,
    nationLandArea: number[] = [],
  ) {
    const mapPixelWidth = world.width * scale;
    const startCopy = Math.floor(-offsetX / mapPixelWidth);
    const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);
    this.occupiedRects = [];

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Nation labels
    if (scale > 0.3 && scale < 60) {
      const nationAlpha = Math.min(1.0, (scale - 0.25) * 4) * (1 - Math.max(0, (scale - 30) / 30));
      const sortedNations = [...world.nations].sort(
        (a, b) => (nationSizes[b.id] || 0) - (nationSizes[a.id] || 0),
      );
      for (const nation of sortedNations) {
        const sizeFactor = nationSizes[nation.id] || 0.5;
        // Size from the country's on-screen extent; skip if it would not fit
        const extentPx = Math.sqrt(nationLandArea[nation.id] || 0) * scale;
        if (extentPx < 70) continue;
        const fontSize = Math.max(10, Math.min(30, Math.floor(extentPx * 0.11)));
        const font = `bold ${fontSize}px ${theme.font}`;
        const centroid = nationCentroids[nation.id] || { x: nation.capitalX, y: nation.capitalY };
        for (let copy = startCopy; copy <= endCopy; copy++) {
          const sx = (centroid.x + copy * world.width) * scale + offsetX;
          const sy = centroid.y * scale + offsetY;
          if (sx < -400 || sx > width + 400 || sy < -100 || sy > height + 100) continue;
          const spacedName = nation.name
            .toUpperCase()
            .split("")
            .join(sizeFactor > 0.5 && fontSize > 16 ? " " : "");
          ctx.font = font;
          if (this.textWidth(ctx, spacedName) > extentPx * 1.15) continue;
          ctx.globalAlpha = nationAlpha;
          this.drawLabelWithHalo(ctx, spacedName, sx, sy, font, theme.nationLabel, theme.nationHalo, 4);
        }
      }
      ctx.globalAlpha = 1;
    }
    // Province labels at their land centroid
    if (showProvinces && scale > 3 && scale < 40) {
      const provinceAlpha = Math.min(0.85, (scale - 3) * 0.6) * (1 - Math.max(0, (scale - 20) / 20));
      const font = `italic 500 ${Math.round(Math.min(15, 10 + scale * 0.4))}px ${theme.font}`;
      for (const province of world.provinces) {
        if (province.centroidX === undefined || province.centroidY === undefined) continue;
        for (let copy = startCopy; copy <= endCopy; copy++) {
          const sx = (province.centroidX + copy * world.width) * scale + offsetX;
          const sy = province.centroidY * scale + offsetY;
          if (sx < -100 || sx > width + 100 || sy < -50 || sy > height + 50) continue;
          ctx.globalAlpha = provinceAlpha;
          this.drawLabelWithHalo(
            ctx,
            province.name.toUpperCase(),
            sx,
            sy,
            font,
            theme.provinceLabel,
            theme.nationHalo,
            2.5,
          );
        }
      }
      ctx.globalAlpha = 1;
    }

    // City labels
    if (scale > 0.8) {
      const cityAlpha = Math.min(0.9, (scale - 0.8) * 2.5);
      const key = world.seed + "|" + world.cities.length;
      if (!this.sortedCities || this.sortedCities.key !== key) {
        this.sortedCities = {
          key,
          list: [...world.cities].sort((a, b) =>
            a.isCapital === b.isCapital ? b.population - a.population : a.isCapital ? -1 : 1,
          ),
        };
      }
      const sortedCities = this.sortedCities.list;
      ctx.globalAlpha = isInteracting ? cityAlpha * 0.6 : cityAlpha;
      for (const city of sortedCities) {
        // Labels lag the dots a little so the map never gets crowded
        const fade = settlementFade(city, city.isCapital ? scale : scale / 1.35);
        if (fade < 0.6) continue;
        if (!city.isCapital && city.size >= 2 && scale < 1.2) continue;
        // Label sits below the built-up area once the city is drawn in detail
        const radiusPx = (city.radiusM / 5000) * scale;
        const big = city.isCapital || city.size >= 2;
        const size = Math.round(Math.min(26, (big ? 12 : 11) + Math.max(0, Math.log2(Math.max(1, radiusPx / 20))) * 3));
        const font = big
          ? `bold ${size}px ${theme.font}`
          : `500 ${size}px ${theme.font}`;
        for (let copy = startCopy; copy <= endCopy; copy++) {
          const sx = (city.x + copy * world.width) * scale + offsetX;
          const sy = city.y * scale + offsetY + Math.max(city.isCapital ? 12 : 9, radiusPx * 1.15);
          if (sx < -100 || sx > width + 100 || sy < -50 || sy > height + 50) continue;
          if (theme.cityLabel === "box") this.drawCityLabel(ctx, city.name, sx, sy, font);
          else
            this.drawLabelWithHalo(
              ctx,
              city.name,
              sx,
              sy,
              font,
              theme.ink,
              theme.nationHalo,
              3,
            );
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  private checkCollision(x: number, y: number, w: number, h: number) {
    const pad = 6;
    for (const r of this.occupiedRects) {
      if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y)
        return true;
    }
    return false;
  }

  private drawLabelWithHalo(
    ctx: CanvasRenderingContext2D,
    text: string,
    sx: number,
    sy: number,
    font: string,
    color: string,
    haloColor: string = "rgba(255,255,255,0.45)",
    haloWidth: number = 3,
  ) {
    ctx.font = font;
    const textW = this.textWidth(ctx, text);
    const fontSizeMatch = font.match(/(\d+)px/);
    const textH = fontSizeMatch ? parseInt(fontSizeMatch[1]) : 12;
    const lx = sx - textW / 2;
    const ly = sy - textH / 2;

    if (this.checkCollision(lx, ly, textW, textH)) return false;

    ctx.strokeStyle = haloColor;
    ctx.lineWidth = haloWidth;
    ctx.lineJoin = "round";
    ctx.strokeText(text, sx, sy);
    ctx.fillStyle = color;
    ctx.fillText(text, sx, sy);
    this.occupiedRects.push({ x: lx, y: ly, w: textW, h: textH });
    return true;
  }

  private drawCityLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    sx: number,
    sy: number,
    font: string,
  ) {
    ctx.font = font;
    const paddingX = 4;
    const paddingY = 2;
    const textW = this.textWidth(ctx, text);
    const fontSizeMatch = font.match(/(\d+)px/);
    const textH = fontSizeMatch ? parseInt(fontSizeMatch[1]) : 11;

    const lx = sx - textW / 2 - paddingX;
    const ly = sy - textH / 2 - paddingY;
    const boxW = textW + paddingX * 2;
    const boxH = textH + paddingY * 2;

    if (this.checkCollision(lx, ly, boxW, boxH)) return false;

    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.beginPath();
    ctx.roundRect(lx, ly, boxW, boxH, 2);
    ctx.fill();

    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(text, sx, sy + 1);

    this.occupiedRects.push({ x: lx, y: ly, w: boxW, h: boxH });
    return true;
  }
}
