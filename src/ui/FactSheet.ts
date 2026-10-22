import { CELL_KM2, type City, type Nation, type RelationType, type WorldData } from "../game/WorldData";
import { nationFlag, nationFlagUrl } from "../game/flags";
import { RELATION_COLORS } from "../game/generators/generateDiplomacy";
import { RESOURCE_INFO, WEALTH_TIERS, type ResourceKind } from "../game/generators/generateEconomy";
import { relation } from "../game/politics";
import type { SimEvent } from "../game/sim/Simulation";
import { downloadBlob, escapeHtml, fileSlug, frameExtent, nationsExtent, type AtlasHost } from "./AtlasRender";
import { loadPosterFonts } from "./PosterDecor";

// Fields another feature may add to nations; read defensively
type NationExtras = Nation & { ruler?: { name?: string; title?: string }; dynasty?: string };

interface Share {
  name: string;
  color: string;
  pct: number;
}

interface Facts {
  idx: number;
  name: string;
  government: string;
  ruler: string;
  dynasty: string;
  capital: City | null;
  areaKm2: number;
  population: number;
  cities: number;
  towns: number;
  villages: number;
  topCities: City[];
  provinces: number;
  cultures: Share[];
  resources: { label: string; color: string; count: number }[];
  wealthTier: string;
  wealthRank: number;
  areaRank: number;
  popRank: number;
  nations: number;
  neighbors: { idx: number; rel: RelationType }[];
  overlord: number | null;
  vassals: number[];
  events: SimEvent[];
  year: number;
  seed: number;
}

const REL_LABEL: Partial<Record<RelationType, string>> = { Vassal: "Our overlord", Overlord: "Our vassal" };

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function computeFacts(host: AtlasHost, idx: number): Facts {
  const world = host.getWorld();
  const nation = world.nations[idx] as NationExtras;
  const W = world.width;
  const H = world.height;
  const cult = new Map<number, number>();
  const border = new Map<number, number>();
  let land = 0;
  for (let x = 0; x < W; x++) {
    const col = world.grid[x];
    const right = world.grid[(x + 1) % W];
    for (let y = 0; y < H; y++) {
      const c = col[y];
      const a = c.nationIndex ?? -1;
      // Shared edges with other realms (sea claims count: maritime neighbors)
      const b = right[y].nationIndex ?? -1;
      const d = y + 1 < H ? (col[y + 1].nationIndex ?? -1) : -1;
      if (a === idx) {
        if (b >= 0 && b !== idx) border.set(b, (border.get(b) ?? 0) + 1);
        if (d >= 0 && d !== idx) border.set(d, (border.get(d) ?? 0) + 1);
      } else if (a >= 0 && (b === idx || d === idx)) border.set(a, (border.get(a) ?? 0) + 1);
      if (a !== idx || world.waterType[y * W + x] !== 0) continue;
      land++;
      if ((c.cultureIndex ?? -1) >= 0) cult.set(c.cultureIndex!, (cult.get(c.cultureIndex!) ?? 0) + 1);
    }
  }
  const shares = (m: Map<number, number>, list: { name: string; color: string }[]): Share[] => {
    const total = [...m.values()].reduce((s, v) => s + v, 0) || 1;
    return [...m.entries()]
      .filter(([id]) => list[id])
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ name: list[id].name, color: list[id].color, pct: (n / total) * 100 }));
  };

  // Per-nation totals for ranks
  const pop = new Float64Array(world.nations.length);
  const wealth = new Float64Array(world.nations.length);
  for (const c of world.cities) {
    if (c.nationIndex < 0 || c.nationIndex >= world.nations.length) continue;
    pop[c.nationIndex] += c.population;
    wealth[c.nationIndex] += c.wealth ?? 0;
  }
  const rank = (arr: ArrayLike<number>) => {
    let r = 1;
    for (let i = 0; i < arr.length; i++) if (arr[i] > arr[idx]) r++;
    return r;
  };

  const own = world.cities.filter((c) => c.nationIndex === idx);
  let tierSum = 0;
  let tierW = 0;
  for (const c of own) {
    tierSum += (c.wealthTier ?? 2) * c.population;
    tierW += c.population;
  }
  const res = new Map<ResourceKind, number>();
  for (const r of world.resources) {
    const x = ((Math.floor(r.x) % W) + W) % W;
    const y = Math.floor(r.y);
    if (y < 0 || y >= H || world.grid[x][y].nationIndex !== idx) continue;
    res.set(r.kind, (res.get(r.kind) ?? 0) + 1);
  }
  const ruler = nation.ruler;
  const year = host.simYear();
  return {
    idx,
    name: nation.name,
    government: nation.government ?? "Realm",
    ruler: ruler ? [ruler.title, ruler.name].filter(Boolean).join(" ") : "",
    dynasty: typeof nation.dynasty === "string" ? nation.dynasty : "",
    capital: own.find((c) => c.isCapital) ?? null,
    areaKm2: land * CELL_KM2,
    population: pop[idx],
    cities: own.filter((c) => c.size >= 2).length,
    towns: own.filter((c) => c.size === 1).length,
    villages: own.filter((c) => c.size <= 0).length,
    topCities: [...own].sort((a, b) => b.population - a.population).slice(0, 5),
    provinces: world.provinces.filter((p) => p.nationIndex === idx).length,
    cultures: shares(cult, world.cultures),
    resources: [...res.entries()]
      .sort((a, b) => RESOURCE_INFO[b[0]].value - RESOURCE_INFO[a[0]].value || b[1] - a[1])
      .map(([k, n]) => ({ label: RESOURCE_INFO[k].label, color: RESOURCE_INFO[k].color, count: n })),
    wealthTier: tierW > 0 ? WEALTH_TIERS[Math.round(tierSum / tierW)] ?? "Modest" : "—",
    wealthRank: rank(wealth),
    areaRank: rank(host.landArea()),
    popRank: rank(pop),
    nations: world.nations.length,
    neighbors: [...border.entries()]
      .filter(([j]) => world.nations[j])
      .sort((a, b) => b[1] - a[1])
      .map(([j]) => ({ idx: j, rel: relation(world, idx, j) })),
    overlord: nation.overlord ?? null,
    vassals: world.nations.map((n, i) => (n.overlord === idx ? i : -1)).filter((i) => i >= 0),
    events: host.simEvents().filter((e) => e.text.includes(nation.name)),
    year,
    seed: world.seed,
  };
}

const num = (n: number) => Math.round(n).toLocaleString();

// Encyclopedia-style modal for one nation, with a canvas-drawn image export
export class FactSheet {
  private host: AtlasHost;
  private root: HTMLDivElement;
  private facts: Facts | null = null;
  private map: HTMLCanvasElement | null = null;
  private mapJob: Promise<void> | null = null;
  private token = 0;

  constructor(host: AtlasHost) {
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "modal-overlay fact-modal";
    this.root.style.display = "none";
    this.root.innerHTML = `<div class="modal-content fact-sheet" id="fs-sheet"></div>`;
    document.body.appendChild(this.root);
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.style.display !== "none") this.close();
    });
    this.root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("#fs-close, #fs-close-2")) this.close();
      else if (t.closest("#fs-export")) this.exportImage();
      else {
        const link = t.closest<HTMLElement>("[data-nation]");
        if (link) this.open(Number(link.dataset.nation));
      }
    });
  }

  public open(idx: number) {
    const world = this.host.getWorld();
    if (!world.nations[idx]) return;
    const f = (this.facts = computeFacts(this.host, idx));
    this.root.style.display = "flex";
    this.renderDom(world, f);
    this.root.querySelector(".fact-sheet")!.scrollTop = 0;
    this.renderMap(world, idx);
  }

  private close() {
    this.root.style.display = "none";
    this.token++;
  }

  // Small crop of the realm through the export renderer, other land dimmed
  private renderMap(world: WorldData, idx: number) {
    const token = ++this.token;
    this.map = null;
    const keep = new Set([idx]);
    const e = nationsExtent(world, keep);
    const holder = this.root.querySelector<HTMLDivElement>("#fs-map")!;
    if (!e) {
      holder.classList.add("empty");
      holder.textContent = "This realm holds no land.";
      this.mapJob = null;
      return;
    }
    const ext = frameExtent(world, e, 0.18, 1.6, 1.6, 30);
    const pr = 2;
    const w = 400 * pr;
    const h = 250 * pr;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const scale = w / (ext.x1 - ext.x0);
    holder.classList.add("loading");
    this.mapJob = this.host
      .renderMapTo(canvas.getContext("2d")!, {
        x: 0,
        y: 0,
        w,
        h,
        scale,
        offsetX: -ext.x0 * scale,
        offsetY: -ext.y0 * scale,
        pixelRatio: pr,
        keep,
        canceled: () => token !== this.token,
      })
      .then(() => {
        if (token !== this.token) return;
        this.map = canvas;
        holder.classList.remove("loading");
        holder.innerHTML = "";
        holder.appendChild(canvas);
      })
      .catch((err) => {
        console.error(err);
        holder.classList.remove("loading");
      });
  }

  private renderDom(world: WorldData, f: Facts) {
    const sheet = this.root.querySelector<HTMLDivElement>("#fs-sheet")!;
    const flagImg = (i: number, w: number, h: number) => `<img class="fs-mini-flag" src="${nationFlagUrl(world, i, w, h)}" alt="" style="width:${w}px;height:${h}px">`;
    const link = (i: number) => `<button class="fs-link" data-nation="${i}">${flagImg(i, 18, 12)}${escapeHtml(world.nations[i].name)}</button>`;
    const row = (label: string, value: string) => (value ? `<dt>${label}</dt><dd>${value}</dd>` : "");
    const bars = (list: Share[]) =>
      list.length
        ? list
            .slice(0, 5)
            .map(
              (s) => `<div class="fs-bar">
                <div class="fs-bar-head"><span>${escapeHtml(s.name)}</span><span>${s.pct < 1 ? "<1" : Math.round(s.pct)}%</span></div>
                <div class="fs-bar-track"><div style="width:${Math.max(1, s.pct)}%;background:${s.color}"></div></div>
              </div>`,
            )
            .join("")
        : `<p class="muted">None recorded.</p>`;
    const settle = [
      f.cities && `${f.cities} ${f.cities === 1 ? "city" : "cities"}`,
      f.towns && `${f.towns} ${f.towns === 1 ? "town" : "towns"}`,
      f.villages && `${f.villages} ${f.villages === 1 ? "village" : "villages"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const vassalOf = f.overlord !== null && world.nations[f.overlord] ? ` · vassal of ${escapeHtml(world.nations[f.overlord].name)}` : "";
    const rulerLine = [f.ruler && `<span>Ruler <strong>${escapeHtml(f.ruler)}</strong></span>`, f.dynasty && `<span>Dynasty <strong>${escapeHtml(f.dynasty)}</strong></span>`]
      .filter(Boolean)
      .join("");

    sheet.innerHTML = /* html */ `
      <button class="icon-btn fs-close" id="fs-close" title="Close">✕</button>
      <header class="fs-head">
        <div class="fs-flag" id="fs-flag"></div>
        <div class="fs-titles">
          <div class="fs-kicker">Encyclopaedia of the Known World${f.year > 0 ? ` · Year ${f.year}` : ""}</div>
          <h2 class="fs-name">${escapeHtml(f.name)}</h2>
          <div class="fs-gov">${escapeHtml(f.government)}${vassalOf}</div>
          ${rulerLine ? `<div class="fs-ruler">${rulerLine}</div>` : ""}
        </div>
      </header>
      <div class="fs-body">
        <div class="fs-col">
          <dl class="fs-facts">
            ${row("Capital", f.capital ? escapeHtml(f.capital.name) + ` <small>${num(f.capital.population)}</small>` : "<em>none</em>")}
            ${row("Area", `${num(f.areaKm2)} km² <small>${ordinal(f.areaRank)} of ${f.nations}</small>`)}
            ${row("Population", `${num(f.population)} <small>${ordinal(f.popRank)} of ${f.nations}</small>`)}
            ${row("Settlements", `${f.cities + f.towns + f.villages} <small>${settle}</small>`)}
            ${row("Provinces", String(f.provinces))}
            ${row("Wealth", `${f.wealthTier} <small>${ordinal(f.wealthRank)} richest</small>`)}
            ${f.overlord !== null && world.nations[f.overlord] ? row("Overlord", link(f.overlord)) : ""}
            ${f.vassals.length ? row("Vassals", `<span class="fs-links">${f.vassals.map(link).join("")}</span>`) : ""}
          </dl>
          <section><h3>Peoples</h3>${bars(f.cultures)}</section>
          <section><h3>Resources</h3>${
            f.resources.length
              ? `<div class="fs-chips">${f.resources
                  .map((r) => `<span class="fs-chip"><i style="background:${r.color}"></i>${r.label}${r.count > 1 ? ` <small>×${r.count}</small>` : ""}</span>`)
                  .join("")}</div>`
              : `<p class="muted">No notable deposits.</p>`
          }</section>
        </div>
        <div class="fs-col">
          <figure class="fs-map-fig"><div class="fs-map" id="fs-map"></div><figcaption>The realm of ${escapeHtml(f.name)}</figcaption></figure>
          <section><h3>Largest cities</h3>${
            f.topCities.length
              ? `<ol class="fs-cities">${f.topCities
                  .map((c) => `<li><span>${escapeHtml(c.name)}${c.isCapital ? ' <small class="fs-cap" title="Capital">★</small>' : ""}</span><span>${num(c.population)}</span></li>`)
                  .join("")}</ol>`
              : `<p class="muted">No settlements.</p>`
          }</section>
          <section><h3>Neighbors</h3>${
            f.neighbors.length
              ? `<div class="fs-neighbors">${f.neighbors
                  .map(
                    (n) => `<button class="fs-neighbor" data-nation="${n.idx}">${flagImg(n.idx, 21, 14)}<span>${escapeHtml(world.nations[n.idx].name)}</span>
                      <span class="fs-rel" style="--rel:${RELATION_COLORS[n.rel]}">${REL_LABEL[n.rel] ?? n.rel}</span></button>`,
                  )
                  .join("")}</div>`
              : `<p class="muted">An isolated realm.</p>`
          }</section>
        </div>
      </div>
      <section class="fs-history"><h3>History</h3>${
        f.events.length
          ? `<div class="fs-events">${f.events
              .slice(0, 40)
              .map((e) => `<div class="fs-event ${e.kind}"><span class="yr">${e.year}</span><span>${escapeHtml(e.text)}</span></div>`)
              .join("")}</div>`
          : `<p class="muted">No events recorded yet. Run the History simulation to write this realm's chronicle.</p>`
      }</section>
      <div class="modal-actions">
        <button class="btn-cancel" id="fs-export">Export as image</button>
        <button class="btn-cancel" id="fs-close-2">Close</button>
      </div>`;
    const flag = nationFlag(world, f.idx, 264, 176);
    if (flag) this.root.querySelector("#fs-flag")!.appendChild(flag);
  }

  private async exportImage() {
    const f = this.facts;
    if (!f) return;
    const btn = this.root.querySelector<HTMLButtonElement>("#fs-export");
    if (btn) btn.disabled = true;
    try {
      await loadPosterFonts();
      await this.mapJob;
      const world = this.host.getWorld();
      const S = 2;
      const dry = document.createElement("canvas").getContext("2d")!;
      const height = paintSheet(dry, world, f, this.map, 0);
      const canvas = document.createElement("canvas");
      canvas.width = SHEET_W * S;
      canvas.height = Math.ceil(height * S);
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(S, 0, 0, S, 0, 0);
      paintSheet(ctx, world, f, this.map, height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (blob) downloadBlob(blob, `${fileSlug(f.name)}-fact-sheet.png`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
}

// --- Canvas version of the sheet (light encyclopedia page) ---

const SHEET_W = 1100;
const C = {
  paper: "#f4ecd8",
  ink: "#2b2118",
  muted: "#7a6346",
  brass: "#a2742a",
  rule: "rgba(43, 33, 24, 0.22)",
  display: "'Cormorant Garamond', Georgia, serif",
  body: "Inter, 'Segoe UI', system-ui, sans-serif",
};

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const t = line ? `${line} ${word}` : word;
    if (ctx.measureText(t).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

function spacing(ctx: CanvasRenderingContext2D, px: number) {
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

// Draws the sheet and returns its height. With height 0 it only measures.
function paintSheet(ctx: CanvasRenderingContext2D, world: WorldData, f: Facts, map: HTMLCanvasElement | null, height: number): number {
  const M = 56;
  const W = SHEET_W;
  if (height) {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, height);
    const g = ctx.createRadialGradient(W / 2, height / 2, Math.min(W, height) * 0.3, W / 2, height / 2, Math.hypot(W, height) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(120, 85, 40, 0.18)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, height);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(20, 20, W - 40, height - 40);
    ctx.lineWidth = 0.6;
    ctx.strokeRect(26, 26, W - 52, height - 52);
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  let y = M;

  // Header
  const fw = 192;
  const fh = 128;
  const flag = nationFlag(world, f.idx, fw * 2, fh * 2);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  if (flag) ctx.drawImage(flag, M, y, fw, fh);
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.strokeRect(M, y, fw, fh);
  const tx = M + fw + 32;
  const tw = W - M - tx;
  spacing(ctx, 3);
  ctx.font = `600 12px ${C.body}`;
  ctx.fillStyle = C.brass;
  ctx.fillText(`ENCYCLOPAEDIA OF THE KNOWN WORLD${f.year > 0 ? ` · YEAR ${f.year}` : ""}`, tx, y + 16);
  spacing(ctx, 0);
  let size = 60;
  ctx.font = `700 ${size}px ${C.display}`;
  while (size > 30 && ctx.measureText(f.name).width > tw) ctx.font = `700 ${(size -= 2)}px ${C.display}`;
  ctx.fillStyle = C.ink;
  ctx.fillText(f.name, tx, y + 26 + size * 0.85);
  let ty = y + 26 + size * 0.85 + 32;
  ctx.font = `italic 600 22px ${C.display}`;
  ctx.fillStyle = C.muted;
  const vassalOf = f.overlord !== null && world.nations[f.overlord] ? ` · vassal of ${world.nations[f.overlord].name}` : "";
  ctx.fillText(ellipsis(ctx, f.government + vassalOf, tw), tx, ty);
  const ruler = [f.ruler && `Ruler: ${f.ruler}`, f.dynasty && `Dynasty: ${f.dynasty}`].filter(Boolean).join("   ·   ");
  if (ruler) {
    ty += 26;
    ctx.font = `15px ${C.body}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(ellipsis(ctx, ruler, tw), tx, ty);
  }
  y = Math.max(y + fh, ty) + 26;
  ctx.fillStyle = C.ink;
  ctx.fillRect(M, y, W - 2 * M, 2);
  ctx.fillRect(M, y + 5, W - 2 * M, 0.7);
  y += 34;

  const heading = (text: string, x: number, yy: number) => {
    ctx.font = `700 24px ${C.display}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(text, x, yy + 18);
    return yy + 32;
  };

  // Left column: facts, peoples, resources
  const lx = M;
  const lw = 468;
  let yl = y;
  const facts: [string, string, string][] = [
    ["Capital", f.capital?.name ?? "none", f.capital ? num(f.capital.population) : ""],
    ["Area", `${num(f.areaKm2)} km²`, `${ordinal(f.areaRank)} of ${f.nations}`],
    ["Population", num(f.population), `${ordinal(f.popRank)} of ${f.nations}`],
    ["Settlements", String(f.cities + f.towns + f.villages), `${f.cities} cities · ${f.towns} towns · ${f.villages} villages`],
    ["Provinces", String(f.provinces), ""],
    ["Wealth", f.wealthTier, `${ordinal(f.wealthRank)} richest`],
  ];
  if (f.overlord !== null && world.nations[f.overlord]) facts.push(["Overlord", world.nations[f.overlord].name, ""]);
  if (f.vassals.length) facts.push(["Vassals", String(f.vassals.length), f.vassals.map((i) => world.nations[i]?.name).join(", ")]);
  for (const [label, value, note] of facts) {
    spacing(ctx, 1.5);
    ctx.font = `600 11px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(label.toUpperCase(), lx, yl + 20);
    spacing(ctx, 0);
    ctx.font = `600 16px ${C.body}`;
    ctx.fillStyle = C.ink;
    const vx = lx + 128;
    const value1 = ellipsis(ctx, value, lw - 128);
    ctx.fillText(value1, vx, yl + 20);
    if (note) {
      const used = ctx.measureText(value1).width + 10;
      ctx.font = `13px ${C.body}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(ellipsis(ctx, note, lw - 128 - used), vx + used, yl + 20);
    }
    ctx.fillStyle = C.rule;
    ctx.fillRect(lx, yl + 32, lw, 1);
    yl += 34;
  }
  yl += 18;
  const bars = (title: string, list: Share[]) => {
    yl = heading(title, lx, yl);
    if (!list.length) {
      ctx.font = `italic 14px ${C.body}`;
      ctx.fillStyle = C.muted;
      ctx.fillText("None recorded.", lx, yl + 14);
      yl += 30;
      return;
    }
    for (const s of list.slice(0, 5)) {
      ctx.font = `14px ${C.body}`;
      ctx.fillStyle = C.ink;
      ctx.fillText(ellipsis(ctx, s.name, lw - 60), lx, yl + 14);
      ctx.textAlign = "right";
      ctx.font = `600 13px ${C.body}`;
      ctx.fillText(`${s.pct < 1 ? "<1" : Math.round(s.pct)}%`, lx + lw, yl + 14);
      ctx.textAlign = "left";
      ctx.fillStyle = C.rule;
      ctx.fillRect(lx, yl + 21, lw, 5);
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, yl + 21, Math.max(2, (lw * s.pct) / 100), 5);
      yl += 36;
    }
    yl += 10;
  };
  bars("Peoples", f.cultures);
  yl = heading("Resources", lx, yl);
  if (f.resources.length) {
    let cx = lx;
    let cy = yl;
    ctx.font = `13px ${C.body}`;
    for (const r of f.resources) {
      const text = r.count > 1 ? `${r.label} ×${r.count}` : r.label;
      const w = ctx.measureText(text).width + 34;
      if (cx + w > lx + lw) {
        cx = lx;
        cy += 34;
      }
      ctx.beginPath();
      ctx.roundRect(cx, cy, w, 26, 13);
      ctx.fillStyle = "rgba(43, 33, 24, 0.06)";
      ctx.fill();
      ctx.strokeStyle = C.rule;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 14, cy + 13, 5, 0, Math.PI * 2);
      ctx.fillStyle = r.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.fillText(text, cx + 25, cy + 18);
      cx += w + 8;
    }
    yl = cy + 40;
  } else {
    ctx.font = `italic 14px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText("No notable deposits.", lx, yl + 14);
    yl += 30;
  }

  // Right column: map, cities, neighbors
  const rx = lx + lw + 44;
  const rw = W - M - rx;
  let yr = y;
  const mh = Math.round(rw / 1.6);
  if (map) ctx.drawImage(map, rx, yr, rw, mh);
  else {
    ctx.fillStyle = "rgba(43, 33, 24, 0.08)";
    ctx.fillRect(rx, yr, rw, mh);
  }
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(rx, yr, rw, mh);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(rx - 4, yr - 4, rw + 8, mh + 8);
  yr += mh + 22;
  ctx.font = `italic 15px ${C.display}`;
  ctx.fillStyle = C.muted;
  ctx.textAlign = "center";
  ctx.fillText(`The realm of ${f.name}`, rx + rw / 2, yr);
  ctx.textAlign = "left";
  yr += 26;
  yr = heading("Largest cities", rx, yr);
  if (!f.topCities.length) {
    ctx.font = `italic 14px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText("No settlements.", rx, yr + 14);
    yr += 30;
  }
  f.topCities.forEach((c, i) => {
    ctx.font = `600 13px ${C.body}`;
    ctx.fillStyle = C.brass;
    ctx.fillText(`${i + 1}.`, rx, yr + 16);
    ctx.font = `15px ${C.body}`;
    ctx.fillStyle = C.ink;
    const name = ellipsis(ctx, c.name, rw - 130);
    ctx.fillText(name, rx + 24, yr + 16);
    if (c.isCapital) {
      ctx.fillStyle = C.brass;
      ctx.fillText("★", rx + 30 + ctx.measureText(name).width, yr + 16);
    }
    ctx.textAlign = "right";
    ctx.font = `13px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(num(c.population), rx + rw, yr + 16);
    ctx.textAlign = "left";
    ctx.fillStyle = C.rule;
    ctx.fillRect(rx, yr + 26, rw, 1);
    yr += 30;
  });
  yr += 18;
  yr = heading("Neighbors", rx, yr);
  if (!f.neighbors.length) {
    ctx.font = `italic 14px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText("An isolated realm.", rx, yr + 14);
    yr += 30;
  }
  const shown = f.neighbors.slice(0, 10);
  for (const n of shown) {
    const nf = nationFlag(world, n.idx, 60, 40);
    if (nf) ctx.drawImage(nf, rx, yr + 4, 30, 20);
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.strokeRect(rx, yr + 4, 30, 20);
    const label = REL_LABEL[n.rel] ?? n.rel;
    ctx.font = `600 11px ${C.body}`;
    const pw = ctx.measureText(label).width + 18;
    ctx.beginPath();
    ctx.roundRect(rx + rw - pw, yr + 4, pw, 20, 10);
    ctx.fillStyle = RELATION_COLORS[n.rel];
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, rx + rw - pw / 2, yr + 18);
    ctx.textAlign = "left";
    ctx.font = `15px ${C.body}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(ellipsis(ctx, world.nations[n.idx].name, rw - pw - 52), rx + 42, yr + 19);
    yr += 32;
  }
  if (f.neighbors.length > shown.length) {
    ctx.font = `italic 13px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(`and ${f.neighbors.length - shown.length} more`, rx + 42, yr + 12);
    yr += 24;
  }

  // History, full width
  y = Math.max(yl, yr) + 14;
  ctx.fillStyle = C.rule;
  ctx.fillRect(M, y, W - 2 * M, 1);
  y += 22;
  y = heading("History", M, y);
  if (!f.events.length) {
    ctx.font = `italic 14px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText("No events recorded yet.", M, y + 14);
    y += 30;
  }
  const textW = W - 2 * M - 70;
  for (const e of f.events.slice(0, 14)) {
    ctx.font = `600 13px ${C.body}`;
    ctx.fillStyle = C.brass;
    ctx.fillText(`Year ${e.year}`, M, y + 15);
    ctx.font = `14px ${C.body}`;
    ctx.fillStyle = C.ink;
    for (const line of wrap(ctx, e.text, textW)) {
      ctx.fillText(line, M + 70, y + 15);
      y += 21;
    }
    y += 6;
  }
  if (f.events.length > 14) {
    ctx.font = `italic 13px ${C.body}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(`and ${f.events.length - 14} earlier events`, M + 70, y + 12);
    y += 22;
  }

  // Footer
  y += 16;
  ctx.fillStyle = C.rule;
  ctx.fillRect(M, y, W - 2 * M, 1);
  y += 22;
  ctx.font = `12px ${C.body}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(`World seed ${f.seed}${f.year > 0 ? ` · Year ${f.year}` : ""}`, M, y);
  ctx.textAlign = "right";
  ctx.fillText("Procedural World Generator", W - M, y);
  ctx.textAlign = "left";
  return y + M - 10;
}
