import { WorldData, BIOME_COLORS, BIOME_INDEX } from "../game/WorldData";
import { distanceTransform } from "../game/util/grid";
import { VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE } from "./MapShader";

export type MapTheme = "Realistic" | "Historical" | "Atlas";
export type ThematicMode = "none" | "cultures" | "religions" | "diplomacy" | "wealth";

const THEME_INDEX: Record<MapTheme, number> = { Realistic: 0, Historical: 1, Atlas: 2 };
const THEMATIC_INDEX: Record<ThematicMode, number> = {
  none: 0,
  cultures: 1,
  religions: 2,
  diplomacy: 3,
  wealth: 4,
};

export interface RenderLayers {
  ice?: boolean;
  biomes: boolean;
  elevation: boolean;
  heatmap: boolean;
  population?: boolean;
  moisture: boolean;
  nations: boolean;
  borders: boolean;
  provinces: boolean;
}

type Rect = { x: number; y: number; w: number; h: number };

export class GPURenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private coastTexture: WebGLTexture | null = null;
  private nationsTexture: WebGLTexture | null = null;
  private nationIdxTexture: WebGLTexture | null = null; // exact ids for borders & hover
  private provincesTexture: WebGLTexture | null = null;
  private thematicTexture: WebGLTexture | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private biomeColors: Float32Array;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  // Nearest land cell for every cell, so region textures can extend a little
  // past the coast (borders then never trace the shoreline).
  private nearestLand: Int32Array | null = null;
  private nearestLandWorld: WorldData | null = null;
  private texSize = { w: 0, h: 0 };

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;

    this.program = this.createProgram(VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
    this.setupQuad();
    this.biomeColors = this.prepareBiomeColors();
  }

  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type)!;
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      throw new Error(`Shader compilation error: ${this.gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  private createProgram(vsSource: string, fsSource: string): WebGLProgram {
    const vs = this.createShader(this.gl.VERTEX_SHADER, vsSource);
    const fs = this.createShader(this.gl.FRAGMENT_SHADER, fsSource);
    const program = this.gl.createProgram()!;
    this.gl.attachShader(program, vs);
    this.gl.attachShader(program, fs);
    this.gl.linkProgram(program);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${this.gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  private u(name: string): WebGLUniformLocation | null {
    let loc = this.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.program, name);
      this.uniforms.set(name, loc);
    }
    return loc;
  }

  private setupQuad() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const posLoc = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private prepareBiomeColors(): Float32Array {
    const colors = new Float32Array(40 * 3);
    for (const [type, colorHex] of Object.entries(BIOME_COLORS)) {
      const idx = BIOME_INDEX[type];
      if (idx === undefined) continue;
      colors[idx * 3] = parseInt(colorHex.slice(1, 3), 16) / 255;
      colors[idx * 3 + 1] = parseInt(colorHex.slice(3, 5), 16) / 255;
      colors[idx * 3 + 2] = parseInt(colorHex.slice(5, 7), 16) / 255;
    }
    return colors;
  }

  private makeTexture(filter: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private upload(tex: WebGLTexture, w: number, h: number, data: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  private getNearestLand(world: WorldData): Int32Array {
    if (this.nearestLand && this.nearestLandWorld === world) return this.nearestLand;
    const N = world.width * world.height;
    const site = new Uint8Array(N);
    for (let i = 0; i < N; i++) site[i] = world.waterType[i] === 0 ? 1 : 0;
    this.nearestLand = distanceTransform(world.width, world.height, site).nearest;
    this.nearestLandWorld = world;
    return this.nearestLand;
  }

  public updateWorldTexture(world: WorldData) {
    if (!world || !world.grid) return;
    const W = world.width;
    const H = world.height;
    if (this.texSize.w !== W || this.texSize.h !== H) {
      for (const t of [this.texture, this.coastTexture, this.nationsTexture, this.nationIdxTexture, this.provincesTexture, this.thematicTexture])
        if (t) this.gl.deleteTexture(t);
      this.texture = this.coastTexture = this.nationsTexture = this.nationIdxTexture = this.provincesTexture = this.thematicTexture = null;
      this.texSize = { w: W, h: H };
    }
    if (!this.texture) this.texture = this.makeTexture(this.gl.LINEAR);
    if (!this.coastTexture) this.coastTexture = this.makeTexture(this.gl.NEAREST);

    const data = new Uint8Array(W * H * 4);
    const coast = new Uint8Array(W * H * 4);
    // Distance to the nearest river or lake, used for riparian biomes
    const wetSite = new Uint8Array(W * H);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++)
        if (world.grid[x][y].hasRiver || world.waterType[y * W + x] === 2) wetSite[y * W + x] = 1;
    const wet = distanceTransform(W, H, wetSite).dist;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cell = world.grid[x][y];
        const i = y * W + x;
        const idx = i * 4;
        data[idx] = Math.floor((cell.elevation || 0) * 255);
        data[idx + 1] = Math.floor((cell.moisture || 0) * 255);
        data[idx + 2] = Math.floor((cell.temperature || 0) * 255);
        data[idx + 3] = Math.floor((cell.populationDensity || 0) * 255);
        const q = world.coastSdf[i];
        coast[idx] = q >> 8;
        coast[idx + 1] = q & 255;
        coast[idx + 2] = world.waterType[i] === 2 ? 255 : world.waterType[i] === 1 ? 128 : 0;
        coast[idx + 3] = Math.min(255, Math.round(wet[i] * 32));
      }
    }
    this.upload(this.texture, W, H, data);
    this.upload(this.coastTexture, W, H, coast);
    this.nearestLandWorld = null;
  }

  private nationTexel(world: WorldData, x: number, y: number, out: Uint8Array, o: number) {
    const nIdx = world.grid[x][y].nationIndex ?? -1;
    if (nIdx >= 0 && nIdx < world.nations.length) {
      const hex = world.nations[nIdx].color;
      out[o] = parseInt(hex.slice(1, 3), 16);
      out[o + 1] = parseInt(hex.slice(3, 5), 16);
      out[o + 2] = parseInt(hex.slice(5, 7), 16);
      out[o + 3] = 255;
    } else {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    }
  }

  private provinceTexel(world: WorldData, x: number, y: number, out: Uint8Array, o: number, near: Int32Array) {
    let cell = world.grid[x][y];
    if (cell.isWater) {
      const n = near[y * world.width + x];
      if (n >= 0) cell = world.grid[n % world.width][Math.floor(n / world.width)];
    }
    const pIdx = cell.provinceIndex ?? -1;
    if (pIdx >= 0) {
      out[o] = pIdx & 0xff;
      out[o + 1] = (pIdx >> 8) & 0xff;
      out[o + 2] = (pIdx >> 16) & 0xff;
      out[o + 3] = 255;
    } else {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    }
  }

  // Writes a rectangle (x may wrap) through `texel`, or the whole map.
  private writeRegion(
    tex: WebGLTexture,
    world: WorldData,
    rect: Rect | undefined,
    texel: (x: number, y: number, out: Uint8Array, o: number) => void,
  ) {
    const gl = this.gl;
    const W = world.width;
    const H = world.height;
    if (!rect) {
      const data = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) texel(x, y, data, (y * W + x) * 4);
      this.upload(tex, W, H, data);
      return;
    }
    const startY = Math.max(0, rect.y);
    const endY = Math.min(H, rect.y + rect.h);
    const rectH = endY - startY;
    if (rectH <= 0) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    let nx = ((rect.x % W) + W) % W;
    let remaining = Math.min(rect.w, W);
    while (remaining > 0) {
      const chunkW = Math.min(remaining, W - nx);
      const sub = new Uint8Array(chunkW * rectH * 4);
      for (let ly = 0; ly < rectH; ly++)
        for (let lx = 0; lx < chunkW; lx++) texel(nx + lx, startY + ly, sub, (ly * chunkW + lx) * 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, nx, startY, chunkW, rectH, gl.RGBA, gl.UNSIGNED_BYTE, sub);
      remaining -= chunkW;
      nx = 0;
    }
  }

  public updateNationsDataTexture(world: WorldData, dirtyRect?: Rect) {
    if (!world || !world.grid) return;
    if (!this.nationsTexture || !this.nationIdxTexture) {
      this.nationsTexture = this.makeTexture(this.gl.NEAREST);
      this.nationIdxTexture = this.makeTexture(this.gl.NEAREST);
      dirtyRect = undefined;
    }
    this.writeRegion(this.nationsTexture, world, dirtyRect, (x, y, out, o) =>
      this.nationTexel(world, x, y, out, o),
    );
    this.writeRegion(this.nationIdxTexture, world, dirtyRect, (x, y, out, o) => {
      const n = world.grid[x][y].nationIndex ?? -1;
      if (n >= 0 && n < world.nations.length) {
        out[o] = n & 0xff;
        out[o + 1] = (n >> 8) & 0xff;
        out[o + 2] = (n >> 16) & 0xff;
        out[o + 3] = 255;
      } else out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    });
  }

  public updateProvincesDataTexture(world: WorldData, dirtyRect?: Rect) {
    if (!world || !world.grid) return;
    if (!this.provincesTexture) {
      this.provincesTexture = this.makeTexture(this.gl.NEAREST);
      dirtyRect = undefined;
    }
    const near = this.getNearestLand(world);
    this.writeRegion(this.provincesTexture, world, dirtyRect, (x, y, out, o) =>
      this.provinceTexel(world, x, y, out, o, near),
    );
  }

  // Colours one RGBA texel per cell for the thematic overlay. `colorOf` returns
  // [r, g, b, a] (0-255) for a land cell or null; water copies the nearest land.
  public updateThematicTexture(
    world: WorldData,
    colorOf: (x: number, y: number) => [number, number, number, number] | null,
  ) {
    if (!this.thematicTexture) this.thematicTexture = this.makeTexture(this.gl.NEAREST);
    const near = this.getNearestLand(world);
    const W = world.width;
    this.writeRegion(this.thematicTexture, world, undefined, (x, y, out, o) => {
      let i = y * W + x;
      if (world.waterType[i] !== 0) i = near[i];
      const c = i >= 0 ? colorOf(i % W, (i - (i % W)) / W) : null;
      if (c) {
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = c[3];
      } else out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    });
  }

  public render(
    width: number,
    height: number,
    worldWidth: number,
    worldHeight: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    layers: RenderLayers,
    hoverNationIndex: number = -1,
    hoverProvinceIndex: number = -1,
    seed: number = 0,
    theme: MapTheme = "Realistic",
    thematic: ThematicMode = "none",
    hoverNationColor: [number, number, number] = [1, 1, 1],
    fast = false, // skip costly fine detail while the view is moving
  ) {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const bind = (unit: number, tex: WebGLTexture | null, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.u(name), unit);
    };
    bind(0, this.texture, "u_mapTexture");
    bind(1, this.coastTexture, "u_coastTex");
    bind(2, this.nationsTexture, "u_nationsTexture");
    bind(3, this.provincesTexture, "u_provincesTexture");
    bind(4, this.thematicTexture, "u_thematicTex");
    bind(5, this.nationIdxTexture, "u_nationIdxTex");

    // Split the camera into an integer cell near the screen centre plus a
    // small local offset so the shader keeps sub-meter precision.
    const centerWX = (width / 2 - offsetX) / scale;
    const centerWY = (height / 2 - offsetY) / scale;
    const originUX = Math.floor(centerWX);
    const originY = Math.max(0, Math.min(worldHeight - 1, Math.floor(centerWY)));
    const originX = ((originUX % worldWidth) + worldWidth) % worldWidth;
    const offLX = offsetX + originUX * scale;
    const offLY = offsetY + originY * scale;
    // Rotated farmland lattice evaluated at the origin in double precision
    const A = 0.45;
    const fx = (Math.cos(A) * originX - Math.sin(A) * originY) * 20;
    const fy = (Math.sin(A) * originX + Math.cos(A) * originY) * 20;

    gl.uniform2f(this.u("u_resolution"), width, height);
    gl.uniform2f(this.u("u_worldSize"), worldWidth, worldHeight);
    gl.uniform2i(this.u("u_worldSizeI"), worldWidth, worldHeight);
    gl.uniform1ui(this.u("u_seed"), seed >>> 0);
    gl.uniform1f(this.u("u_scale"), scale);
    gl.uniform2f(this.u("u_offsetLocal"), offLX, offLY);
    gl.uniform2i(this.u("u_originI"), originX, originY);
    gl.uniform2i(this.u("u_fieldOriginI"), Math.floor(fx), Math.floor(fy));
    gl.uniform2f(this.u("u_fieldOriginF"), fx - Math.floor(fx), fy - Math.floor(fy));

    gl.uniform1i(this.u("u_showBiomes"), layers.biomes ? 1 : 0);
    gl.uniform1i(this.u("u_showElevation"), layers.elevation ? 1 : 0);
    gl.uniform1i(this.u("u_showHeatmap"), layers.heatmap ? 1 : 0);
    gl.uniform1i(this.u("u_showPopulation"), layers.population ? 1 : 0);
    gl.uniform1i(this.u("u_showMoisture"), layers.moisture ? 1 : 0);
    gl.uniform1i(this.u("u_showNations"), layers.nations ? 1 : 0);
    gl.uniform1i(this.u("u_showBorders"), layers.borders ? 1 : 0);
    gl.uniform1i(this.u("u_showProvinces"), layers.provinces ? 1 : 0);
    gl.uniform1i(this.u("u_theme"), THEME_INDEX[theme]);
    gl.uniform1i(this.u("u_thematic"), this.thematicTexture ? THEMATIC_INDEX[thematic] : 0);

    gl.uniform3fv(this.u("u_biomeColors"), this.biomeColors);
    gl.uniform1f(this.u("u_hoverNationIndex"), hoverNationIndex);
    gl.uniform3f(this.u("u_hoverNationColor"), hoverNationColor[0], hoverNationColor[1], hoverNationColor[2]);
    gl.uniform1i(this.u("u_showIce"), layers.ice ? 1 : 0);
    gl.uniform1i(this.u("u_fast"), fast ? 1 : 0);
    gl.uniform1f(this.u("u_hoverProvinceIndex"), hoverProvinceIndex);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}
