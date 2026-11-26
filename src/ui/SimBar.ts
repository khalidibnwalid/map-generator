// The History bar over the map can be dragged anywhere by its grip (or its
// empty space). Its place is kept per browser as a fraction of the room it
// has, so it stays put across window sizes; a double-click on the grip puts
// it back at the top center.

const KEY = "sim-bar-pos";

type Pos = { fx: number; fy: number }; // 0..1 of the free room left and right, above and below

function readPos(): Pos | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Pos | null;
    return v && Number.isFinite(v.fx) && Number.isFinite(v.fy) ? v : null;
  } catch {
    return null;
  }
}

function writePos(p: Pos | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the place lasts for the session */
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const MARGIN = 8;

export function installSimBarDrag() {
  const bar = document.getElementById("sim-bar");
  const grip = document.getElementById("sim-bar-grip");
  const parent = bar?.parentElement;
  if (!bar || !grip || !parent) return;
  let pos = readPos();

  // The free room around the bar inside its parent
  const room = () => {
    const p = parent.getBoundingClientRect();
    return { p, w: Math.max(0, p.width - bar.offsetWidth - MARGIN * 2), h: Math.max(0, p.height - bar.offsetHeight - MARGIN * 2) };
  };
  const place = () => {
    bar.classList.toggle("moved", !!pos);
    if (!pos) {
      bar.style.left = "";
      bar.style.top = "";
      return;
    }
    if (!bar.offsetWidth) return; // hidden: placed when it shows
    const r = room();
    bar.style.left = `${MARGIN + pos.fx * r.w}px`;
    bar.style.top = `${MARGIN + pos.fy * r.h}px`;
  };

  let drag: { id: number; dx: number; dy: number } | null = null;
  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Buttons and the slider keep their own job
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    const b = bar.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - b.left, dy: e.clientY - b.top };
    bar.classList.add("dragging");
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = room();
    pos = {
      fx: r.w ? clamp01((e.clientX - drag.dx - r.p.left - MARGIN) / r.w) : 0.5,
      fy: r.h ? clamp01((e.clientY - drag.dy - r.p.top - MARGIN) / r.h) : 0,
    };
    place();
  };
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    bar.classList.remove("dragging");
    writePos(pos);
  };
  bar.addEventListener("pointerdown", start);
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => {
    pos = null;
    writePos(null);
    place();
  });
  // Shown, resized (its text changes) or the window resized: stay inside
  new ResizeObserver(place).observe(bar);
  window.addEventListener("resize", place);
  place();
}
