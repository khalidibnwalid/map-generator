// Wraps number inputs marked with data-stepper in −/+ buttons (hold to repeat).
// Changes fire the usual input/change events so existing listeners just work.

const MINUS = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 12h12"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg>`;

export function installSteppers(root: ParentNode = document) {
  root.querySelectorAll<HTMLInputElement>('input[type="number"][data-stepper]').forEach((input) => {
    if (input.parentElement?.classList.contains("stepper")) return;
    const wrap = document.createElement("div");
    wrap.className = "stepper";
    input.replaceWith(wrap);
    const mk = (html: string, dir: 1 | -1, title: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stepper-btn";
      b.title = title;
      b.tabIndex = -1;
      b.innerHTML = html;
      let timer = 0;
      let changed = false;
      const step = () => {
        if (dir > 0) input.stepUp();
        else input.stepDown();
        changed = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const stop = () => {
        clearTimeout(timer);
        clearInterval(timer);
        timer = 0;
        if (changed) input.dispatchEvent(new Event("change", { bubbles: true }));
        changed = false;
      };
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        step();
        timer = window.setTimeout(() => (timer = window.setInterval(step, 70)), 380);
      });
      b.addEventListener("pointerup", stop);
      b.addEventListener("pointerleave", () => timer && stop());
      return b;
    };
    wrap.append(mk(MINUS, -1, "Decrease"), input, mk(PLUS, 1, "Increase"));
  });
}
