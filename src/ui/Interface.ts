import { MapGenerator } from '../game/MapGenerator';
import type { Preset } from '../game/MapGenerator';
import { BIOME_COLORS } from '../game/WorldData';
import { CanvasManager } from '../core/CanvasManager';
import { GPURenderer } from '../core/GPURenderer';

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
    private nationCentroids: { x: number, y: number }[] = [];
    private nationSizes: number[] = []; // Relative size (0 to 1) 
    private nationsStateDirty: boolean = true; // rebuilt on next Nations render

    // GPU rendering
    private gpuRenderer!: GPURenderer;
    private gpuCanvas: HTMLCanvasElement;

    constructor(generator: MapGenerator, canvasManager: CanvasManager) {
        this.generator = generator;
        this.canvasManager = canvasManager;

        // Initialize GPU Renderer with an offscreen canvas
        this.gpuCanvas = document.createElement('canvas');
        try {
            this.gpuRenderer = new GPURenderer(this.gpuCanvas);
            // Initial generation so we don't start with an empty ocean
            console.log("Starting initial generation...");
            this.showLoadingModal();
            this.generator.generate((pct) => {
                this.updateLoadingModal(pct);
            }).then(() => {
                const world = this.generator.getWorld();
                console.log("Initial generation complete. Sample elevation at 10,10:", world.grid[10][10]?.elevation);
                this.gpuRenderer.updateWorldTexture(world);
                console.log("GPURenderer initialized and texture updated");
                this.hideLoadingModal();
                this.canvasManager.scheduleRender();
            });
        } catch (e) {
            console.error("Failed to initialize GPURenderer:", e);
        }

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

        generateBtn.addEventListener('click', async () => {
            if (generateBtn.classList.contains('loading')) return;

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

            // Update UI to loading state
            generateBtn.classList.add('loading');
            generateBtn.style.setProperty('--progress', '0%');
            const originalText = generateBtn.textContent;

            try {
                this.showLoadingModal();
                await this.generator.generate((pct) => {
                    generateBtn.textContent = `${pct}%`;
                    generateBtn.style.setProperty('--progress', `${pct}%`);
                    this.updateLoadingModal(pct);
                });

                const world = this.generator.getWorld();
                this.gpuRenderer.updateWorldTexture(world);
                this.nationsStateDirty = true;
                this.hoveredNationIndex = -1;
                this.hideLoadingModal();
                this.canvasManager.scheduleRender();
            } finally {
                generateBtn.classList.remove('loading');
                generateBtn.textContent = originalText;
                generateBtn.style.setProperty('--progress', '0%');
            }
        });
    }

    private renderMap(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) {
        const world = this.generator.getWorld();

        // Enforce zoom and pan limits
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

        // --- GPU RENDER PHASE ---
        const layerMap: Record<ViewLayer, number> = {
            'Biomes': 0,
            'Elevation': 1,
            'Heatmap': 2,
            'Moisture': 3,
            'Nations': 0 // Nations handled by cached canvas blit below
        };

        if (this.currentLayer !== 'Nations') {
            // Resize GPU canvas to match viewport if needed
            if (this.gpuCanvas.width !== width || this.gpuCanvas.height !== height) {
                this.gpuCanvas.width = width;
                this.gpuCanvas.height = height;
            }

            this.gpuRenderer.render(
                width, height,
                world.width, world.height,
                scale, offsetX, offsetY,
                layerMap[this.currentLayer]
            );

            // Draw GPU output to main 2D context
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(this.gpuCanvas, 0, 0);
        } else {
            // Pre-fill everything with ambient Ocean color for Nations layer
            ctx.fillStyle = '#1C3E5A';
            ctx.fillRect(0, 0, width, height);
        }

        // --- OVERLAY PHASE (Nations, Rivers, Cities, Labels) ---


        // End Overlay Phase 

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

                    // Base dots: Dark gray/black with a white halo for high contrast
                    const isCapital = city.isCapital;
                    const radius = isCapital ? 3.8 : (city.size === 1 ? 2.5 : 1.5);
                    const dotColor = '#1a1a1c';
                    const haloColor = 'rgba(255, 255, 255, 0.9)';
                    const highlightColor = colorStr;

                    // 1. Draw Halo (White outline for visibility on any background)
                    ctx.beginPath();
                    ctx.arc(cx, cy, radius + 0.6 / scale, 0, Math.PI * 2);
                    ctx.fillStyle = haloColor;
                    ctx.fill();

                    // 2. Draw Main Dot
                    ctx.beginPath();
                    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                    ctx.fillStyle = isHovered ? highlightColor : dotColor;
                    ctx.fill();

                    // 3. Optional inner detail for Capital
                    if (isCapital) {
                        ctx.beginPath();
                        ctx.arc(cx, cy, radius * 0.45, 0, Math.PI * 2);
                        ctx.fillStyle = isHovered ? '#FFF' : 'rgba(255,255,255,0.2)';
                        ctx.fill();
                    }
                }
            }

            ctx.globalAlpha = 1.0;
            ctx.restore();
        }

        // Render Labels (Nations, Cities)
        this.renderLabels(ctx, width, height, scale, offsetX, offsetY, isInteracting);
    }

    private renderLabels(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) {
        const world = this.generator.getWorld();
        const mapPixelWidth = world.width * scale;
        const startCopy = Math.floor(-offsetX / mapPixelWidth);
        const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

        // Simple collision detection: track occupied regions
        const occupiedRects: { x: number, y: number, w: number, h: number }[] = [];
        const checkCollision = (x: number, y: number, w: number, h: number) => {
            const pad = 6; // Padding between labels
            for (const r of occupiedRects) {
                if (x < r.x + r.w + pad && x + w + pad > r.x &&
                    y < r.y + r.h + pad && y + h + pad > r.y) return true;
            }
            return false;
        };

        ctx.save();
        // Reset transform to screen space for easier collision and sharp text
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const drawLabelWithHalo = (text: string, sx: number, sy: number, font: string, color: string, haloColor: string = 'rgba(255,255,255,0.45)', haloWidth: number = 3) => {
            ctx.font = font;
            const metrics = ctx.measureText(text);
            const textW = metrics.width;
            const textH = parseInt(font) || 12;

            const lx = sx - textW / 2;
            const ly = sy - textH / 2;

            if (checkCollision(lx, ly, textW, textH)) return false;

            // Very subtle halo (soft glow)
            ctx.strokeStyle = haloColor;
            ctx.lineWidth = haloWidth;
            ctx.lineJoin = 'round';
            ctx.strokeText(text, sx, sy);

            // Draw text
            ctx.fillStyle = color;
            ctx.fillText(text, sx, sy);

            occupiedRects.push({ x: lx, y: ly, w: textW, h: textH });
            return true;
        };

        // 1. Render Nation Names (Area-based scaling)
        if (scale > 0.3) {
            const nationAlpha = Math.min(1.0, (scale - 0.25) * 4);

            // Sort nations by size to prioritize larger ones in collision detection
            const sortedNations = [...world.nations].sort((a, b) =>
                (this.nationSizes[b.id] || 0) - (this.nationSizes[a.id] || 0)
            );

            for (const nation of sortedNations) {
                const sizeFactor = this.nationSizes[nation.id] || 0.5;
                // Area-based font size: nations with more territory get larger labels
                const baseSize = 9 + sizeFactor * 10;
                const fontSize = Math.max(9, Math.floor(baseSize * Math.sqrt(scale)));
                const font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
                const labelColor = `rgba(35, 35, 40, ${nationAlpha * 0.9})`;

                const centroid = this.nationCentroids[nation.id] || { x: nation.capitalX, y: nation.capitalY };

                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const sx = (centroid.x + copy * world.width) * scale + offsetX;
                    const sy = centroid.y * scale + offsetY;

                    if (sx < -200 || sx > width + 200 || sy < -100 || sy > height + 100) continue;

                    // Subtle tracking for medium/large nations
                    const tracking = sizeFactor > 0.5 ? ' ' : '';
                    const spacedName = nation.name.toUpperCase().split('').join(tracking);
                    drawLabelWithHalo(spacedName, sx, sy, font, labelColor, `rgba(255, 255, 255, ${0.4 * nationAlpha})`, 4);
                }
            }
        }

        // 2. Render City Names (Higher priority for larger cities)
        if (scale > 0.8 && !isInteracting) {
            const cityAlpha = Math.min(1.0, (scale - 0.8) * 2.5);
            const capitalFont = `bold 12px system-ui, sans-serif`;
            const cityFont = `500 11px system-ui, sans-serif`;

            const sortedCities = [...world.cities].sort((a, b) => {
                if (a.isCapital && !b.isCapital) return -1;
                if (!a.isCapital && b.isCapital) return 1;
                return b.size - a.size;
            });

            for (const city of sortedCities) {
                let visible = false;
                if (city.isCapital) visible = true;
                if (city.size >= 1 && scale > 1.4) visible = true;
                if (city.size === 0 && scale > 2.5) visible = true;

                if (!visible) continue;

                const font = city.isCapital ? capitalFont : cityFont;
                const labelColor = `rgba(45, 45, 50, ${cityAlpha * 0.85})`;

                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const sx = (city.x + copy * world.width) * scale + offsetX;
                    const sy = city.y * scale + offsetY + (city.isCapital ? 12 : 9);

                    if (sx < -100 || sx > width + 100 || sy < -50 || sy > height + 50) continue;

                    drawLabelWithHalo(city.name, sx, sy, font, labelColor, `rgba(255, 255, 255, ${0.3 * cityAlpha})`, 2.5);
                }
            }
        }

        ctx.restore();
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

        // Build per-nation flat cell indices and calculate centroids/sizes
        this.nationCellsList = world.nations.map(() => []);
        this.nationCentroids = world.nations.map(() => ({ x: 0, y: 0 }));
        this.nationSizes = world.nations.map(() => 0);

        for (let x = 0; x < W; x++) {
            for (let y = 0; y < H; y++) {
                const cell = world.grid[x][y];
                if (!cell.isWater && cell.nationIndex !== undefined && cell.nationIndex >= 0) {
                    this.nationCellsList[cell.nationIndex].push(y * W + x);
                    this.nationCentroids[cell.nationIndex].x += x;
                    this.nationCentroids[cell.nationIndex].y += y;
                }
            }
        }

        // Finalize statistics
        let maxArea = 0;
        for (let i = 0; i < world.nations.length; i++) {
            const area = this.nationCellsList[i].length;
            if (area > maxArea) maxArea = area;
            if (area > 0) {
                this.nationCentroids[i].x /= area;
                this.nationCentroids[i].y /= area;
            } else {
                this.nationCentroids[i].x = world.nations[i].capitalX;
                this.nationCentroids[i].y = world.nations[i].capitalY;
            }
        }

        // Calculate relative sizes for font scaling (0 to 1)
        for (let i = 0; i < world.nations.length; i++) {
            const area = this.nationCellsList[i].length;
            this.nationSizes[i] = maxArea > 0 ? Math.sqrt(area / maxArea) : 0.5;
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
    private showLoadingModal() {
        const modal = document.getElementById('loading-modal');
        if (modal) {
            modal.style.display = 'flex';
            this.updateLoadingModal(0);
        }
    }

    private hideLoadingModal() {
        const modal = document.getElementById('loading-modal');
        if (modal) modal.style.display = 'none';
    }

    private updateLoadingModal(pct: number) {
        const modal = document.getElementById('loading-modal');
        if (!modal) return;

        const fill = modal.querySelector('.loader-progress-fill') as HTMLElement;
        const text = modal.querySelector('.loader-percentage') as HTMLElement;
        const subtext = modal.querySelector('.loader-subtext') as HTMLElement;

        if (fill) fill.style.width = `${pct}%`;
        if (text) text.textContent = `${pct}%`;

        if (subtext) {
            if (pct < 20) subtext.textContent = "Adding mountains and valleys...";
            else if (pct < 40) subtext.textContent = "Determining rainfall patterns...";
            else if (pct < 60) subtext.textContent = "Spreading forests and deserts...";
            else if (pct < 80) subtext.textContent = "Generating river systems...";
            else if (pct < 95) subtext.textContent = "Establishing national borders...";
            else subtext.textContent = "Founding cities and capitals...";
        }
    }
}
