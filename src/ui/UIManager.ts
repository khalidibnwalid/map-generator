export class UIManager {
    private loadingModal: HTMLElement | null;
    private generateBtn: HTMLButtonElement | null;

    constructor() {
        this.loadingModal = document.getElementById('loading-modal');
        this.generateBtn = document.getElementById('generate') as HTMLButtonElement;
    }

    public showLoadingModal() {
        if (this.loadingModal) {
            this.loadingModal.style.display = 'flex';
            this.updateLoadingModal(0);
        }
    }

    public hideLoadingModal() {
        if (this.loadingModal) {
            this.loadingModal.style.display = 'none';
        }
    }

    public updateLoadingModal(pct: number) {
        if (!this.loadingModal) return;
        const fill = this.loadingModal.querySelector('.loader-progress-fill') as HTMLElement;
        const text = this.loadingModal.querySelector('.loader-percentage') as HTMLElement;
        const subtext = this.loadingModal.querySelector('.loader-subtext') as HTMLElement;

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

    public setBtnProgress(pct: number) {
        if (this.generateBtn) {
            this.generateBtn.style.setProperty('--progress', `${pct}%`);
            this.generateBtn.textContent = `${pct}%`;
        }
    }

    public setBtnLoading(loading: boolean, originalText: string = 'Generate') {
        if (!this.generateBtn) return;
        if (loading) {
            this.generateBtn.classList.add('loading');
        } else {
            this.generateBtn.classList.remove('loading');
            this.generateBtn.textContent = originalText;
            this.generateBtn.style.setProperty('--progress', '0%');
        }
    }
}
