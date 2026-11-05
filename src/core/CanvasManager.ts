export class CanvasManager {
    public canvas: HTMLCanvasElement;
    public ctx: CanvasRenderingContext2D;

    public scale: number = 1;
    public offsetX: number = 0;
    public offsetY: number = 0;

    public panningLocked: boolean = false;
    private isDragging: boolean = false;
    private lastX: number = 0;
    private lastY: number = 0;
    // Fingers on the map (touch and pen), by pointer id
    private touches = new Map<number, { x: number; y: number }>();
    private pinch: { dist: number; midX: number; midY: number } | null = null;
    // Two fingers are down: editors ignore the gesture, it only moves the view
    public get isPinching() {
        return this.touches.size >= 2;
    }

    // Render callback hook
    public isInteracting: boolean = false;
    private renderTimeout: number | null = null;
    public onRender: ((ctx: CanvasRenderingContext2D, width: number, height: number, scale: number, offsetX: number, offsetY: number, isInteracting: boolean) => void) | null = null;
    private animationFrameId: number | null = null;

    constructor(canvasId: string) {
        const el = document.getElementById(canvasId);
        if (!el || !(el instanceof HTMLCanvasElement)) {
            throw new Error(`Canvas with id ${canvasId} not found.`);
        }
        this.canvas = el;
        // Transparent overlay: the WebGL terrain canvas sits underneath it
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;

        this.resizeCanvas();
        this.setupEvents();
        window.addEventListener('resize', this.resizeCanvas.bind(this));
    }

    private resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.scheduleRender();
    }

    // Zoom by `factor` keeping screen point (sx, sy) fixed
    public zoomAt(factor: number, sx: number, sy: number) {
        const MAX_SCALE = 250000; // ~2 cm per pixel (1 cell = 5 km)
        if (this.scale * factor > MAX_SCALE) factor = MAX_SCALE / this.scale;
        this.offsetX = sx - (sx - this.offsetX) * factor;
        this.offsetY = sy - (sy - this.offsetY) * factor;
        this.scale *= factor;
        this.setInteracting();
    }

    // Touch: one finger pans (unless an editor holds the map), two fingers
    // pinch-zoom and pan together, editor or not. Mice keep their own handlers.
    private setupTouch() {
        const c = this.canvas;
        c.style.touchAction = 'none'; // the page itself must not scroll or zoom
        const pinchState = () => {
            const [a, b] = [...this.touches.values()];
            return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
        };
        c.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            try {
                c.setPointerCapture(e.pointerId); // keep the finger when it slides over a panel
            } catch {
                /* pointer already gone */
            }
            if (this.touches.size === 2) {
                this.pinch = pinchState();
                this.isDragging = false;
            } else if (this.touches.size === 1 && !this.panningLocked) {
                this.isDragging = true;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
            }
            this.setInteracting();
        });
        c.addEventListener('pointermove', (e) => {
            const t = this.touches.get(e.pointerId);
            if (!t) return;
            t.x = e.clientX;
            t.y = e.clientY;
            if (this.touches.size >= 2 && this.pinch) {
                const now = pinchState();
                const rect = c.getBoundingClientRect();
                // Pan with the midpoint, zoom about it
                this.offsetX += now.midX - this.pinch.midX;
                this.offsetY += now.midY - this.pinch.midY;
                this.zoomAt(now.dist / this.pinch.dist, now.midX - rect.left, now.midY - rect.top);
                this.pinch = now;
            } else if (this.isDragging && this.touches.size === 1) {
                this.offsetX += e.clientX - this.lastX;
                this.offsetY += e.clientY - this.lastY;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
                this.setInteracting();
            }
        });
        const lift = (e: PointerEvent) => {
            if (!this.touches.delete(e.pointerId)) return;
            if (this.touches.size < 2) this.pinch = null;
            if (this.touches.size === 1 && !this.panningLocked) {
                // The remaining finger carries on panning from where it is
                const [t] = [...this.touches.values()];
                this.isDragging = true;
                this.lastX = t.x;
                this.lastY = t.y;
            } else if (this.touches.size === 0) this.isDragging = false;
            this.scheduleHighResRender();
        };
        c.addEventListener('pointerup', lift);
        c.addEventListener('pointercancel', lift);
    }

    private setupEvents() {
        this.setupTouch();
        // Prevent context menu to allow right-click panning
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('wheel', (e) => {
            // Fast enough to go from continent to street level in a few flicks
            const zoomSensitivity = 0.0018;
            const wheelDelta = Math.max(-300, Math.min(300, e.deltaY));
            // Zoom towards mouse position
            this.zoomAt(Math.exp(-wheelDelta * zoomSensitivity), e.clientX - this.canvas.offsetLeft, e.clientY - this.canvas.offsetTop);
        });

        this.canvas.addEventListener('mousedown', (e) => {
            if (this.touches.size || (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
            // allowing right-click (2) or middle-click (1) to pan even if locked
            // Also allow left-click (0) with Shift key to pan even if locked
            if (this.panningLocked && e.button === 0 && !e.shiftKey) return;

            this.isDragging = true;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
            this.setInteracting();
        });

        window.addEventListener('mouseup', () => {
            this.isDragging = false;
            this.canvas.style.cursor = this.panningLocked ? 'default' : 'grab';
            this.scheduleHighResRender();
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isDragging) return;

            const dx = e.clientX - this.lastX;
            const dy = e.clientY - this.lastY;

            this.offsetX += dx;
            this.offsetY += dy;

            this.lastX = e.clientX;
            this.lastY = e.clientY;

            this.setInteracting();
        });
    }

    private setInteracting() {
        this.isInteracting = true;
        this.scheduleRender();
        this.scheduleHighResRender();
    }

    private scheduleHighResRender() {
        if (this.renderTimeout !== null) {
            clearTimeout(this.renderTimeout);
        }
        this.renderTimeout = setTimeout(() => {
            if (!this.isDragging) {
                this.isInteracting = false;
                this.scheduleRender();
            }
        }, 150) as any;
    }

    public scheduleRender() {
        if (this.animationFrameId === null) {
            this.animationFrameId = requestAnimationFrame(() => {
                this.render();
                this.animationFrameId = null;
            });
        }
    }

    private render() {
        // Clear canvas
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.onRender) {
            this.onRender(this.ctx, this.canvas.width, this.canvas.height, this.scale, this.offsetX, this.offsetY, this.isInteracting);
        }
    }

    public lookAt(worldX: number, worldY: number, targetScale: number = this.scale) {
        this.scale = targetScale;
        this.offsetX = this.canvas.width / 2 - worldX * this.scale;
        this.offsetY = this.canvas.height / 2 - worldY * this.scale;
        this.scheduleRender();
    }

    public getWidth() { return this.canvas.width; }
    public getHeight() { return this.canvas.height; }
}
