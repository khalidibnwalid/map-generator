export class TooltipManager {
    private tooltip: HTMLElement | null;

    constructor() {
        this.tooltip = document.getElementById('nation-tooltip');
    }

    public show(x: number, y: number, name: string, detail: string, flagUrl = "", badges: { icon: string; text: string }[] = []) {
        if (!this.tooltip) return;

        const nameEl = this.tooltip.querySelector('.tooltip-name');
        const detailEl = this.tooltip.querySelector('.tooltip-detail');

        if (nameEl) {
            nameEl.textContent = name;
            if (flagUrl) {
                const img = document.createElement('img');
                img.className = 'tooltip-flag';
                img.src = flagUrl;
                nameEl.prepend(img);
            }
        }
        if (detailEl) detailEl.textContent = detail;

        // Flagged lines under the detail (a realm's coalitions)
        let badgeEl = this.tooltip.querySelector<HTMLElement>('.tooltip-badges');
        if (!badgeEl) {
            badgeEl = document.createElement('div');
            badgeEl.className = 'tooltip-badges';
            this.tooltip.appendChild(badgeEl);
        }
        badgeEl.replaceChildren(...badges.map((b) => {
            const row = document.createElement('div');
            const img = document.createElement('img');
            img.className = 'tooltip-badge-flag';
            img.src = b.icon;
            row.append(img, b.text);
            return row;
        }));
        badgeEl.style.display = badges.length ? '' : 'none';

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
