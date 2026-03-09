export class TooltipManager {
    private tooltip: HTMLElement | null;

    constructor() {
        this.tooltip = document.getElementById('nation-tooltip');
    }

    public show(x: number, y: number, name: string, detail: string) {
        if (!this.tooltip) return;

        const nameEl = this.tooltip.querySelector('.tooltip-name');
        const detailEl = this.tooltip.querySelector('.tooltip-detail');

        if (nameEl) nameEl.textContent = name;
        if (detailEl) detailEl.textContent = detail;

        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${x + 16}px`;
        this.tooltip.style.top = `${y + 16}px`;
    }

    public hide() {
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
    }

    public get isVisible(): boolean {
        return this.tooltip?.style.display === 'block';
    }
}
