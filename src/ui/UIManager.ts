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
      // Thresholds follow the stage table in MapGenerator.generate
      const stages: [number, string][] = [
        [22, "Raising mountains and plates..."],
        [32, "Shaping coastlines and lakes..."],
        [42, "Setting climate and rainfall..."],
        [50, "Carving rivers..."],
        [56, "Spreading forests and deserts..."],
        [64, "Settling peoples and faiths..."],
        [74, "Establishing national borders..."],
        [82, "Founding cities and villages..."],
        [90, "Drawing provinces..."],
        [96, "Building roads and sea lanes..."],
        [101, "Raising castles and landmarks..."],
      ];
      subtext.textContent = (stages.find(([end]) => pct < end) ?? stages[stages.length - 1])[1];
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
