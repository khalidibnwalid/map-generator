import type { WorldData } from '../game/WorldData';

export class LabelRenderer {
    private occupiedRects: { x: number, y: number, w: number, h: number }[] = [];

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
        nationCentroids: { x: number, y: number }[]
    ) {
        const mapPixelWidth = world.width * scale;
        const startCopy = Math.floor(-offsetX / mapPixelWidth);
        const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);
        this.occupiedRects = [];

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Draw Nation Labels
        if (scale > 0.3) {
            const nationAlpha = Math.min(1.0, (scale - 0.25) * 4);
            const sortedNations = [...world.nations].sort((a, b) => (nationSizes[b.id] || 0) - (nationSizes[a.id] || 0));

            for (const nation of sortedNations) {
                const sizeFactor = nationSizes[nation.id] || 0.5;
                const baseSize = 9 + sizeFactor * 10;
                const fontSize = Math.max(9, Math.floor(baseSize * Math.sqrt(scale)));
                const font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
                const labelColor = `rgba(35, 35, 40, ${nationAlpha * 0.9})`;
                const centroid = nationCentroids[nation.id] || { x: nation.capitalX, y: nation.capitalY };

                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const sx = (centroid.x + copy * world.width) * scale + offsetX;
                    const sy = centroid.y * scale + offsetY;
                    if (sx < -200 || sx > width + 200 || sy < -100 || sy > height + 100) continue;
                    const spacedName = nation.name.toUpperCase().split('').join(sizeFactor > 0.5 ? ' ' : '');
                    this.drawLabelWithHalo(ctx, spacedName, sx, sy, font, labelColor, `rgba(255, 255, 255, ${0.6 * nationAlpha})`, 4);
                }
            }
        }

        // Draw City Labels
        if (scale > 0.8) {
            const cityAlpha = Math.min(0.8, (scale - 0.8) * 2.5);
            const sortedCities = [...world.cities].sort((a, b) => (a.isCapital === b.isCapital) ? (b.size - a.size) : (a.isCapital ? -1 : 1));

            for (const city of sortedCities) {
                let visible = city.isCapital || (city.size >= 1 && scale > 1.4) || (city.size === 0 && scale > 2.5);
                if (!visible) continue;
                const font = city.isCapital ? `bold 12px system-ui, sans-serif` : `500 11px system-ui, sans-serif`;

                ctx.globalAlpha = isInteracting ? cityAlpha * 0.6 : cityAlpha;

                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const sx = (city.x + copy * world.width) * scale + offsetX;
                    const sy = city.y * scale + offsetY + (city.isCapital ? 12 : 9);
                    if (sx < -100 || sx > width + 100 || sy < -50 || sy > height + 50) continue;
                    this.drawCityLabel(ctx, city.name, sx, sy, font);
                }
            }
        }
        ctx.restore();
    }

    private checkCollision(x: number, y: number, w: number, h: number) {
        const pad = 6;
        for (const r of this.occupiedRects) {
            if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y) return true;
        }
        return false;
    }

    private drawLabelWithHalo(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, font: string, color: string, haloColor: string = 'rgba(255,255,255,0.45)', haloWidth: number = 3) {
        ctx.font = font;
        const metrics = ctx.measureText(text);
        const textW = metrics.width;
        const fontSizeMatch = font.match(/(\d+)px/);
        const textH = fontSizeMatch ? parseInt(fontSizeMatch[1]) : 12;
        const lx = sx - textW / 2;
        const ly = sy - textH / 2;

        if (this.checkCollision(lx, ly, textW, textH)) return false;

        ctx.strokeStyle = haloColor;
        ctx.lineWidth = haloWidth;
        ctx.lineJoin = 'round';
        ctx.strokeText(text, sx, sy);
        ctx.fillStyle = color;
        ctx.fillText(text, sx, sy);
        this.occupiedRects.push({ x: lx, y: ly, w: textW, h: textH });
        return true;
    }

    private drawCityLabel(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, font: string) {
        ctx.font = font;
        const metrics = ctx.measureText(text);
        const paddingX = 4;
        const paddingY = 2;
        const textW = metrics.width;
        const fontSizeMatch = font.match(/(\d+)px/);
        const textH = fontSizeMatch ? parseInt(fontSizeMatch[1]) : 11;

        const lx = sx - textW / 2 - paddingX;
        const ly = sy - textH / 2 - paddingY;
        const boxW = textW + paddingX * 2;
        const boxH = textH + paddingY * 2;

        if (this.checkCollision(lx, ly, boxW, boxH)) return false;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        const radius = 2;
        ctx.beginPath();
        ctx.moveTo(lx + radius, ly);
        ctx.lineTo(lx + boxW - radius, ly);
        ctx.quadraticCurveTo(lx + boxW, ly, lx + boxW, ly + radius);
        ctx.lineTo(lx + boxW, ly + boxH - radius);
        ctx.quadraticCurveTo(lx + boxW, ly + boxH, lx + boxW - radius, ly + boxH);
        ctx.lineTo(lx + radius, ly + boxH);
        ctx.quadraticCurveTo(lx, ly + boxH, lx, ly + boxH - radius);
        ctx.lineTo(lx, ly + radius);
        ctx.quadraticCurveTo(lx, ly, lx + radius, ly);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, sx, sy + 1);

        this.occupiedRects.push({ x: lx, y: ly, w: boxW, h: boxH });
        return true;
    }
}
