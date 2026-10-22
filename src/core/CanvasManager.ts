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

    private setupEvents() {
        // Prevent context menu to allow right-click panning
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('wheel', (e) => {
            // Fast enough to go from continent to street level in a few flicks
            const zoomSensitivity = 0.0018;
            const wheelDelta = Math.max(-300, Math.min(300, e.deltaY));
            let zoomFactor = Math.exp(-wheelDelta * zoomSensitivity);
            const MAX_SCALE = 250000; // ~2 cm per pixel (1 cell = 5 km)
            if (this.scale * zoomFactor > MAX_SCALE) zoomFactor = MAX_SCALE / this.scale;

            // Zoom towards mouse position
            const mouseX = e.clientX - this.canvas.offsetLeft;
            const mouseY = e.clientY - this.canvas.offsetTop;

            this.offsetX = mouseX - (mouseX - this.offsetX) * zoomFactor;
            this.offsetY = mouseY - (mouseY - this.offsetY) * zoomFactor;
            this.scale *= zoomFactor;

            this.setInteracting();
        });

        this.canvas.addEventListener('mousedown', (e) => {
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
