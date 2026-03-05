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
    private nationCellsList: number[][] = [];
    private nationCentroids: { x: number, y: number }[] = [];
    private nationSizes: number[] = []; // Relative size (0 to 1) 
    private nationsStateDirty: boolean = true; // rebuilt on next Nations render
    private activeTab: 'generate' | 'nations' = 'generate';
    private isEditingNations: boolean = false;
    private selectedNationIndex: number = -1;
    private isPainting: boolean = false;
    private lastPaintedX: number | null = null;
    private lastPaintedY: number | null = null;
    private brushSize: number = 2;

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

        // Track mouse for interaction differentiation
        let mousedownX = 0;
        let mousedownY = 0;
        let isAttemptingPaint = false;

        // Track mouse for hover
        const canvas = this.canvasManager.canvas;
        canvas.addEventListener('mousemove', (e) => {
            if (this.currentLayer === 'Nations' && !this.isEditingNations) {
                this.updateHover(e.clientX, e.clientY);
            } else if (this.activeTab === 'nations' && this.isEditingNations) {
                if (isAttemptingPaint && !this.isPainting) {
                    // Check if moved enough to be a drag
                    const dist = Math.hypot(e.clientX - mousedownX, e.clientY - mousedownY);
                    if (dist > 3) {
                        this.isPainting = true;
                        this.lastPaintedX = null;
                        this.lastPaintedY = null;
                    }
                }
                if (this.isPainting) {
                    this.handlePainting(e.clientX, e.clientY);
                }
            }
        });
        canvas.addEventListener('mousedown', (e) => {
            if (this.activeTab === 'nations' && this.isEditingNations && e.button === 0) {
                const world = this.generator.getWorld();
                const cm = this.canvasManager;
                const rect = cm.canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const wx = Math.floor((sx - cm.offsetX) / cm.scale);
                const wy = Math.floor((sy - cm.offsetY) / cm.scale);
                const x = ((wx % world.width) + world.width) % world.width;

                if (wy >= 0 && wy < world.height) {
                    const cell = world.grid[x][wy];
                    if (cell.isWater) {
                        // Quick exit: click on water turns off edit mode
                        this.isEditingNations = false;
                        const btn = document.getElementById('btn-edit-nations');
                        btn?.parentElement?.classList.remove('edit-mode-active');
                        this.canvasManager.panningLocked = false;
                        this.canvasManager.canvas.style.cursor = 'grab';
                        this.canvasManager.scheduleRender();
                        return;
                    }
                }

                if (this.selectedNationIndex !== -1) {
                    // Flag that we want to paint, but wait for movement to distinguish from dblclick
                    isAttemptingPaint = true;
                    mousedownX = e.clientX;
                    mousedownY = e.clientY;
                }
            }
        });

        canvas.addEventListener('dblclick', (e) => {
            if (this.activeTab === 'nations' && this.isEditingNations && e.button === 0) {
                isAttemptingPaint = false; // Cancel any pending paint
                this.isPainting = false;
                const world = this.generator.getWorld();
                const cm = this.canvasManager;
                const rect = cm.canvas.getBoundingClientRect();
                const sx = e.clientX - rect.left;
                const sy = e.clientY - rect.top;
                const wx = Math.floor((sx - cm.offsetX) / cm.scale);
                const wy = Math.floor((sy - cm.offsetY) / cm.scale);
                const x = ((wx % world.width) + world.width) % world.width;

                if (wy >= 0 && wy < world.height) {
                    const cell = world.grid[x][wy];

                    // Nation selection on double click
                    if (!cell.isWater && cell.nationIndex !== undefined && cell.nationIndex !== -1 && cell.nationIndex !== this.selectedNationIndex) {
                        this.selectedNationIndex = cell.nationIndex;
                        this.isPainting = false; // Stop any accidental painting start
                        this.renderNationsList();

                        const target = document.querySelector(`.nation-item[data-index="${this.selectedNationIndex}"]`);
                        target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                }
            }
        });
        window.addEventListener('mouseup', () => {
            isAttemptingPaint = false;
            if (this.isPainting) {
                this.isPainting = false;
                this.lastPaintedX = null;
                this.lastPaintedY = null;
                this.updateNationStatistics();
                this.canvasManager.scheduleRender();
            }
        });
        canvas.addEventListener('mouseleave', () => {
            if (this.currentLayer === 'Nations') {
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

        // Tabs
        const tabGenerate = document.getElementById('tab-generate');
        const tabNations = document.getElementById('tab-nations');
        const contentGenerate = document.getElementById('content-generate');
        const contentNations = document.getElementById('content-nations');

        if (tabGenerate && tabNations && contentGenerate && contentNations) {
            tabGenerate.addEventListener('click', () => {
                this.activeTab = 'generate';
                tabGenerate.classList.add('active');
                tabNations.classList.remove('active');
                contentGenerate.classList.add('active');
                contentNations.classList.remove('active');
            });

            tabNations.addEventListener('click', () => {
                this.activeTab = 'nations';
                tabNations.classList.add('active');
                tabGenerate.classList.remove('active');
                contentNations.classList.add('active');
                contentGenerate.classList.remove('active');
                this.renderNationsList();
            });
        }

        // Nation Editing
        const btnEditNations = document.getElementById('btn-edit-nations') as HTMLButtonElement;
        if (btnEditNations) {
            btnEditNations.addEventListener('click', () => {
                this.isEditingNations = !this.isEditingNations;
                btnEditNations.parentElement?.classList.toggle('edit-mode-active', this.isEditingNations);

                if (this.isEditingNations) {
                    this.canvasManager.panningLocked = true;
                    this.canvasManager.canvas.style.cursor = 'default';
                    this.currentLayer = 'Nations';
                    document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
                    document.getElementById('layer-nations')?.classList.add('active');
                    this.canvasManager.scheduleRender();
                } else {
                    this.canvasManager.panningLocked = false;
                    this.canvasManager.canvas.style.cursor = 'grab';
                }
            });
        }

        const brushSlider = document.getElementById('brush-size') as HTMLInputElement;
        const brushValueDisp = document.getElementById('brush-size-value');
        if (brushSlider && brushValueDisp) {
            brushSlider.addEventListener('input', () => {
                this.brushSize = parseInt(brushSlider.value);
                brushValueDisp.textContent = this.brushSize.toString();
            });
        }

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
                const fitScale = window.innerHeight / newH;
                this.canvasManager.scale = fitScale;
                this.canvasManager.offsetX = (window.innerWidth - (newW * fitScale)) / 2;
                this.canvasManager.offsetY = 0;
            }

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

    private renderNationsList() {
        // Prevent clearing the list if the user is currently typing
        if (document.activeElement?.classList.contains('nation-name-input')) return;

        const listContainer = document.getElementById('nations-list');
        if (!listContainer) return;

        const world = this.generator.getWorld();
        listContainer.innerHTML = '';

        world.nations.forEach((nation, idx) => {
            const item = document.createElement('div');
            item.className = `nation-item ${this.selectedNationIndex === idx ? 'selected' : ''}`;
            item.dataset.index = idx.toString();

            const swatch = document.createElement('div');
            swatch.className = 'nation-color-swatch';
            swatch.style.backgroundColor = nation.color;

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'nation-name-input';
            nameInput.value = nation.name;
            nameInput.addEventListener('change', (e) => {
                nation.name = (e.target as HTMLInputElement).value;
                this.canvasManager.scheduleRender();
            });
            nameInput.addEventListener('mousedown', (e) => e.stopPropagation());
            nameInput.addEventListener('click', (e) => e.stopPropagation());

            const territoryCount = document.createElement('span');
            territoryCount.className = 'nation-territory-count';
            const area = this.nationCellsList[idx]?.length || 0;
            territoryCount.textContent = `${area} px²`;

            item.appendChild(swatch);
            item.appendChild(nameInput);
            item.appendChild(territoryCount);

            item.addEventListener('click', () => {
                this.selectedNationIndex = idx;
                this.renderNationsList();
            });

            item.addEventListener('mouseenter', () => {
                if (this.isPainting) return;
                this.hoveredNationIndex = idx;
                this.canvasManager.scheduleRender();
            });

            item.addEventListener('mouseleave', () => {
                if (this.isPainting) return;
                this.hoveredNationIndex = -1;
                this.canvasManager.scheduleRender();
            });

            listContainer.appendChild(item);
        });
    }

    private handlePainting(clientX: number, clientY: number) {
        if (!this.isPainting || this.selectedNationIndex === -1) return;

        const cm = this.canvasManager;
        const rect = cm.canvas.getBoundingClientRect();
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;

        // Using floor for more consistent mapping
        const wx = Math.floor((sx - cm.offsetX) / cm.scale);
        const wy = Math.floor((sy - cm.offsetY) / cm.scale);

        let minX = wx, minY = wy, maxX = wx, maxY = wy;

        if (this.lastPaintedX === null || this.lastPaintedY === null) {
            this.paintAt(wx, wy);
        } else {
            const dx = wx - this.lastPaintedX;
            const dy = wy - this.lastPaintedY;
            const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
            for (let i = 0; i <= steps; i++) {
                const px = Math.floor(this.lastPaintedX + (dx * i) / steps);
                const py = Math.floor(this.lastPaintedY + (dy * i) / steps);
                this.paintAt(px, py);
                minX = Math.min(minX, px); minY = Math.min(minY, py);
                maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
            }
        }

        // Trigger a GPU texture update directly for the affected area!
        // Rather than updating the entire texture, we can just rebuild it for now
        // since updateNationsDataTexture is very fast (just copies a Uint8Array)
        this.gpuRenderer.updateNationsDataTexture(this.generator.getWorld());
        this.canvasManager.scheduleRender();
        this.renderNationsList();
    }

    private paintAt(wx: number, wy: number) {
        const world = this.generator.getWorld();
        const brushSize = this.brushSize;
        const radiusSq = (brushSize / 2) * (brushSize / 2);
        const offset = Math.floor(brushSize / 2);

        for (let dx = 0; dx < brushSize; dx++) {
            for (let dy = 0; dy < brushSize; dy++) {
                const lx = dx - offset;
                const ly = dy - offset;

                // Circular check (using squared distance for performance)
                if (lx * lx + ly * ly > radiusSq + 0.25) continue;

                const tx = ((wx + lx % world.width) + world.width) % world.width;
                const ty = wy + ly;

                if (ty >= 0 && ty < world.height) {
                    const cell = world.grid[tx][ty];
                    if (!cell.isWater && cell.nationIndex !== this.selectedNationIndex) {
                        const oldIdx = cell.nationIndex ?? -1;
                        cell.nationIndex = this.selectedNationIndex;

                        if (oldIdx !== -1) {
                            const oldList = this.nationCellsList[oldIdx];
                            const flatIdx = ty * world.width + tx;
                            const listIdx = oldList.indexOf(flatIdx);
                            if (listIdx > -1) oldList.splice(listIdx, 1);
                        }
                        this.nationCellsList[this.selectedNationIndex].push(ty * world.width + tx);

                        this.updateLocalBorders(tx, ty);
                    }
                }
            }
        }
    }

    private updateLocalBorders(x: number, y: number) {
        const world = this.generator.getWorld();
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const tx = ((x + dx) % world.width + world.width) % world.width;
                const ty = y + dy;

                if (ty >= 0 && ty < world.height) {
                    const cell = world.grid[tx][ty];
                    if (cell.isWater) continue;

                    let isBorder = false;
                    const nid = cell.nationIndex;
                    neighborLoop:
                    for (let nxd = -1; nxd <= 1; nxd++) {
                        for (let nyd = -1; nyd <= 1; nyd++) {
                            if (nxd === 0 && nyd === 0) continue;
                            const nx = ((tx + nxd) % world.width + world.width) % world.width;
                            const ny = ty + nyd;
                            if (ny >= 0 && ny < world.height) {
                                const nb = world.grid[nx][ny];
                                if (nb.isWater || (nb.nationIndex ?? -1) !== nid) {
                                    isBorder = true;
                                    break neighborLoop;
                                }
                            }
                        }
                    }
                    cell.isNationBorder = isBorder;
                }
            }
        }
    }

    private renderMap(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) {
        const world = this.generator.getWorld();
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

        const layerMap: Record<ViewLayer, number> = {
            'Biomes': 0, 'Elevation': 1, 'Heatmap': 2, 'Moisture': 3, 'Nations': 4
        };

        if (this.currentLayer === 'Nations') {
            if (this.nationsStateDirty) {
                this.buildNationsCache();
                this.gpuRenderer.updateNationsDataTexture(world);
                this.nationsStateDirty = false;
            }
        }

        if (this.gpuCanvas.width !== width || this.gpuCanvas.height !== height) {
            this.gpuCanvas.width = width;
            this.gpuCanvas.height = height;
        }

        let hoverColor: number[] | undefined = undefined;
        if (this.currentLayer === 'Nations' && this.hoveredNationIndex >= 0 && this.hoveredNationIndex < world.nations.length) {
            const hColor = this.hexToRgb(world.nations[this.hoveredNationIndex].color);
            hoverColor = [hColor[0] / 255, hColor[1] / 255, hColor[2] / 255];
        }

        this.gpuRenderer.render(width, height, world.width, world.height, scale, offsetX, offsetY, layerMap[this.currentLayer], hoverColor);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.gpuCanvas, 0, 0);

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        if (this.currentLayer === 'Biomes' || this.currentLayer === 'Elevation') {
            const riverColor = this.hexToRgb(BIOME_COLORS['Shallow Water']);
            ctx.strokeStyle = `rgb(${riverColor[0]}, ${riverColor[1]}, ${riverColor[2]})`;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.lineWidth = 1.5;

            const mapPixelWidth = world.width * scale;
            const startCopy = Math.floor(-offsetX / mapPixelWidth);
            const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);

            for (let copy = startCopy; copy <= endCopy; copy++) {
                ctx.save();
                ctx.translate(copy * world.width, 0);
                ctx.beginPath();
                if (world.rivers) {
                    for (const river of world.rivers) {
                        if (river.length === 0) continue;
                        ctx.moveTo(river[0].x, river[0].y);
                        for (let i = 1; i < river.length; i++) {
                            let rx = river[i].x;
                            let prevRx = river[i - 1].x;
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

        if (this.currentLayer === 'Nations' && !isInteracting) {
            ctx.save();
            ctx.translate(offsetX, offsetY);
            ctx.scale(scale, scale);

            const mapPixelWidth = world.width * scale;
            const startCopy = Math.floor(-offsetX / mapPixelWidth);
            const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);
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
                    const isCapital = city.isCapital;
                    const radius = isCapital ? 3.8 : (city.size === 1 ? 2.5 : 1.5);
                    const dotColor = '#1a1a1c';
                    const haloColor = 'rgba(255, 255, 255, 0.9)';
                    const highlightColor = colorStr;

                    ctx.beginPath();
                    ctx.arc(cx, cy, radius + 0.6 / scale, 0, Math.PI * 2);
                    ctx.fillStyle = haloColor;
                    ctx.fill();

                    ctx.beginPath();
                    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                    ctx.fillStyle = isHovered ? highlightColor : dotColor;
                    ctx.fill();

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

        this.renderLabels(ctx, width, height, scale, offsetX, offsetY, isInteracting);
    }

    private renderLabels(ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) {
        const world = this.generator.getWorld();
        const mapPixelWidth = world.width * scale;
        const startCopy = Math.floor(-offsetX / mapPixelWidth);
        const endCopy = Math.ceil((width - offsetX) / mapPixelWidth);
        const occupiedRects: { x: number, y: number, w: number, h: number }[] = [];

        const checkCollision = (x: number, y: number, w: number, h: number) => {
            const pad = 6;
            for (const r of occupiedRects) {
                if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y) return true;
            }
            return false;
        };

        ctx.save();
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
            ctx.strokeStyle = haloColor;
            ctx.lineWidth = haloWidth;
            ctx.lineJoin = 'round';
            ctx.strokeText(text, sx, sy);
            ctx.fillStyle = color;
            ctx.fillText(text, sx, sy);
            occupiedRects.push({ x: lx, y: ly, w: textW, h: textH });
            return true;
        };

        if (scale > 0.3) {
            const nationAlpha = Math.min(1.0, (scale - 0.25) * 4);
            const sortedNations = [...world.nations].sort((a, b) => (this.nationSizes[b.id] || 0) - (this.nationSizes[a.id] || 0));

            for (const nation of sortedNations) {
                const sizeFactor = this.nationSizes[nation.id] || 0.5;
                const baseSize = 9 + sizeFactor * 10;
                const fontSize = Math.max(9, Math.floor(baseSize * Math.sqrt(scale)));
                const font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
                const labelColor = `rgba(35, 35, 40, ${nationAlpha * 0.9})`;
                const centroid = this.nationCentroids[nation.id] || { x: nation.capitalX, y: nation.capitalY };
                for (let copy = startCopy; copy <= endCopy; copy++) {
                    const sx = (centroid.x + copy * world.width) * scale + offsetX;
                    const sy = centroid.y * scale + offsetY;
                    if (sx < -200 || sx > width + 200 || sy < -100 || sy > height + 100) continue;
                    const spacedName = nation.name.toUpperCase().split('').join(sizeFactor > 0.5 ? ' ' : '');
                    drawLabelWithHalo(spacedName, sx, sy, font, labelColor, `rgba(255, 255, 255, ${0.4 * nationAlpha})`, 4);
                }
            }
        }

        if (scale > 0.8 && !isInteracting) {
            const cityAlpha = Math.min(1.0, (scale - 0.8) * 2.5);
            const sortedCities = [...world.cities].sort((a, b) => (a.isCapital === b.isCapital) ? (b.size - a.size) : (a.isCapital ? -1 : 1));

            for (const city of sortedCities) {
                let visible = city.isCapital || (city.size >= 1 && scale > 1.4) || (city.size === 0 && scale > 2.5);
                if (!visible) continue;
                const font = city.isCapital ? `bold 12px system-ui, sans-serif` : `500 11px system-ui, sans-serif`;
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
        let newHovered = -1;
        if (wy >= 0 && wy < world.height) {
            const cell = world.grid[x][wy];
            if (!cell.isWater && cell.nationIndex !== undefined && cell.nationIndex >= 0) newHovered = cell.nationIndex;
        }

        if (newHovered !== this.hoveredNationIndex) {
            this.hoveredNationIndex = newHovered;
            this.canvasManager.scheduleRender();

            // Sync with list
            document.querySelectorAll('.nation-item').forEach(el => el.classList.remove('hovered'));
            if (newHovered !== -1) {
                const item = document.querySelector(`.nation-item[data-index="${newHovered}"]`);
                item?.classList.add('hovered');
            }
        }

        if (newHovered >= 0) {
            const nation = world.nations[newHovered];
            let nearestCity = null;
            let nearestDist = Infinity;
            for (const city of world.cities) {
                if (city.nationIndex !== newHovered) continue;
                let dx = Math.abs(wx - city.x);
                if (dx > world.width / 2) dx = world.width - dx;
                const dist = Math.hypot(dx, wy - city.y);
                if (dist < nearestDist) { nearestDist = dist; nearestCity = city; }
            }
            if (nearestCity && nearestDist < 10 / cm.scale) {
                this.showTooltip(clientX, clientY, nearestCity.name, `${nearestCity.isCapital ? '♦ Capital' : (nearestCity.size === 1 ? '● Town' : '· Village')} · ${nation.name}`);
            } else {
                this.showTooltip(clientX, clientY, nation.name, `${world.cities.filter(c => c.nationIndex === newHovered && !c.isCapital).length} cities`);
            }
        } else {
            this.hideTooltip();
        }
    }

    private buildNationsCache() {
        const world = this.generator.getWorld();
        const W = world.width;
        const H = world.height;
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
            this.nationSizes[i] = maxArea > 0 ? Math.sqrt(area / maxArea) : 0.5;
        }

        // We no longer build a canvas image data here! The GPU handles it procedurally.
    }

    private showTooltip(x: number, y: number, name: string, detail: string) {
        const tooltip = document.getElementById('nation-tooltip');
        if (!tooltip) return;
        (tooltip.querySelector('.tooltip-name') as HTMLElement).textContent = name;
        (tooltip.querySelector('.tooltip-detail') as HTMLElement).textContent = detail;
        tooltip.style.display = 'block'; tooltip.style.left = `${x + 16}px`; tooltip.style.top = `${y + 16}px`;
    }

    private hideTooltip() {
        const tooltip = document.getElementById('nation-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    }

    private hexToRgb(hex: string): number[] {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : [0, 0, 0];
    }

    private showLoadingModal() {
        const modal = document.getElementById('loading-modal');
        if (modal) { modal.style.display = 'flex'; this.updateLoadingModal(0); }
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

    private updateNationStatistics() {
        const world = this.generator.getWorld();
        const W = world.width;

        let maxArea = 0;
        for (let i = 0; i < world.nations.length; i++) {
            const cells = this.nationCellsList[i];
            const area = cells.length;
            if (area > maxArea) maxArea = area;

            if (area > 0) {
                let sumX = 0;
                let sumY = 0;
                for (const flatIdx of cells) {
                    sumX += (flatIdx % W);
                    sumY += Math.floor(flatIdx / W);
                }
                this.nationCentroids[i] = { x: sumX / area, y: sumY / area };
            } else {
                this.nationCentroids[i] = { x: world.nations[i].capitalX, y: world.nations[i].capitalY };
            }
        }

        for (let i = 0; i < world.nations.length; i++) {
            const area = this.nationCellsList[i].length;
            this.nationSizes[i] = maxArea > 0 ? Math.sqrt(area / maxArea) : 0.5;
        }
    }
}
