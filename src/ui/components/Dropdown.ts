// Themed dropdown: a trigger button plus a floating menu attached to <body>
// (so scrolling panels never clip it). Options may carry a colour dot or an
// image (flags). Keyboard: arrows, Enter, Escape, type to search long lists.

export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  color?: string; // dot before the label
  image?: string; // image URL before the label (e.g. a flag)
  hint?: string; // faint text after the label
}

export interface DropdownConfig<V extends string> {
  options: DropdownOption<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
  tintLabel?: boolean; // colour the trigger label with the option's colour
  title?: string;
}

let openMenu: { close: () => void } | null = null;

const CHEVRON = `<svg class="dd-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

function icon(o: DropdownOption): string {
  if (o.image) return `<img class="dd-img" src="${o.image}" alt="">`;
  if (o.color) return `<span class="dd-dot" style="background:${o.color}"></span>`;
  return "";
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function createDropdown<V extends string>(cfg: DropdownConfig<V>): HTMLButtonElement {
  let value = cfg.value;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `dd ${cfg.className ?? ""}`;
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  if (cfg.title) btn.title = cfg.title;

  const paint = () => {
    const o = cfg.options.find((x) => x.value === value) ?? cfg.options[0];
    btn.innerHTML = `${o ? icon(o) : ""}<span class="dd-label">${o ? escapeHtml(o.label) : ""}</span>${CHEVRON}`;
    const label = btn.querySelector<HTMLElement>(".dd-label")!;
    label.style.color = cfg.tintLabel && o?.color ? o.color : "";
  };
  paint();

  const open = () => {
    openMenu?.close();
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");
    const searchable = cfg.options.length > 10;
    menu.innerHTML = `${searchable ? `<input class="dd-search" placeholder="Search…" />` : ""}<div class="dd-list"></div>`;
    const list = menu.querySelector<HTMLDivElement>(".dd-list")!;
    const search = menu.querySelector<HTMLInputElement>(".dd-search");
    let shown = cfg.options;
    let active = Math.max(0, shown.findIndex((o) => o.value === value));

    const render = () => {
      list.innerHTML = shown
        .map(
          (o, i) => `<div class="dd-opt ${i === active ? "active" : ""} ${o.value === value ? "selected" : ""}" role="option" data-i="${i}">
            ${icon(o)}<span class="dd-opt-label">${escapeHtml(o.label)}</span>${o.hint ? `<span class="dd-hint">${escapeHtml(o.hint)}</span>` : ""}
          </div>`,
        )
        .join("");
      list.querySelector(".dd-opt.active")?.scrollIntoView({ block: "nearest" });
    };
    const choose = (i: number) => {
      const o = shown[i];
      if (!o) return;
      close();
      if (o.value !== value) {
        value = o.value;
        paint();
        cfg.onChange(value);
      }
    };
    const place = () => {
      const r = btn.getBoundingClientRect();
      const w = Math.max(r.width, 170);
      menu.style.minWidth = `${w}px`;
      const below = window.innerHeight - r.bottom;
      const h = Math.min(menu.scrollHeight, 280);
      const up = below < h + 12 && r.top > below;
      menu.style.left = `${Math.min(r.left, window.innerWidth - w - 8)}px`;
      menu.style.top = up ? `${Math.max(8, r.top - h - 4)}px` : `${r.bottom + 4}px`;
    };

    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the search box
    list.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".dd-opt");
      if (el) choose(Number(el.dataset.i));
    });
    list.addEventListener("mousemove", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".dd-opt");
      if (!el || Number(el.dataset.i) === active) return;
      list.querySelector(".dd-opt.active")?.classList.remove("active");
      el.classList.add("active");
      active = Number(el.dataset.i);
    });
    search?.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      shown = q ? cfg.options.filter((o) => o.label.toLowerCase().includes(q)) : cfg.options;
      active = 0;
      render();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        btn.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(active);
      }
    };
    const onOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && !btn.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (!menu.contains(e.target as Node)) close();
    };
    const close = () => {
      menu.remove();
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("open");
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      if (openMenu?.close === close) openMenu = null;
    };

    document.body.appendChild(menu);
    render();
    place();
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("open");
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    openMenu = { close };
    search?.focus();
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btn.classList.contains("open")) openMenu?.close();
    else open();
  });
  btn.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && !btn.classList.contains("open")) {
      e.preventDefault();
      open();
    }
  });
  return btn;
}
