// Range inputs are styled in CSS; this keeps the filled part of the track
// (--fill) in step with the value, for user drags and programmatic changes.

function setFill(input: HTMLInputElement) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const v = Number(input.value);
  input.style.setProperty("--fill", `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
}

export function syncSliders(root: ParentNode = document) {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(setFill);
}

export function installSliders() {
  document.addEventListener(
    "input",
    (e) => {
      const t = e.target as HTMLInputElement;
      if (t instanceof HTMLInputElement && t.type === "range") setFill(t);
    },
    true,
  );
  syncSliders();
}
