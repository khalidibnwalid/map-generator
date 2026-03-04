export class CanvasManager {
    public canvas: HTMLCanvasElement;
    public ctx: CanvasRenderingContext2D;

    public scale: number = 1;
    public offsetX: number = 0;
    public offsetY: number = 0;

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
        this.ctx = this.canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D; // optimization

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
        this.canvas.addEventListener('wheel', (e) => {
            const zoomSensitivity = 0.001;
            const wheelDelta = e.deltaY;
            const zoomFactor = Math.exp(-wheelDelta * zoomSensitivity);

            // Zoom towards mouse position
            const mouseX = e.clientX - this.canvas.offsetLeft;
            const mouseY = e.clientY - this.canvas.offsetTop;

            this.offsetX = mouseX - (mouseX - this.offsetX) * zoomFactor;
            this.offsetY = mouseY - (mouseY - this.offsetY) * zoomFactor;
            this.scale *= zoomFactor;

            this.setInteracting();
        });

        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
            this.setInteracting();
        });

        window.addEventListener('mouseup', () => {
            this.isDragging = false;
            this.canvas.style.cursor = 'grab';
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
        this.ctx.fillStyle = '#111';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        if (this.onRender) {
            this.onRender(this.ctx, this.canvas.width, this.canvas.height, this.scale, this.offsetX, this.offsetY, this.isInteracting);
        }
    }

    public getWidth() { return this.canvas.width; }
    public getHeight() { return this.canvas.height; }
}
