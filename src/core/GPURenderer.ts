import { WorldData, BIOME_COLORS, BiomeType } from '../game/WorldData';

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
    uniform vec2 u_resolution;
    uniform vec2 u_worldSize;
    uniform float u_scale;
    uniform vec2 u_offset;
    uniform int u_layer;
    uniform vec3 u_biomeColors[16];

    int getBiome(float elevation, float temperature, float moisture) {
        if (elevation < 0.3) return 0; // OCEAN
        if (elevation < 0.45) return 1; // SHALLOW_WATER
        if (elevation < 0.48) return 2; // BEACH

        if (elevation > 0.85) {
            if (moisture > 0.5) return 7; // SNOW
            if (moisture > 0.33) return 6; // TUNDRA
            if (moisture > 0.16) return 5; // BARE
            return 4; // SCORCHED
        }

        if (temperature > 0.66) {
            if (moisture > 0.66) return 15; // TROPICAL_RAIN_FOREST
            if (moisture > 0.33) return 14; // TROPICAL_SEASONAL_FOREST
            if (moisture > 0.16) return 10; // GRASSLAND
            return 13; // SUBTROPICAL_DESERT
        }

        if (temperature > 0.33) {
            if (moisture > 0.83) return 12; // TEMPERATE_RAIN_FOREST
            if (moisture > 0.5) return 11; // TEMPERATE_DECIDUOUS_FOREST
            if (moisture > 0.16) return 10; // GRASSLAND
            return 8; // TEMPERATE_DESERT
        }

        if (moisture > 0.66) return 7; // SNOW
        if (moisture > 0.33) return 9; // SHRUBLAND
        return 6; // TUNDRA
    }

    void main() {
        vec2 screenCoord = gl_FragCoord.xy;
        screenCoord.y = u_resolution.y - screenCoord.y;

        vec2 wxwy = (screenCoord - u_offset) / u_scale;
        
        // Final pixel coordinates in world space
        float wx = wxwy.x;
        float wy = wxwy.y;

        // DIAGNOSTIC 1: RED if out of vertical bounds
        if (wy < -0.1 || wy > u_worldSize.y + 0.1) {
            gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); 
            return;
        }

        // Wrap X continuously
        float normX = wx / u_worldSize.x;
        normX = normX - floor(normX);
        
        float normY = clamp(wy / u_worldSize.y, 0.0, 1.0);

        vec4 data = texture2D(u_mapTexture, vec2(normX, normY));
        
        // DIAGNOSTIC 2: GREEN if sampling purely empty (alpha=0) data
        if (data.a < 0.01) {
            gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);
            return;
        }

        float elevation = data.r;
        float moisture = data.g;
        float temperature = data.b;

        // DIAGNOSTIC 3: MAGENTA if data is perfect zero (uninitialized)
        if (elevation < 0.001 && moisture < 0.001 && temperature < 0.001) {
            gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
            return;
        }

        vec3 color = vec3(0.0);

        if (u_layer == 0) { // Biomes
            int biomeIdx = getBiome(elevation, temperature, moisture);
            for (int i = 0; i < 16; i++) {
                if (i == biomeIdx) {
                    color = u_biomeColors[i];
                    break;
                }
            }
        } else if (u_layer == 1) { // Elevation
            bool isWater = elevation < 0.45;
            color = isWater ? vec3(0.0, 0.0, elevation) : vec3(elevation);
        } else if (u_layer == 2) { // Heatmap
            color = vec3(temperature, 0.0, 1.0 - temperature);
        } else if (u_layer == 3) { // Moisture
            color = vec3(1.0 - moisture, 1.0 - moisture, moisture);
        }

        gl_FragColor = vec4(color, 1.0);
    }
`;

export class GPURenderer {
    private gl: WebGLRenderingContext;
    private program: WebGLProgram;
    private texture: WebGLTexture | null = null;
    private buffer: WebGLBuffer | null = null;
    private biomeColors: Float32Array;

    constructor(canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl', {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true
        });
        if (!gl) throw new Error('WebGL not supported');
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

    private setupQuad() {
        this.buffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
    }

    private prepareBiomeColors(): Float32Array {
        const colors = new Float32Array(16 * 3);
        const typeToIndex: Record<string, number> = {
            [BiomeType.OCEAN]: 0, [BiomeType.SHALLOW_WATER]: 1, [BiomeType.BEACH]: 2,
            [BiomeType.SCORCHED]: 4, [BiomeType.BARE]: 5, [BiomeType.TUNDRA]: 6,
            [BiomeType.SNOW]: 7, [BiomeType.TEMPERATE_DESERT]: 8, [BiomeType.SHRUBLAND]: 9,
            [BiomeType.GRASSLAND]: 10, [BiomeType.TEMPERATE_DECIDUOUS_FOREST]: 11,
            [BiomeType.TEMPERATE_RAIN_FOREST]: 12, [BiomeType.SUBTROPICAL_DESERT]: 13,
            [BiomeType.TROPICAL_SEASONAL_FOREST]: 14, [BiomeType.TROPICAL_RAIN_FOREST]: 15
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

        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, world.width, world.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, data);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

        console.log(`Texture updated for ${world.width}x${world.height}`);
    }

    public render(width: number, height: number, worldWidth: number, worldHeight: number, scale: number, offsetX: number, offsetY: number, layer: number) {
        this.gl.viewport(0, 0, width, height);
        this.gl.useProgram(this.program);
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
        this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_mapTexture'), 0);

        const posLoc = this.gl.getAttribLocation(this.program, 'a_position');
        this.gl.enableVertexAttribArray(posLoc);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
        this.gl.vertexAttribPointer(posLoc, 2, this.gl.FLOAT, false, 0, 0);

        this.gl.uniform2f(this.gl.getUniformLocation(this.program, 'u_resolution'), width, height);
        this.gl.uniform2f(this.gl.getUniformLocation(this.program, 'u_worldSize'), worldWidth, worldHeight);
        this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_scale'), scale);
        this.gl.uniform2f(this.gl.getUniformLocation(this.program, 'u_offset'), offsetX, offsetY);
        this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_layer'), layer);
        this.gl.uniform3fv(this.gl.getUniformLocation(this.program, 'u_biomeColors'), this.biomeColors);

        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }
}
