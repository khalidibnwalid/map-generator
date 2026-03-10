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
    uniform sampler2D u_provincesTexture;
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
    uniform bool u_showBorders;
    uniform bool u_showProvinces;

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

    bool isSame(vec4 a, vec4 b) {
        return distance(a, b) < 0.001;
    }

    float getBorderStrength(vec4 c00, vec4 c10, vec4 c01, vec4 c11, vec2 fxy, float thickness, float aa) {
        // Bilinear weights for the 4 corners
        float w00 = (1.0 - fxy.x) * (1.0 - fxy.y);
        float w10 = fxy.x * (1.0 - fxy.y);
        float w01 = (1.0 - fxy.x) * fxy.y;
        float w11 = fxy.x * fxy.y;
        
        // Analytical gradients of the bilinear weights
        vec2 g00 = vec2(fxy.y - 1.0, fxy.x - 1.0);
        vec2 g10 = vec2(1.0 - fxy.y, -fxy.x);
        vec2 g01 = vec2(-fxy.y, 1.0 - fxy.x);
        vec2 g11 = vec2(fxy.y, fxy.x);
        
        // Sum weights and gradients for unique IDs
        float s00 = w00; vec2 gs00 = g00;
        float s10 = w10; vec2 gs10 = g10;
        float s01 = w01; vec2 gs01 = g01;
        float s11 = w11; vec2 gs11 = g11;

        if (isSame(c10, c00)) { s00 += s10; gs00 += gs10; s10 = 0.0; }
        if (isSame(c01, c00)) { s00 += s01; gs00 += gs01; s01 = 0.0; }
        if (isSame(c11, c00)) { s00 += s11; gs00 += gs11; s11 = 0.0; }
        
        if (s10 > 0.0) {
            if (isSame(c01, c10)) { s10 += s01; gs10 += gs01; s01 = 0.0; }
            if (isSame(c11, c10)) { s10 += s11; gs10 += gs11; s11 = 0.0; }
        }
        
        if (s01 > 0.0) {
            if (isSame(c11, c01)) { s01 += s11; gs01 += gs11; s11 = 0.0; }
        }
        
        // Find top two sums and their gradients
        float m1 = s00; vec2 q1 = gs00;
        float m2 = 0.0; vec2 q2 = vec2(0.0);
        
        if (s10 > m1) { m2 = m1; q2 = q1; m1 = s10; q1 = gs10; } else if (s10 > m2) { m2 = s10; q2 = gs10; }
        if (s01 > m1) { m2 = m1; q2 = q1; m1 = s01; q1 = gs01; } else if (s01 > m2) { m2 = s01; q2 = gs01; }
        if (s11 > m1) { m2 = m1; q2 = q1; m1 = s11; q1 = gs11; } else if (s11 > m2) { m2 = s11; q2 = gs11; }
        
        // Gradient of the field difference (m1 - m2)
        vec2 grad = q1 - q2;
        float gradMag = length(grad);
        
        // Distance = (value) / (gradient magnitude)
        // This makes the field a "true distance field" in coordinate space
        float dist = (m1 - m2) / max(0.0001, gradMag);
        
        // Centered smoothstep for perfectly aligned borders
        return smoothstep(thickness + aa * 0.5, thickness - aa * 0.5, dist);
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
                float aa = 1.0 / u_scale;
                float landMask = smoothstep(0.448, 0.452, renderedElevation);
                
                vec3 finalNationColor = nationColor.rgb;
                float alpha = 0.4 * landMask;
                
                if (distance(nationColor.rgb, u_hoverColor) < 0.01) {
                    color = mix(color, finalNationColor + vec3(0.2), alpha * 1.5);
                } else {
                    color = mix(color, finalNationColor, alpha);
                }
            }
        }

        // --- 3.5 Borders (Nation & Province, with Smooth Bilinear Interpolation) ---
        float natBorderStrength = 0.0;
        if (u_showBorders || u_showProvinces) {
            vec2 pos = vec2(nx, ny) * u_worldSize - 0.5;
            vec2 ixy = floor(pos);
            vec2 fxy = fract(pos);
            
            // Organic Wavy Warp
            float warp_scale = 0.15;
            float warp_amp = 0.15;
            float warp_f = (fbm(wxwy * warp_scale) - 0.5) * warp_amp;
            float warp_d = (fbm_high(wxwy * 1.5) - 0.5) * 0.05;
            vec2 noisy_fxy = fxy + warp_f + warp_d;

            // Synchronized Land Mask: evaluate elevation at the warped position
            vec2 warped_nxny = (ixy + 0.5 + noisy_fxy) / u_worldSize;
            float warped_elevation = texture2D(u_mapTexture, warped_nxny).r;
            float borderLandMask = smoothstep(0.448, 0.452, warped_elevation);

            if (borderLandMask > 0.01) {
                float field_per_pixel = 1.0 / max(0.01, u_scale);
                
                // Borders get thicker as we zoom out to remain visible
                float zoomVisibility = clamp(1.6 / pow(u_scale, 0.4), 1.0, 2.5);
                float aa = 1.2 * field_per_pixel; 

                if (u_showBorders) {
                    vec4 n00 = texture2D(u_nationsTexture, (ixy + vec2(0.5, 0.5)) / u_worldSize);
                    vec4 n10 = texture2D(u_nationsTexture, (ixy + vec2(1.5, 0.5)) / u_worldSize);
                    vec4 n01 = texture2D(u_nationsTexture, (ixy + vec2(0.5, 1.5)) / u_worldSize);
                    vec4 n11 = texture2D(u_nationsTexture, (ixy + vec2(1.5, 1.5)) / u_worldSize);
                    
                    // Nation: target ~2.4 screen pixels (centered half-width = 1.2)
                    float thickness = 1.2 * field_per_pixel * zoomVisibility; 
                    natBorderStrength = getBorderStrength(n00, n10, n01, n11, noisy_fxy, thickness, aa);
                    
                    if (natBorderStrength > 0.01) {
                        color = mix(color, vec3(1.0), natBorderStrength * 0.8 * borderLandMask);
                    }
                }

                if (u_showProvinces) {
                    vec4 p00 = texture2D(u_provincesTexture, (ixy + vec2(0.5, 0.5)) / u_worldSize);
                    vec4 p10 = texture2D(u_provincesTexture, (ixy + vec2(1.5, 0.5)) / u_worldSize);
                    vec4 p01 = texture2D(u_provincesTexture, (ixy + vec2(0.5, 1.5)) / u_worldSize);
                    vec4 p11 = texture2D(u_provincesTexture, (ixy + vec2(1.5, 1.5)) / u_worldSize);
                    
                    // Province: target ~1.0 screen pixel (centered half-width = 0.5)
                    float thickness = 0.5 * field_per_pixel * zoomVisibility; 
                    float provBorderStrength = getBorderStrength(p00, p10, p01, p11, noisy_fxy, thickness, aa);
                    
                    // Suppress province borders where a national border exists
                    provBorderStrength *= (1.0 - natBorderStrength);

                    if (provBorderStrength > 0.01) {
                        float dash = step(0.4, fract((wxwy.x + wxwy.y) * 1.5));
                        color = mix(color, vec3(0.0), provBorderStrength * 0.4 * borderLandMask * (0.6 + 0.4 * dash));
                    }
                }
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
  private provincesTexture: WebGLTexture | null = null;
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

  public updateNationsDataTexture(
    world: WorldData,
    dirtyRect?: { x: number; y: number; w: number; h: number },
  ) {
    if (!world || !world.grid) return;

    const gl = this.gl;
    const W = world.width;
    const H = world.height;

    if (!this.nationsTexture) {
      this.nationsTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.nationsTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const emptyData = new Uint8Array(W * H * 4);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        W,
        H,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        emptyData,
      );
    }

    gl.bindTexture(gl.TEXTURE_2D, this.nationsTexture);

    if (dirtyRect) {
      this.partialUpdateRegion(world, dirtyRect);
    } else {
      const data = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cell = world.grid[x][y];
          const idx = (y * W + x) * 4;
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
            data[idx + 3] = 0;
          }
        }
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        W,
        H,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
    }
  }

  public updateProvincesDataTexture(
    world: WorldData,
    dirtyRect?: { x: number; y: number; w: number; h: number },
  ) {
    if (!world || !world.grid) return;

    const gl = this.gl;
    const W = world.width;
    const H = world.height;

    if (!this.provincesTexture) {
      this.provincesTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.provincesTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.provincesTexture);
    if (dirtyRect) {
      this.partialUpdateRegionProvinces(world, dirtyRect);
    } else {
      const data = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cell = world.grid[x][y];
          const idx = (y * W + x) * 4;
          const pIdx = cell.provinceIndex ?? -1;

          if (pIdx >= 0) {
            data[idx] = pIdx & 0xff;
            data[idx + 1] = (pIdx >> 8) & 0xff;
            data[idx + 2] = (pIdx >> 16) & 0xff;
            data[idx + 3] = 255;
          } else {
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 0;
          }
        }
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        W,
        H,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
    }
  }

  private partialUpdateRegionProvinces(
    world: WorldData,
    rect: { x: number; y: number; w: number; h: number },
  ) {
    const gl = this.gl;
    const W = world.width;
    const H = world.height;

    const startX = rect.x;
    const startY = Math.max(0, rect.y);
    const endY = Math.min(H, rect.y + rect.h);
    const rectH = endY - startY;

    if (rectH <= 0) return;

    let normalizedX = ((startX % W) + W) % W;
    let remainingW = rect.w;

    while (remainingW > 0) {
      const chunkW = Math.min(remainingW, W - normalizedX);
      const subData = new Uint8Array(chunkW * rectH * 4);
      for (let ly = 0; ly < rectH; ly++) {
        const gy = startY + ly;
        for (let lx = 0; lx < chunkW; lx++) {
          const gx = normalizedX + lx;
          const cell = world.grid[gx][gy];
          const pIdx = cell.provinceIndex ?? -1;
          const subIdx = (ly * chunkW + lx) * 4;

          if (pIdx >= 0) {
            subData[subIdx] = pIdx & 0xff;
            subData[subIdx + 1] = (pIdx >> 8) & 0xff;
            subData[subIdx + 2] = (pIdx >> 16) & 0xff;
            subData[subIdx + 3] = 255;
          } else {
            subData[subIdx] = 0;
            subData[subIdx + 1] = 0;
            subData[subIdx + 2] = 0;
            subData[subIdx + 3] = 0;
          }
        }
      }
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        normalizedX,
        startY,
        chunkW,
        rectH,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        subData,
      );
      remainingW -= chunkW;
      normalizedX = 0;
    }
  }

  private partialUpdateRegion(
    world: WorldData,
    rect: { x: number; y: number; w: number; h: number },
  ) {
    const gl = this.gl;
    const W = world.width;
    const H = world.height;

    const startX = rect.x;
    const startY = Math.max(0, rect.y);
    const endY = Math.min(H, rect.y + rect.h);
    const rectH = endY - startY;

    if (rectH <= 0) return;

    // Handle X-wrapping by splitting into up to 3 chunks: [left-overflow, main, right-overflow]
    const chunks: { x: number; w: number }[] = [];

    // Normalize startX to be within [0, W)
    let normalizedX = ((startX % W) + W) % W;
    let remainingW = rect.w;

    while (remainingW > 0) {
      const chunkW = Math.min(remainingW, W - normalizedX);
      chunks.push({ x: normalizedX, w: chunkW });
      remainingW -= chunkW;
      normalizedX = 0; // Next chunk starts at 0
    }

    chunks.forEach((chunk) => {
      const subData = new Uint8Array(chunk.w * rectH * 4);
      for (let ly = 0; ly < rectH; ly++) {
        const gy = startY + ly;
        for (let lx = 0; lx < chunk.w; lx++) {
          const gx = chunk.x + lx;
          const cell = world.grid[gx][gy];
          const nIdx = cell.nationIndex ?? -1;
          const subIdx = (ly * chunk.w + lx) * 4;

          if (nIdx >= 0 && nIdx < world.nations.length) {
            const hex = world.nations[nIdx].color;
            subData[subIdx] = parseInt(hex.slice(1, 3), 16);
            subData[subIdx + 1] = parseInt(hex.slice(3, 5), 16);
            subData[subIdx + 2] = parseInt(hex.slice(5, 7), 16);
            subData[subIdx + 3] = 255;
          } else {
            subData[subIdx] = 0;
            subData[subIdx + 1] = 0;
            subData[subIdx + 2] = 0;
            subData[subIdx + 3] = 0;
          }
        }
      }
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        chunk.x,
        startY,
        chunk.w,
        rectH,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        subData,
      );
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
    layers: {
      biomes: boolean;
      elevation: boolean;
      heatmap: boolean;
      moisture: boolean;
      nations: boolean;
      borders: boolean;
      provinces: boolean;
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

    if (this.provincesTexture) {
      this.gl.activeTexture(this.gl.TEXTURE2);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.provincesTexture);
      this.gl.uniform1i(
        this.gl.getUniformLocation(this.program, "u_provincesTexture"),
        2,
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
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showBorders"),
      layers.borders ? 1 : 0,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, "u_showProvinces"),
      layers.provinces ? 1 : 0,
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
