import { BYTES_PER_EVENT, type EventData, type Meta } from "./data";
import { GRID_MAX, type Area, type DayWindow } from "./selection";

/** The map's view: `x` and `y` are the share of the world at the panel's center. */
export interface Camera {
  zoom: number;
  x: number;
  y: number;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

interface Program {
  program: WebGLProgram;
  uniforms: Uniforms;
}

interface Resources {
  points: Program;
  downsample: Program;
  blur: Program;
  composite: Program;
  pointsVao: WebGLVertexArrayObject;
  visibleBuffer: WebGLBuffer;
  emptyVao: WebGLVertexArrayObject;
}

interface Targets {
  density: Target;
  nearA: Target;
  nearB: Target;
  farA: Target;
  farB: Target;
}

// Point colors from the sparsest to the densest areas, evenly spaced after black, which
// keeps empty areas matching the background.
export const DEFAULT_GRADIENT = ["#893426", "#e67f0e", "#faba58", "#fff3da"];
const GRADIENT_START = "#000000";

const gradientStops = (colors: readonly string[]) => [GRADIENT_START, ...colors];

const hexChannels = (hex: string) =>
  [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);

const MAX_PIXEL_RATIO = 2;
const MAP_FILL = 0.96;

// Width in CSS pixels of an event with no recorded deaths. Sizes between whole pixels
// are drawn by lighting the edge pixels by how much of them the point covers.
const POINT_SIZE = 1.7;
// A point's width grows with the square root of its deaths, so its area grows with
// the deaths: this much of the base width for each step of the square root.
const SIZE_PER_ROOT = 0.3;
// The widest a point gets, in CSS pixels at the home view.
const MAX_POINT_SIZE = 64;
// Bigger points spread their light thinner, so a large event reads as a soft disc
// instead of a solid blob: brightness falls by the size ratio to this power.
const LIGHT_SPREAD = 1.35;
// Large points fade toward their edge by up to this share of their brightness.
const EDGE_SOFTNESS = 0.7;
// Points turn from squares to circles as they grow between these widths in device pixels.
const ROUND_POINT_SIZES = [3, 5];

export const MAP_MAX_ZOOM = 64;
// Points grow with zoom, reaching this multiple of their size at the closest zoom.
const MAX_ZOOM_GROWTH = 3.46;
// Added to a point's brightness for each doubling of zoom.
const MAP_ZOOM_BRIGHTNESS = 0.9;

// Brightness of one event. It falls once points would cover the map more than this
// many times over, so dense views keep their detail and look alike at any size.
const POINT_WEIGHT = 0.3;
const FULL_WEIGHT_COVERAGE = 0.15;
const WEIGHT_FALLOFF = 0.95;
const DEFAULT_BRIGHTNESS = 1;
// Events outside a drawn box are drawn this bright, and lose this share of their color.
const UNSELECTED_WEIGHT = 0.16;
const UNSELECTED_DESATURATION = 0.5;
const NEAR_GLOW = 0.3;
const FAR_GLOW = 0.75;

const POINT_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_days;
layout(location = 2) in float a_best;
layout(location = 3) in float a_visible;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_window;
uniform vec4 u_area;
uniform float u_pointSize;
uniform float u_maxSize;
flat out float v_size;
flat out float v_light;
flat out float v_unselected;
void main() {
  // Filtered out, or outside the dates: outside the clip volume, so never drawn.
  if (a_visible < 0.5 || a_days.x >= u_window.y || a_days.y < u_window.x) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    return;
  }
  bool outsideArea = any(lessThan(a_position, u_area.xy)) || any(greaterThan(a_position, u_area.zw));
  float size = min(u_pointSize * (1.0 + ${SIZE_PER_ROOT} * sqrt(a_best)), u_maxSize);
  v_size = size;
  v_light = pow(u_pointSize / size, ${LIGHT_SPREAD}) * (outsideArea ? ${UNSELECTED_WEIGHT} : 1.0);
  v_unselected = outsideArea ? 1.0 : 0.0;
  // A pixel wider than the point, so pixels it only partly covers are drawn too.
  gl_PointSize = ceil(size) + 1.0;
  gl_Position = vec4(a_position * u_scale + u_offset, 0.0, 1.0);
}`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_weight;
uniform vec2 u_roundSizes;
flat in float v_size;
flat in float v_light;
flat in float v_unselected;
out vec4 color;
void main() {
  // This pixel's offset from the point's center, in pixels.
  vec2 offset = abs(gl_PointCoord - 0.5) * (ceil(v_size) + 1.0);
  float half_size = v_size * 0.5;
  // How much of this pixel a square point covers, so its total light is its exact area.
  vec2 overlap = clamp(min(vec2(half_size), offset + 0.5) - max(vec2(-half_size), offset - 0.5), 0.0, 1.0);
  float square = overlap.x * overlap.y;
  // A circle, scaled up to give off as much light as the square.
  float distance = length(offset);
  float circle = clamp(half_size + 0.5 - distance, 0.0, 1.0) * ${4 / Math.PI};
  float roundness = smoothstep(u_roundSizes.x, u_roundSizes.y, v_size);
  // Large circles fade toward their edge.
  float edge = clamp(distance / max(half_size, 1e-3), 0.0, 1.0);
  float soften = 1.0 - ${EDGE_SOFTNESS} * smoothstep(u_roundSizes.y, u_roundSizes.y * 4.0, v_size) * edge * edge;
  float coverage = mix(square, circle * soften, roundness);
  // Density in red, and the density of events outside the box in alpha.
  float weight = u_weight * coverage * v_light;
  color = vec4(weight, 0.0, 0.0, weight * v_unselected);
}`;

const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const TONE = `
float tone(float density) { return 1.0 - exp(-density); }
// Tones the density and scales the other channels to match.
vec4 toned(vec4 value) {
  float light = tone(value.r);
  return vec4(light, value.gba * (light / max(value.r, 1e-6)));
}`;

const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform float u_applyTone;
out vec4 color;
${TONE}
vec4 read(vec2 offset) {
  vec4 value = texture(u_source, v_uv + offset * u_texel);
  return mix(value, toned(value), u_applyTone);
}
void main() {
  vec4 sum = read(vec2(-1.0, -1.0)) + read(vec2(1.0, -1.0))
           + read(vec2(-1.0, 1.0)) + read(vec2(1.0, 1.0));
  color = sum * 0.25;
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_step;
out vec4 color;
void main() {
  vec4 sum = texture(u_source, v_uv) * 0.1964825;
  sum += (texture(u_source, v_uv + u_step * 1.4117647)
        + texture(u_source, v_uv - u_step * 1.4117647)) * 0.2969069;
  sum += (texture(u_source, v_uv + u_step * 3.2941176)
        + texture(u_source, v_uv - u_step * 3.2941176)) * 0.0944703;
  sum += (texture(u_source, v_uv + u_step * 5.1764706)
        + texture(u_source, v_uv - u_step * 5.1764706)) * 0.0103814;
  color = sum;
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_density;
uniform sampler2D u_near;
uniform sampler2D u_far;
uniform float u_nearGlow;
uniform float u_farGlow;
uniform float u_outsideDesaturation;
out vec4 color;
${TONE}
const int STOP_COUNT = ${DEFAULT_GRADIENT.length + 1};
uniform vec3 u_stops[STOP_COUNT];
vec3 gradient(float value) {
  float position = clamp(value, 0.0, 1.0) * float(STOP_COUNT - 1);
  int stop = min(int(position), STOP_COUNT - 2);
  return mix(u_stops[stop], u_stops[stop + 1], position - float(stop));
}
float noise(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec4 core = toned(texture(u_density, v_uv));
  vec4 near = texture(u_near, v_uv) * u_nearGlow;
  vec4 far = texture(u_far, v_uv) * u_farGlow;
  float nearLight = clamp(near.r, 0.0, 1.0);
  float farLight = clamp(far.r, 0.0, 1.0);
  float light = 1.0 - (1.0 - core.r) * (1.0 - nearLight) * (1.0 - farLight);
  light += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  vec3 rgb = gradient(light);
  // Grays by the share of the light that comes from events outside the box.
  float outside = (core.a + near.a + far.a) / max(core.r + near.r + far.r, 1e-6);
  float gray = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3(gray), clamp(outside, 0.0, 1.0) * u_outsideDesaturation);
  color = vec4(rgb, 1.0);
}`;

/** The share of the panel's width and height the world fills, keeping it undistorted. */
export function mapFill({ xMax, yMax }: Meta["extent"], width: number, height: number): [number, number] {
  const worldAspect = xMax / yMax;
  const panelAspect = width / height;
  return panelAspect > worldAspect
    ? [(MAP_FILL * worldAspect) / panelAspect, MAP_FILL]
    : [MAP_FILL, (MAP_FILL * panelAspect) / worldAspect];
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  uniformNames: string[],
): Program {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Shader failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms: Uniforms = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  return { texture, framebuffer, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target) {
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

export interface Errors {
  noWebGl: string;
  noFloatRendering: string;
}

/**
 * Draws every event into a density buffer, then turns density into light with a
 * two-size glow. Each event's size comes from its deaths. Filters arrive as a
 * per-event visibility buffer; dates and the box are checked on the GPU, so
 * dragging the timeline only changes uniforms.
 */
export class EventRenderer {
  private gl: WebGL2RenderingContext;
  private resources: Resources | null = null;
  private targets: Targets | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private visible: Uint8Array;
  private shownCount = 0;
  private window: DayWindow = { from: 0, to: 0 };
  private area: Area = { west: 0, east: GRID_MAX, south: 0, north: GRID_MAX };
  private camera: Camera = { zoom: 1, x: 0.5, y: 0.5 };
  private frame = 0;
  private maxPointSize = 64;
  private gradient = new Float32Array(gradientStops(DEFAULT_GRADIENT).flatMap(hexChannels));

  constructor(
    private canvas: HTMLCanvasElement,
    private data: EventData,
    private errors: Errors,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error(errors.noWebGl);
    this.gl = gl;
    this.visible = new Uint8Array(data.meta.count);

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.createResources();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
  }

  setLayout(width: number, height: number) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.width = width;
    this.height = height;
    const pixelWidth = Math.max(1, Math.round(width * this.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(height * this.pixelRatio));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight || !this.targets) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.createTargets();
    }
    this.requestDraw();
  }

  /** Which events pass the filters, as 1 or 0 per event. */
  setVisible(visible: Uint8Array) {
    this.visible = visible;
    this.uploadVisible();
    this.requestDraw();
  }

  /** The dates shown, and how many filtered events fall in them, which sets their brightness. */
  setWindow(window: DayWindow, shownCount: number) {
    this.window = window;
    this.shownCount = shownCount;
    this.requestDraw();
  }

  setArea(area: Area) {
    this.area = area;
    this.requestDraw();
  }

  setCamera(camera: Camera) {
    this.camera = camera;
    this.requestDraw();
  }

  /** Draws immediately and waits for the GPU. Returns milliseconds taken. */
  measureDraw(): number {
    const pixel = new Uint8Array(4);
    const started = performance.now();
    this.draw();
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
    return performance.now() - started;
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resources = null;
    this.targets = null;
  };

  private onContextRestored = () => {
    this.createResources();
    this.createTargets();
    this.uploadVisible();
    this.requestDraw();
  };

  private createResources() {
    const { gl } = this;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error(this.errors.noFloatRendering);
    }
    const sizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.maxPointSize = sizeRange?.[1] ?? 64;

    const pointsVao = gl.createVertexArray()!;
    gl.bindVertexArray(pointsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.data.buffer), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, true, BYTES_PER_EVENT, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, false, BYTES_PER_EVENT, 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_INT, false, BYTES_PER_EVENT, 8);
    const visibleBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, visibleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.visible, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.bindVertexArray(null);

    this.resources = {
      points: createProgram(gl, POINT_VERTEX, POINT_FRAGMENT, [
        "u_scale",
        "u_offset",
        "u_window",
        "u_area",
        "u_pointSize",
        "u_maxSize",
        "u_weight",
        "u_roundSizes",
      ]),
      downsample: createProgram(gl, FULLSCREEN_VERTEX, DOWNSAMPLE_FRAGMENT, [
        "u_source",
        "u_texel",
        "u_applyTone",
      ]),
      blur: createProgram(gl, FULLSCREEN_VERTEX, BLUR_FRAGMENT, ["u_source", "u_step"]),
      composite: createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT, [
        "u_density",
        "u_near",
        "u_far",
        "u_nearGlow",
        "u_farGlow",
        "u_stops",
        "u_outsideDesaturation",
      ]),
      pointsVao,
      visibleBuffer,
      emptyVao: gl.createVertexArray()!,
    };
  }

  private uploadVisible() {
    const { gl, resources } = this;
    if (!resources) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.visibleBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.visible);
  }

  private createTargets() {
    const { gl, canvas } = this;
    if (this.targets) {
      for (const target of Object.values(this.targets)) deleteTarget(gl, target);
    }
    const size = (divisor: number) =>
      [
        Math.max(1, Math.ceil(canvas.width / divisor)),
        Math.max(1, Math.ceil(canvas.height / divisor)),
      ] as const;
    this.targets = {
      density: createTarget(gl, canvas.width, canvas.height),
      nearA: createTarget(gl, ...size(4)),
      nearB: createTarget(gl, ...size(4)),
      farA: createTarget(gl, ...size(16)),
      farB: createTarget(gl, ...size(16)),
    };
  }

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    const { gl, resources, targets, pixelRatio } = this;
    if (!resources || !targets) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.density.framebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const { points, pointsVao } = resources;
    const { uniforms } = points;
    gl.useProgram(points.program);
    gl.bindVertexArray(pointsVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const { zoom, x, y } = this.camera;
    const fill = mapFill(this.data.meta.extent, this.width, this.height);
    const growth = Math.min(zoom ** (Math.log(MAX_ZOOM_GROWTH) / Math.log(MAP_MAX_ZOOM)), MAX_ZOOM_GROWTH);
    const pointSize = Math.max(0.5, POINT_SIZE * growth * pixelRatio);
    const baseWeight = this.pointWeight(pointSize, fill[0] * fill[1] * zoom ** 2);
    // Crowded views get less of the zoom boost, so dense areas don't merge into a haze.
    const roominess = Math.sqrt(baseWeight / POINT_WEIGHT);
    const weight = baseWeight * (1 + MAP_ZOOM_BRIGHTNESS * Math.log2(zoom) * roominess) * DEFAULT_BRIGHTNESS;

    const scaleX = 2 * fill[0] * zoom;
    const scaleY = 2 * fill[1] * zoom;
    gl.uniform2f(uniforms.u_scale!, scaleX, scaleY);
    gl.uniform2f(uniforms.u_offset!, -scaleX * x, -scaleY * y);
    gl.uniform2f(uniforms.u_window!, this.window.from, this.window.to);
    // Half a grid step past each edge, so rounding can't drop events on the edge.
    const { west, east, south, north } = this.area;
    gl.uniform4f(
      uniforms.u_area!,
      (west - 0.5) / GRID_MAX,
      (south - 0.5) / GRID_MAX,
      (east + 0.5) / GRID_MAX,
      (north + 0.5) / GRID_MAX,
    );
    gl.uniform1f(uniforms.u_pointSize!, pointSize);
    gl.uniform1f(
      uniforms.u_maxSize!,
      Math.min(MAX_POINT_SIZE * growth * pixelRatio, this.maxPointSize - 1),
    );
    gl.uniform1f(uniforms.u_weight!, weight);
    gl.uniform2f(uniforms.u_roundSizes!, ROUND_POINT_SIZES[0]!, ROUND_POINT_SIZES[1]!);
    gl.drawArrays(gl.POINTS, 0, this.data.meta.count);

    gl.disable(gl.BLEND);
    this.drawGlow(resources, targets);
  }

  /** Fewer events get brighter points, so a single year reads as well as all of them. */
  private pointWeight(pointSize: number, filled: number) {
    const plotPixels = this.canvas.width * this.canvas.height * filled;
    const coverage = (Math.max(1, this.shownCount) * pointSize ** 2) / plotPixels;
    return POINT_WEIGHT * Math.min(1, (FULL_WEIGHT_COVERAGE / coverage) ** WEIGHT_FALLOFF);
  }

  private drawGlow(resources: Resources, targets: Targets) {
    const { gl } = this;
    const { downsample, blur, composite, emptyVao } = resources;
    gl.bindVertexArray(emptyVao);
    gl.activeTexture(gl.TEXTURE0);

    const pass = (target: Target | null) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
      gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const shrink = (source: Target, target: Target, applyTone: number) => {
      gl.useProgram(downsample.program);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(downsample.uniforms.u_source!, 0);
      gl.uniform2f(downsample.uniforms.u_texel!, 1 / source.width, 1 / source.height);
      gl.uniform1f(downsample.uniforms.u_applyTone!, applyTone);
      pass(target);
    };
    const soften = (main: Target, spare: Target) => {
      gl.useProgram(blur.program);
      gl.uniform1i(blur.uniforms.u_source!, 0);
      gl.bindTexture(gl.TEXTURE_2D, main.texture);
      gl.uniform2f(blur.uniforms.u_step!, 1 / main.width, 0);
      pass(spare);
      gl.bindTexture(gl.TEXTURE_2D, spare.texture);
      gl.uniform2f(blur.uniforms.u_step!, 0, 1 / main.height);
      pass(main);
    };

    shrink(targets.density, targets.nearA, 1);
    shrink(targets.nearA, targets.farA, 0);
    soften(targets.nearA, targets.nearB);
    soften(targets.farA, targets.farB);

    gl.useProgram(composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.density.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.nearA.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, targets.farA.texture);
    gl.uniform1i(composite.uniforms.u_density!, 0);
    gl.uniform1i(composite.uniforms.u_near!, 1);
    gl.uniform1i(composite.uniforms.u_far!, 2);
    gl.uniform1f(composite.uniforms.u_nearGlow!, NEAR_GLOW);
    gl.uniform1f(composite.uniforms.u_farGlow!, FAR_GLOW);
    gl.uniform3fv(composite.uniforms.u_stops!, this.gradient);
    gl.uniform1f(composite.uniforms.u_outsideDesaturation!, UNSELECTED_DESATURATION);
    pass(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
