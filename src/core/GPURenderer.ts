import { WorldData, BIOME_COLORS, BiomeType } from "../game/WorldData";

const VERTEX_SHADER_SOURCE = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0, 1);
        v_texCoord = (a_position + 1.0) / 2.0;
    }
`;

const FRAGMENT_SHADER_SOURCE = `
    precision highp float;
    uniform sampler2D u_mapTexture;
    uniform sampler2D u_nationsTexture;
    uniform vec2 u_resolution;
    uniform vec2 u_worldSize;
    uniform float u_scale;
    uniform vec2 u_offset;
    
    // Layer visibility flags
    uniform bool u_showBiomes;
    uniform bool u_showElevation;
    uniform bool u_showHeatmap;
    uniform bool u_showMoisture;
    uniform bool u_showNations;

    uniform vec3 u_biomeColors[24];
    uniform vec3 u_hoverColor;

    int getBiome(float elevation, float temperature, float moisture) {
        if (elevation < 0.1) return 20; // DEEP_OCEAN
        if (elevation < 0.3) return 0; // OCEAN
        if (elevation < 0.45) return 1; // SHALLOW_WATER
        if (elevation < 0.48) return 2; // BEACH

        if (elevation > 0.85) {
            if (moisture > 0.5) return 7; // SNOW
            if (moisture > 0.33) return 6; // TUNDRA
            if (moisture > 0.16) return 5; // BARE
            return 4; // SCORCHED
        }

        if (elevation < 0.55 && moisture > 0.7) {
            return 21; // MARSH
        }

        if (temperature > 0.66) { // Hot
            if (moisture > 0.66) return 15; // TROPICAL_RAIN_FOREST
            if (moisture > 0.50) return 14; // TROPICAL_SEASONAL_FOREST
            if (moisture > 0.33) return 22; // SAVANNA
            if (moisture > 0.16) return 10; // GRASSLAND
            return 13; // SUBTROPICAL_DESERT
        }

        if (temperature > 0.33) { // Temperate
            if (moisture > 0.83) return 12; // TEMPERATE_RAIN_FOREST
            if (moisture > 0.50) return 11; // TEMPERATE_DECIDUOUS_FOREST
            if (moisture > 0.33) return 10; // GRASSLAND
            if (moisture > 0.16) return 23; // STEPPE
            return 8; // TEMPERATE_DESERT
        }

        if (moisture > 0.80) return 7; // SNOW
        if (moisture > 0.50) return 19; // TAIGA
        if (moisture > 0.33) return 9; // SHRUBLAND
        return 6; // TUNDRA
    }

    float rand(vec2 co) {
        return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
    }

    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = rand(i);
        float b = rand(i + vec2(1.0, 0.0));
        float c = rand(i + vec2(0.0, 1.0));
        float d = rand(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }

    float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 4; i++) {
            value += amplitude * noise(p);
            p *= 2.0;
            amplitude *= 0.5;
        }
        return value;
    }

    float fbm_high(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 6; i++) {
            value += amplitude * noise(p);
            p *= 2.0;
            amplitude *= 0.5;
        }
        return value;
    }

    vec3 getBiomeColor(int idx) {
        for (int i = 0; i < 24; i++) {
            if (i == idx) return u_biomeColors[i];
        }
        return vec3(0.0);
    }

    float agriculture(vec2 p) {
        float angle = 0.45;
        mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
        vec2 q = rot * p * 0.15;
        vec2 f = fract(q);
        float cell = rand(floor(q));
        return (f.x < 0.95 && f.y < 0.95) ? cell : -1.0;
    }

    void main() {
        vec2 screenCoord = gl_FragCoord.xy;
        screenCoord.y = u_resolution.y - screenCoord.y;

        vec2 wxwy = (screenCoord - u_offset) / u_scale;
        
        float worldX = wxwy.x;
        float worldY = wxwy.y;

        float nx = worldX / u_worldSize.x;
        nx = nx - floor(nx);
        float ny = clamp(worldY / u_worldSize.y, 0.0, 1.0);
        
        vec4 data = texture2D(u_mapTexture, vec2(nx, ny));
        float elevation = data.r;
        float moisture = data.g;
        float temperature = data.b;

        float shoreNoise = (fbm_high(wxwy * 0.5) - 0.5) * 0.05 * clamp(u_scale * 0.1, 0.0, 1.0);
        float renderedElevation = elevation + shoreNoise;

        float eps = 1.0 / u_worldSize.x; 
        float hL = texture2D(u_mapTexture, vec2(nx - eps, ny)).r;
        float hR = texture2D(u_mapTexture, vec2(nx + eps, ny)).r;
        float hD = texture2D(u_mapTexture, vec2(nx, ny - eps)).r;
        float hU = texture2D(u_mapTexture, vec2(nx, ny + eps)).r;
        
        vec3 lightDir = normalize(vec3(-1.0, 1.0, 0.5));
        vec3 va = normalize(vec3(2.0 * eps, 0.0, hR - hL));
        vec3 vb = normalize(vec3(0.0, 2.0 * eps, hU - hD));
        vec3 normal = cross(va, vb);
        float shade = dot(normal, lightDir);
        shade = 0.8 + 0.4 * shade;

        vec3 color = vec3(0.0);
        
        // --- 1. Base Layers ---
        if (u_showBiomes) {
            float blendFactor = smoothstep(3.0, 8.0, u_scale);
            float e_noise = (fbm(wxwy * 1.5) - 0.5) * 0.05 * blendFactor;
            float t_noise = (fbm(wxwy * 1.5 + 10.0) - 0.5) * 0.15 * blendFactor;
            float m_noise = (fbm(wxwy * 1.5 + 20.0) - 0.5) * 0.15 * blendFactor;

            float query_e = clamp(elevation + e_noise, 0.0, 1.0);
            float query_t = clamp(temperature + t_noise, 0.0, 1.0);
            float query_m = clamp(moisture + m_noise, 0.0, 1.0);
            
            int bIdx = getBiome(query_e, query_t, query_m);
            vec3 biomeBase = getBiomeColor(bIdx);
            float detail = fbm(wxwy * 0.05);

            if (renderedElevation < 0.45) { 
                float depth = clamp(renderedElevation / 0.45, 0.0, 1.0);
                vec3 deepOcean = vec3(0.05, 0.15, 0.3);
                vec3 shallowOcean = vec3(0.1, 0.4, 0.6);
                color = mix(deepOcean, shallowOcean, depth);
                color += (detail - 0.5) * 0.05;
                float distToLand = smoothstep(0.4, 0.45, renderedElevation);
                color = mix(color, color + vec3(0.1, 0.2, 0.2), distToLand * 0.5);
            } else { 
                color = biomeBase;
                float dirtNoise = fbm(wxwy * 2.0);
                color *= (0.85 + 0.3 * dirtNoise);

                if (bIdx == 10 || bIdx == 11 || bIdx == 22 || bIdx == 14 || bIdx == 15) {
                   float ag = agriculture(wxwy);
                   if (ag > 0.0) {
                       vec3 agColor = mix(color, color * (0.8 + 0.4 * ag), 0.3);
                       color = mix(color, agColor, 0.7);
                   }
                }

                if (elevation > 0.7) { 
                    color = mix(color, vec3(0.4, 0.35, 0.3), (detail - 0.5) * 0.5);
                    if (elevation > 0.85) {
                        float snowBlend = smoothstep(0.85, 0.9, elevation + (detail-0.5)*0.2);
                        color = mix(color, vec3(0.9, 0.9, 0.95), snowBlend);
                    }
                } else {
                    color = mix(color, color * (0.9 + 0.2 * detail), 0.4);
                }

                color *= shade;

                if (renderedElevation < 0.48) {
                    float beachBlend = smoothstep(0.45, 0.48, renderedElevation);
                    color = mix(vec3(0.83, 0.8, 0.63) * shade, color, beachBlend);
                }
            }
        } else if (u_showElevation) {
            bool isWater = renderedElevation < 0.45;
            color = isWater ? vec3(0.0, 0.0, renderedElevation) : vec3(renderedElevation) * shade;
        }

        // --- 2. Overlays ---
        if (u_showHeatmap) color = mix(color, vec3(temperature, 0.0, 1.0 - temperature), 0.4);
        if (u_showMoisture) color = mix(color, vec3(1.0 - moisture, 1.0 - moisture, moisture), 0.4);

        // --- 3. Nations ---
        if (u_showNations) {
            vec2 pos = vec2(nx, ny) * u_worldSize - 0.5;
            vec2 ixy = floor(pos);
            vec2 fxy = fract(pos);
            
            vec4 c00 = texture2D(u_nationsTexture, (ixy + vec2(0.5, 0.5)) / u_worldSize);
            vec4 c10 = texture2D(u_nationsTexture, (ixy + vec2(1.5, 0.5)) / u_worldSize);
            vec4 c01 = texture2D(u_nationsTexture, (ixy + vec2(0.5, 1.5)) / u_worldSize);
            vec4 c11 = texture2D(u_nationsTexture, (ixy + vec2(1.5, 1.5)) / u_worldSize);
            
            vec4 blended = mix(mix(c00, c10, fxy.x), mix(c01, c11, fxy.x), fxy.y);
            
            float d00 = distance(blended, c00);
            float d10 = distance(blended, c10);
            float d01 = distance(blended, c01);
            float d11 = distance(blended, c11);
            
            float minDist = min(min(d00, d10), min(d01, d11));
            vec4 nationColor;
            if (minDist == d00) nationColor = c00;
            else if (minDist == d10) nationColor = c10;
            else if (minDist == d01) nationColor = c01;
            else nationColor = c11;

            if (nationColor.a > 0.1) {
                float aa = 1.6 / u_scale; // Slightly wider AA
                float landMask = smoothstep(0.448, 0.452, renderedElevation);
                
                // --- Smooth Border Logic (No More Grid!) ---
                // We find the second minimum distance to detect boundaries between nations
                float d2 = 1.0;
                if (minDist != d00) d2 = min(d2, d00);
                if (minDist != d10) d2 = min(d2, d10);
                if (minDist != d01) d2 = min(d2, d01);
                if (minDist != d11) d2 = min(d2, d11);
                
                // Border is where the difference between two closest samples is small
                // Using distance from blended to neighbors is a proxy for how "mixed" we are
                float border = smoothstep(0.1, 0.05, d2 - minDist); 
                
                // If it's a border between a nation and "nothing" (ocean on CPU), handle separately
                // but with global coverage, alpha is 1 everywhere.
                
                vec3 finalNationColor = mix(nationColor.rgb, nationColor.rgb * 0.5, border * 0.7);
                float alpha = 0.4 * landMask;
                
                if (distance(nationColor.rgb, u_hoverColor) < 0.01) {
                    color = mix(color, finalNationColor + vec3(0.2), alpha * 1.5);
                } else {
                    color = mix(color, finalNationColor, alpha);
                }
            } else if (u_showBiomes || u_showElevation) {
                color *= 0.85;
            }
        }

        gl_FragColor = vec4(color, 1.0);
    }
`;

export class GPURenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private nationsTexture: WebGLTexture | null = null;
  private buffer: WebGLBuffer | null = null;
  private biomeColors: Float32Array;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;

    this.program = this.createProgram(
      VERTEX_SHADER_SOURCE,
      FRAGMENT_SHADER_SOURCE,
    );
    this.setupQuad();
    this.biomeColors = this.prepareBiomeColors();
  }

  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type)!;
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      throw new Error(
        `Shader compilation error: ${this.gl.getShaderInfoLog(shader)}`,
      );
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
      throw new Error(
        `Program link error: ${this.gl.getProgramInfoLog(program)}`,
      );
    }
    return program;
  }

  private setupQuad() {
    this.buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    const positions = new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
    ]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
  }

  private prepareBiomeColors(): Float32Array {
    const colors = new Float32Array(24 * 3);
    const typeToIndex: Record<string, number> = {
      [BiomeType.OCEAN]: 0,
      [BiomeType.SHALLOW_WATER]: 1,
      [BiomeType.BEACH]: 2,
      [BiomeType.SCORCHED]: 4,
      [BiomeType.BARE]: 5,
      [BiomeType.TUNDRA]: 6,
      [BiomeType.SNOW]: 7,
      [BiomeType.TEMPERATE_DESERT]: 8,
      [BiomeType.SHRUBLAND]: 9,
      [BiomeType.GRASSLAND]: 10,
      [BiomeType.TEMPERATE_DECIDUOUS_FOREST]: 11,
      [BiomeType.TEMPERATE_RAIN_FOREST]: 12,
      [BiomeType.SUBTROPICAL_DESERT]: 13,
      [BiomeType.TROPICAL_SEASONAL_FOREST]: 14,
      [BiomeType.TROPICAL_RAIN_FOREST]: 15,
      [BiomeType.DEEP_OCEAN]: 20,
      [BiomeType.MARSH]: 21,
      [BiomeType.SAVANNA]: 22,
      [BiomeType.STEPPE]: 23,
      [BiomeType.TAIGA]: 19, // Using 19 for Taiga to avoid out of bounds if array is 24
    };
    for (const [type, colorHex] of Object.entries(BIOME_COLORS)) {
      const idx = typeToIndex[type];
      if (idx === undefined) continue;
      colors[idx * 3] = parseInt(colorHex.slice(1, 3), 16) / 255;
      colors[idx * 3 + 1] = parseInt(colorHex.slice(3, 5), 16) / 255;
      colors[idx * 3 + 2] = parseInt(colorHex.slice(5, 7), 16) / 255;
    }
    return colors;
  }

  public updateWorldTexture(world: WorldData) {
    if (!world || !world.grid) return;
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);

    const data = new Uint8Array(world.width * world.height * 4);
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const cell = world.grid[x][y];
        const idx = (y * world.width + x) * 4;
        if (!cell) continue;
        data[idx] = Math.floor((cell.elevation || 0) * 255);
        data[idx + 1] = Math.floor((cell.moisture || 0) * 255);
        data[idx + 2] = Math.floor((cell.temperature || 0) * 255);
        data[idx + 3] = 255;
      }
    }

    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      world.width,
      world.height,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      data,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_S,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_T,
      this.gl.CLAMP_TO_EDGE,
    );

    console.log(`Texture updated for ${world.width}x${world.height}`);
  }

  public updateNationsDataTexture(world: WorldData) {
    if (!world || !world.grid) return;
    if (this.nationsTexture) this.gl.deleteTexture(this.nationsTexture);
    this.nationsTexture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.nationsTexture);

    const data = new Uint8Array(world.width * world.height * 4);
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const cell = world.grid[x][y];
        const idx = (y * world.width + x) * 4;
        const nIdx = cell.nationIndex ?? -1;

        if (nIdx >= 0 && nIdx < world.nations.length) {
          const hex = world.nations[nIdx].color;
          data[idx] = parseInt(hex.slice(1, 3), 16);
          data[idx + 1] = parseInt(hex.slice(3, 5), 16);
          data[idx + 2] = parseInt(hex.slice(5, 7), 16);
          data[idx + 3] = 255;
        } else {
          data[idx] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 0; // Ocean/Water
        }
      }
    }

    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      world.width,
      world.height,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      data,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.NEAREST,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.NEAREST,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_S,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_T,
      this.gl.CLAMP_TO_EDGE,
    );
  }

  public render(
    width: number,
    height: number,
    worldWidth: number,
    worldHeight: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    layers: {
      biomes: boolean;
      elevation: boolean;
      heatmap: boolean;
      moisture: boolean;
      nations: boolean;
    },
    hoverColor?: number[],
  ) {
    this.gl.viewport(0, 0, width, height);
    this.gl.useProgram(this.program);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_mapTexture"),
      0,
    );

    if (this.nationsTexture) {
      this.gl.activeTexture(this.gl.TEXTURE1);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.nationsTexture);
      this.gl.uniform1i(
        this.gl.getUniformLocation(this.program, "u_nationsTexture"),
        1,
      );
    }

    const posLoc = this.gl.getAttribLocation(this.program, "a_position");
    this.gl.enableVertexAttribArray(posLoc);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.vertexAttribPointer(posLoc, 2, this.gl.FLOAT, false, 0, 0);

    this.gl.uniform2f(
      this.gl.getUniformLocation(this.program, "u_resolution"),
      width,
      height,
    );
    this.gl.uniform2f(
      this.gl.getUniformLocation(this.program, "u_worldSize"),
      worldWidth,
      worldHeight,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program, "u_scale"),
      scale,
    );
    this.gl.uniform2f(
      this.gl.getUniformLocation(this.program, "u_offset"),
      offsetX,
      offsetY,
    );

    // Set layer uniforms
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showBiomes"),
      layers.biomes ? 1 : 0,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showElevation"),
      layers.elevation ? 1 : 0,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showHeatmap"),
      layers.heatmap ? 1 : 0,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showMoisture"),
      layers.moisture ? 1 : 0,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showNations"),
      layers.nations ? 1 : 0,
    );

    this.gl.uniform3fv(
      this.gl.getUniformLocation(this.program, "u_biomeColors"),
      this.biomeColors,
    );

    if (hoverColor) {
      this.gl.uniform3f(
        this.gl.getUniformLocation(this.program, "u_hoverColor"),
        hoverColor[0],
        hoverColor[1],
        hoverColor[2],
      );
    } else {
      this.gl.uniform3f(
        this.gl.getUniformLocation(this.program, "u_hoverColor"),
        -1.0,
        -1.0,
        -1.0,
      );
    }

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }
}
