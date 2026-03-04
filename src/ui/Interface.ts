import { MapGenerator } from '../game/MapGenerator';
import type { Preset } from '../game/MapGenerator';
import { WorldData, BIOME_COLORS } from '../game/WorldData';
import { CanvasManager } from '../core/CanvasManager';

export type ViewLayer = 'Biomes' | 'Elevation' | 'Heatmap' | 'Moisture' | 'Nations';

export class Interface {
    private generator: MapGenerator;
    private canvasManager: CanvasManager;
    private currentLayer: ViewLayer = 'Biomes';
    private hoveredNationIndex: number = -1;
    // Nations layer cache
    private nationsCanvas: HTMLCanvasElement | null = null;
    private nationsBaseData: Uint8ClampedArray | null = null;
    private nationsActiveData: Uint8ClampedArray | null = null;
    private nationCellsList: number[][] = [];
    private nationsStateDirty: boolean = true; // rebuilt on next Nations render

    constructor(generator: MapGenerator, canvasManager: CanvasManager) {
        this.generator = generator;
        this.canvasManager = canvasManager;

        this.setupUI();
        this.canvasManager.onRender = this.renderMap.bind(this);

        // Track mouse for hover
        const canvas = this.canvasManager.canvas;
        canvas.addEventListener('mousemove', (e) => {
            if (this.currentLayer === 'Nations') {
                this.updateHover(e.clientX, e.clientY);
            }
        });
        canvas.addEventListener('mouseleave', () => {
            if (this.currentLayer === 'Nations') {
                this.applyHoverToCache(-1);
                this.hoveredNationIndex = -1;
                this.hideTooltip();
                this.canvasManager.scheduleRender();
            }
        });
    }

    private setupUI() {
        const seedInput = document.getElementById('seed') as HTMLInputElement;
        const generateBtn = document.getElementById('generate') as HTMLButtonElement;
        const presetSelect = document.getElementById('preset') as HTMLSelectElement;
        const toggleBtn = document.getElementById('toggle-panel') as HTMLButtonElement;
        const uiPanel = document.getElementById('ui-panel') as HTMLDivElement;

        if (toggleBtn && uiPanel) {
            toggleBtn.addEventListener('click', () => {
                uiPanel.classList.toggle('collapsed');
                toggleBtn.textContent = uiPanel.classList.contains('collapsed') ? '[+]' : '[-]';
            });
        }

        // Layers
        const layers = ['Biomes', 'Elevation', 'Heatmap', 'Moisture', 'Nations'] as ViewLayer[];
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

            let sizeChanged = false;
            let newW = this.generator.getWidth();
            let newH = this.generator.getHeight();
            const sizeSelect = document.getElementById('size') as HTMLSelectElement;
            if (sizeSelect) {
                const [w, h] = sizeSelect.value.split('x').map(Number);
                if (w !== newW || h !== newH) {
                    sizeChanged = true;
                    newW = w;
                    newH = h;
                }
            }

            this.generator.currentPreset = p;
            this.generator.currentSeed = seedVal;

            if (sizeChanged) {
                this.generator.setSize(newW, newH);
                // Reset pan/zoom to fit height
                const fitScale = window.innerHeight / newH;
                this.canvasManager.scale = fitScale;
                this.canvasManager.offsetX = (window.innerWidth - (newW * fitScale)) / 2;
                this.canvasManager.offsetY = 0;
            }

            this.generator.generate();
            this.nationsStateDirty = true;
            this.hoveredNationIndex = -1;
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
                } else if (this.currentLayer === 'Nations') {
                    // Nations layer uses cached canvas — skip pixel loop entry
                    // (handled by drawImage below; set transparent so we don't paint over it)
                    data[(ry * renderWidth + rx) * 4 + 3] = 0;
                    continue;
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

        // For Nations layer: blit the pre-rendered cached canvas on top
        if (this.currentLayer === 'Nations') {
            // Lazy build / rebuild after generation
            if (!this.nationsCanvas || this.nationsStateDirty) {
                this.buildNationsCache();
                this.nationsStateDirty = false;
            }
            if (this.nationsCanvas) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.imageSmoothingEnabled = false;
                const mapPixW = world.width * scale;
                const startCopy = Math.floor(-offsetX / mapPixW);
                const endCopy = Math.ceil((width - offsetX) / mapPixW);
                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const dx = offsetX + copy * mapPixW;
                    ctx.drawImage(this.nationsCanvas, dx, offsetY, mapPixW, world.height * scale);
                }
            }
        }

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

        // Render city markers for the Nations layer
        if (this.currentLayer === 'Nations' && !isInteracting) {
            ctx.save();
            ctx.translate(offsetX, offsetY);
            ctx.scale(scale, scale);

            const mapPixelWidth = world.width * scale;
            const startCopy = Math.floor(-offsetX / mapPixelWidth);
            const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

            // Draw smaller cities first (villages -> towns -> capitals) so capitals render on top
            const sortedCities = [...world.cities].sort((a, b) => a.size - b.size);

            for (const city of sortedCities) {
                const isHovered = city.nationIndex === this.hoveredNationIndex;
                const nation = world.nations[city.nationIndex];
                if (!nation) continue;
                const nc = this.hexToRgb(nation.color);
                const colorStr = `rgb(${nc[0]}, ${nc[1]}, ${nc[2]})`;
                ctx.globalAlpha = isHovered ? 1.0 : (city.isCapital ? 0.85 : 0.65);

                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const cx = city.x + copy * world.width;
                    const cy = city.y;

                    if (city.isCapital) {
                        // Capital: diamond shape + outer glow ring
                        const s = isHovered ? 4.5 : 3.2;
                        ctx.save();
                        ctx.translate(cx, cy);
                        ctx.rotate(Math.PI / 4);
                        ctx.strokeStyle = colorStr;
                        ctx.lineWidth = (isHovered ? 1.2 : 0.8) / scale;
                        ctx.strokeRect(-s / 2, -s / 2, s, s);
                        ctx.fillStyle = colorStr;
                        ctx.globalAlpha = isHovered ? 0.6 : 0.35;
                        ctx.fillRect(-s / 2, -s / 2, s, s);
                        ctx.globalAlpha = isHovered ? 1.0 : 0.85;
                        ctx.restore();

                        // Outer ring
                        ctx.beginPath();
                        ctx.arc(cx, cy, isHovered ? 6 : 4.5, 0, Math.PI * 2);
                        ctx.strokeStyle = colorStr;
                        ctx.lineWidth = (isHovered ? 1 : 0.6) / scale;
                        ctx.globalAlpha = isHovered ? 0.7 : 0.45;
                        ctx.stroke();
                        ctx.globalAlpha = isHovered ? 1.0 : 0.85;

                    } else if (city.size === 1) {
                        // Town: circle with fill
                        ctx.beginPath();
                        ctx.arc(cx, cy, isHovered ? 2.8 : 2, 0, Math.PI * 2);
                        ctx.strokeStyle = colorStr;
                        ctx.lineWidth = (isHovered ? 1 : 0.7) / scale;
                        ctx.stroke();
                        ctx.fillStyle = colorStr;
                        ctx.globalAlpha = isHovered ? 0.5 : 0.25;
                        ctx.fill();
                        ctx.globalAlpha = isHovered ? 1.0 : 0.65;

                    } else {
                        // Village: small dot
                        ctx.beginPath();
                        ctx.arc(cx, cy, isHovered ? 1.8 : 1.2, 0, Math.PI * 2);
                        ctx.fillStyle = colorStr;
                        ctx.fill();
                    }
                }
            }

            ctx.globalAlpha = 1.0;
            ctx.restore();
        }

    }

    private updateHover(clientX: number, clientY: number) {
        const world = this.generator.getWorld();
        const cm = this.canvasManager;
        const rect = cm.canvas.getBoundingClientRect();
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;

        const wx = Math.round((sx - cm.offsetX) / cm.scale);
        const wy = Math.round((sy - cm.offsetY) / cm.scale);

        const x = ((wx % world.width) + world.width) % world.width;
        const y = wy;

        let newHovered = -1;
        if (y >= 0 && y < world.height) {
            const cell = world.grid[x][y];
            if (!cell.isWater && cell.nationIndex !== undefined && cell.nationIndex >= 0) {
                newHovered = cell.nationIndex;
            }
        }

        if (newHovered !== this.hoveredNationIndex) {
            const prev = this.hoveredNationIndex;
            this.hoveredNationIndex = newHovered;
            // Patch only the changed nations into the cache — no full re-render
            this.applyHoverToCache(newHovered, prev);
            this.canvasManager.scheduleRender();
        }

        if (newHovered >= 0 && newHovered < world.nations.length) {
            const nation = world.nations[newHovered];
            // Find nearest city of this nation to cursor (in world space)
            let nearestCity = null;
            let nearestDist = Infinity;
            for (const city of world.cities) {
                if (city.nationIndex !== newHovered) continue;
                let dx = Math.abs(wx - city.x);
                if (dx > world.width / 2) dx = world.width - dx;
                const dist = Math.hypot(dx, wy - city.y);
                if (dist < nearestDist) { nearestDist = dist; nearestCity = city; }
            }
            const cityThreshold = 10 / cm.scale; // ~10 screen pixels
            if (nearestCity && nearestDist < cityThreshold) {
                const typeLabel = nearestCity.isCapital ? '♦ Capital' : nearestCity.size === 1 ? '● Town' : '· Village';
                this.showTooltip(clientX, clientY, nearestCity.name, `${typeLabel} · ${nation.name}`);
            } else {
                const cityCount = world.cities.filter(c => c.nationIndex === newHovered && !c.isCapital).length;
                this.showTooltip(clientX, clientY, nation.name, `${cityCount} cities`);
            }
        } else {
            this.hideTooltip();
        }

    }

    private buildNationsCache() {
        const world = this.generator.getWorld();
        const W = world.width;
        const H = world.height;

        // Build per-nation flat cell indices
        this.nationCellsList = world.nations.map(() => []);
        for (let x = 0; x < W; x++) {
            for (let y = 0; y < H; y++) {
                const cell = world.grid[x][y];
                if (!cell.isWater && cell.nationIndex !== undefined && cell.nationIndex >= 0) {
                    this.nationCellsList[cell.nationIndex].push(y * W + x);
                }
            }
        }

        // Render base (resting, no hover) into ImageData at map resolution
        const id = new ImageData(W, H);
        const data = id.data;
        const ncCache = world.nations.map(n => this.hexToRgb(n.color));

        for (let x = 0; x < W; x++) {
            for (let y = 0; y < H; y++) {
                const cell = world.grid[x][y];
                const base = this.hexToRgb(BIOME_COLORS[cell.biome]);
                let r = Math.floor(base[0] * 0.45);
                let g = Math.floor(base[1] * 0.45);
                let b = Math.floor(base[2] * 0.45);

                const nIdx = cell.nationIndex ?? -1;
                if (nIdx >= 0 && nIdx < world.nations.length) {
                    const nc = ncCache[nIdx];
                    if (cell.isNationBorder) {
                        r = Math.floor(nc[0] * 0.75);
                        g = Math.floor(nc[1] * 0.75);
                        b = Math.floor(nc[2] * 0.75);
                    } else {
                        r = Math.floor(r * 0.86 + nc[0] * 0.14);
                        g = Math.floor(g * 0.86 + nc[1] * 0.14);
                        b = Math.floor(b * 0.86 + nc[2] * 0.14);
                    }
                }

                const i = (y * W + x) * 4;
                data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
            }
        }

        this.nationsBaseData = new Uint8ClampedArray(data);
        this.nationsActiveData = new Uint8ClampedArray(data);

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        canvas.getContext('2d')!.putImageData(id, 0, 0);
        this.nationsCanvas = canvas;
    }

    /** Restore old nation's pixels to base, brighten new nation's pixels. O(nation_cells) only. */
    private applyHoverToCache(newIdx: number, oldIdx: number = -1) {
        if (!this.nationsCanvas || !this.nationsBaseData || !this.nationsActiveData) return;
        const world = this.generator.getWorld();
        const W = world.width;
        const ctx = this.nationsCanvas.getContext('2d')!;

        const restoreIds = oldIdx >= 0 ? this.nationCellsList[oldIdx] ?? [] : [];
        const highlightIds = newIdx >= 0 ? this.nationCellsList[newIdx] ?? [] : [];

        // Work on active buffer
        const active = this.nationsActiveData;
        const base = this.nationsBaseData;

        // Restore previous hovered nation back to base
        for (const flatIdx of restoreIds) {
            const i = flatIdx * 4;
            active[i] = base[i]; active[i + 1] = base[i + 1]; active[i + 2] = base[i + 2];
        }

        // Apply bright highlight to new hovered nation
        if (newIdx >= 0 && newIdx < world.nations.length) {
            const nc = this.hexToRgb(world.nations[newIdx].color);
            for (const flatIdx of highlightIds) {
                const x = flatIdx % W;
                const y = Math.floor(flatIdx / W);
                const cell = world.grid[x][y];
                const i = flatIdx * 4;
                if (cell.isNationBorder) {
                    active[i] = nc[0]; active[i + 1] = nc[1]; active[i + 2] = nc[2];
                } else {
                    // Brighter fill blend compared to base 14%
                    active[i] = Math.floor(base[i] * 0.62 + nc[0] * 0.38);
                    active[i + 1] = Math.floor(base[i + 1] * 0.62 + nc[1] * 0.38);
                    active[i + 2] = Math.floor(base[i + 2] * 0.62 + nc[2] * 0.38);
                }
            }
        }

        // Push changes to the offscreen canvas
        ctx.putImageData(new ImageData(new Uint8ClampedArray(active), W, world.height), 0, 0);
    }

    private showTooltip(x: number, y: number, name: string, detail: string) {
        const tooltip = document.getElementById('nation-tooltip');
        if (!tooltip) return;
        (tooltip.querySelector('.tooltip-name') as HTMLElement).textContent = name;
        (tooltip.querySelector('.tooltip-detail') as HTMLElement).textContent = detail;
        tooltip.style.display = 'block';
        tooltip.style.left = `${x + 16}px`;
        tooltip.style.top = `${y + 16}px`;
    }

    private hideTooltip() {
        const tooltip = document.getElementById('nation-tooltip');
        if (tooltip) tooltip.style.display = 'none';
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
