export class UIManager {
  private loadingModal: HTMLElement | null;
  private confirmModal: HTMLElement | null;
  private generateBtn: HTMLButtonElement | null;

  private confirmResolve: ((value: boolean) => void) | null = null;

  constructor() {
    this.loadingModal = document.getElementById("loading-modal");
    this.confirmModal = document.getElementById("game-confirm-modal");
    this.generateBtn = document.getElementById("generate") as HTMLButtonElement;

    this.setupConfirmListeners();
  }

  private setupConfirmListeners() {
    if (!this.confirmModal) return;

    const btnOk = this.confirmModal.querySelector("#confirm-ok");
    const btnCancel = this.confirmModal.querySelector("#confirm-cancel");

    btnOk?.addEventListener("click", () => {
      this.hideConfirm();
      if (this.confirmResolve) this.confirmResolve(true);
    });

    btnCancel?.addEventListener("click", () => {
      this.hideConfirm();
      if (this.confirmResolve) this.confirmResolve(false);
    });
  }

  public async confirm(title: string, message: string): Promise<boolean> {
    if (!this.confirmModal) return window.confirm(message);

    const titleEl = this.confirmModal.querySelector(".modal-title");
    const messageEl = this.confirmModal.querySelector(".modal-message");

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    this.confirmModal.style.display = "flex";

    return new Promise((resolve) => {
      this.confirmResolve = resolve;
    });
  }

  private hideConfirm() {
    if (this.confirmModal) {
      this.confirmModal.style.display = "none";
    }
  }

  public showLoadingModal() {
    if (this.loadingModal) {
      this.loadingModal.style.display = "flex";
      this.updateLoadingModal(0);
    }
  }

  public hideLoadingModal() {
    if (this.loadingModal) {
      this.loadingModal.style.display = "none";
    }
  }

  public updateLoadingModal(pct: number) {
    if (!this.loadingModal) return;
    const fill = this.loadingModal.querySelector(
      ".loader-progress-fill",
    ) as HTMLElement;
    const text = this.loadingModal.querySelector(
      ".loader-percentage",
    ) as HTMLElement;
    const subtext = this.loadingModal.querySelector(
      ".loader-subtext",
    ) as HTMLElement;

    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${pct}%`;
    if (subtext) {
      if (pct < 20) subtext.textContent = "Adding mountains and valleys...";
      else if (pct < 40)
        subtext.textContent = "Determining rainfall patterns...";
      else if (pct < 60)
        subtext.textContent = "Spreading forests and deserts...";
      else if (pct < 80) subtext.textContent = "Generating river systems...";
      else if (pct < 95)
        subtext.textContent = "Establishing national borders...";
      else subtext.textContent = "Founding cities and capitals...";
    }
  }

  public setBtnProgress(pct: number) {
    if (this.generateBtn) {
      this.generateBtn.style.setProperty("--progress", `${pct}%`);
      this.generateBtn.textContent = `${pct}%`;
    }
  }

  public setBtnLoading(loading: boolean, originalText: string = "Generate") {
    if (!this.generateBtn) return;
    if (loading) {
      this.generateBtn.classList.add("loading");
    } else {
      this.generateBtn.classList.remove("loading");
      this.generateBtn.textContent = originalText;
      this.generateBtn.style.setProperty("--progress", "0%");
    }
  }
}
