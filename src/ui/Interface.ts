import { MapGenerator } from '../game/MapGenerator';
import type { Preset } from '../game/MapGenerator';
import { WorldData, BIOME_COLORS } from '../game/WorldData';
import { CanvasManager } from '../core/CanvasManager';

export type ViewLayer = 'Biomes' | 'Elevation' | 'Heatmap' | 'Moisture';

export class Interface {
    private generator: MapGenerator;
    private canvasManager: CanvasManager;
    private currentLayer: ViewLayer = 'Biomes';

    constructor(generator: MapGenerator, canvasManager: CanvasManager) {
        this.generator = generator;
        this.canvasManager = canvasManager;

        this.setupUI();
        this.canvasManager.onRender = this.renderMap.bind(this);
    }

    private setupUI() {
        const seedInput = document.getElementById('seed') as HTMLInputElement;
        const generateBtn = document.getElementById('generate') as HTMLButtonElement;
        const presetSelect = document.getElementById('preset') as HTMLSelectElement;

        // Layers
        const layers = ['Biomes', 'Elevation', 'Heatmap', 'Moisture'] as ViewLayer[];
        layers.forEach(layer => {
            const btn = document.getElementById(`layer-${layer.toLowerCase()}`);
            if (btn) {
                btn.addEventListener('click', () => {
                    this.currentLayer = layer;
                    // Update active state class
                    document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.canvasManager.scheduleRender();
                });
            }
        });

        seedInput.value = this.generator.currentSeed.toString();

        generateBtn.addEventListener('click', () => {
            const p = presetSelect.value as Preset;
            const seedVal = parseInt(seedInput.value) || Math.floor(Math.random() * 999999);
            seedInput.value = seedVal.toString();

            this.generator.currentPreset = p;
            this.generator.currentSeed = seedVal;

            this.generator.generate();
            this.canvasManager.scheduleRender();
        });
    }

    private renderMap(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) {
        const world = this.generator.getWorld();

        // Enforce zoom and pan limits to prevent viewing the background void vertically
        const minScale = height / world.height;
        if (this.canvasManager.scale < minScale) {
            this.canvasManager.scale = minScale;
            scale = minScale;
        }

        const mapPixelHeight = world.height * scale;
        if (this.canvasManager.offsetY > 0) {
            this.canvasManager.offsetY = 0;
            offsetY = 0;
        } else if (this.canvasManager.offsetY < height - mapPixelHeight) {
            this.canvasManager.offsetY = height - mapPixelHeight;
            offsetY = height - mapPixelHeight;
        }

        // Dynamic resolution: When user is interacting (panning/zooming), we render at a lower resolution (step > 1)
        // to keep framerates perfectly smooth. Once they stop, we render full 1:1 sharp resolution.
        const step = isInteracting ? 3 : 1;
        const renderWidth = Math.ceil(width / step);
        const renderHeight = Math.ceil(height / step);

        // Render to offscreen image data of size width/step x height/step
        const id = ctx.createImageData(renderWidth, renderHeight);
        const data = id.data;

        const invScale = 1 / scale;

        // Calculate exact screen bounds that map to the physical world map
        // Enable continuous East/West wrapping by rendering the full screen width and wrapping array coordinates
        const minSx = 0;
        const maxSx = width;
        const minSy = Math.max(0, Math.floor(offsetY));
        const maxSy = Math.min(height, Math.ceil((world.height - 2) * scale + offsetY));

        const minRx = Math.floor(minSx / step);
        const maxRx = Math.ceil(maxSx / step);
        const minRy = Math.floor(minSy / step);
        const maxRy = Math.ceil(maxSy / step);

        // Pre-fill everything with ambient Ocean color (matches BIOME_COLORS[BiomeType.OCEAN] #1C3E5A -> 28, 62, 90)
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 28;     // R
            data[i + 1] = 62;   // G
            data[i + 2] = 90;   // B
            data[i + 3] = 255;  // A
        }

        for (let ry = minRy; ry < maxRy; ry++) {
            for (let rx = minRx; rx < maxRx; rx++) {
                const sx = rx * step;
                const sy = ry * step;

                // Map screen pixel (sx, sy) to world coordinate (wx, wy)
                const wx = (sx - offsetX) * invScale;
                const wy = (sy - offsetY) * invScale;

                // Bilinear interpolation
                const rawX0 = Math.floor(wx);
                let x0 = rawX0;
                let x1 = rawX0 + 1;
                const y0 = Math.floor(wy);
                const y1 = y0 + 1;

                // Wrap X coordinates infinitely for our seamless cylinder
                x0 = ((x0 % world.width) + world.width) % world.width;
                x1 = ((x1 % world.width) + world.width) % world.width;

                if (y0 < 0 || y1 >= world.height) continue;

                const tx = wx - rawX0;
                const ty = wy - y0;
                const oneMinusTx = 1 - tx;
                const oneMinusTy = 1 - ty;

                const c00 = world.grid[x0][y0];
                const c10 = world.grid[x1][y0];
                const c01 = world.grid[x0][y1];
                const c11 = world.grid[x1][y1];

                const e0 = c00.elevation * oneMinusTx + c10.elevation * tx;
                const e1 = c01.elevation * oneMinusTx + c11.elevation * tx;
                const elevation = e0 * oneMinusTy + e1 * ty;

                let color = [0, 0, 0];

                if (this.currentLayer === 'Biomes') {
                    const m0 = c00.moisture * oneMinusTx + c10.moisture * tx;
                    const m1 = c01.moisture * oneMinusTx + c11.moisture * tx;
                    const moisture = m0 * oneMinusTy + m1 * ty;

                    const t0 = c00.temperature * oneMinusTx + c10.temperature * tx;
                    const t1 = c01.temperature * oneMinusTx + c11.temperature * tx;
                    const temperature = t0 * oneMinusTy + t1 * ty;

                    const biome = WorldData.getBiome(elevation, temperature, moisture);
                    color = this.hexToRgb(BIOME_COLORS[biome]);
                } else if (this.currentLayer === 'Elevation') {
                    const isWater = elevation < 0.45;
                    const v = Math.floor(elevation * 255);
                    color = isWater ? [0, 0, v] : [v, v, v];
                } else if (this.currentLayer === 'Heatmap') {
                    const t0 = c00.temperature * oneMinusTx + c10.temperature * tx;
                    const t1 = c01.temperature * oneMinusTx + c11.temperature * tx;
                    const temperature = t0 * oneMinusTy + t1 * ty;
                    const v = Math.floor(temperature * 255);
                    color = [v, 0, 255 - v];
                } else if (this.currentLayer === 'Moisture') {
                    const m0 = c00.moisture * oneMinusTx + c10.moisture * tx;
                    const m1 = c01.moisture * oneMinusTx + c11.moisture * tx;
                    const moisture = m0 * oneMinusTy + m1 * ty;
                    const v = Math.floor(moisture * 255);
                    color = [255 - v, 255 - v, v];
                }

                const index = (ry * renderWidth + rx) * 4;
                data[index] = color[0];
                data[index + 1] = color[1];
                data[index + 2] = color[2];
                data[index + 3] = 255;
            }
        }

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = renderWidth;
        tempCanvas.height = renderHeight;
        tempCanvas.getContext('2d')?.putImageData(id, 0, 0);

        // Draw and scale the offscreen canvas to the main context
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tempCanvas, 0, 0, width, height);

        // Render Vector lines (Rivers) over the map
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        if (this.currentLayer === 'Biomes' || this.currentLayer === 'Elevation') {
            const riverColor = this.hexToRgb(BIOME_COLORS['Shallow Water']);
            ctx.strokeStyle = `rgb(${riverColor[0]}, ${riverColor[1]}, ${riverColor[2]})`;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            // Line width adjusts with scale so it looks like a real river on map
            ctx.lineWidth = 1.5;

            // To support infinite continuous panning, draw multiple copies of the rivers
            const mapPixelWidth = world.width * scale;
            const startCopy = Math.floor(-offsetX / mapPixelWidth);
            const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

            for (let copy = startCopy; copy <= endCopy; copy++) {
                ctx.save();
                ctx.translate(copy * world.width, 0); // Translate in world coordinates space

                ctx.beginPath();
                if (world.rivers) {
                    for (const river of world.rivers) {
                        if (river.length === 0) continue;
                        ctx.moveTo(river[0].x, river[0].y);
                        for (let i = 1; i < river.length; i++) {
                            let rx = river[i].x;
                            let prevRx = river[i - 1].x;
                            // If river jumps across map East/West seam, pick up pen
                            if (Math.abs(rx - prevRx) > world.width / 2) {
                                ctx.moveTo(rx, river[i].y);
                            } else {
                                ctx.lineTo(rx, river[i].y);
                            }
                        }
                    }
                }
                ctx.stroke();
                ctx.restore();
            }
        }

        ctx.restore();
    }

    private hexToRgb(hex: string): number[] {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16),
            parseInt(result[2], 16),
            parseInt(result[3], 16)
        ] : [0, 0, 0];
    }
}
