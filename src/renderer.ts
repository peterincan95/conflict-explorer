import {
  BYTES_PER_EVENT,
  VIOLENCE_TYPES,
  type EventData,
  type LineCounts,
  type LineDetail,
  type Meta,
  type ViolenceType,
} from "./data";
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
  lines: Program;
  pointsVao: WebGLVertexArrayObject;
  visibleBuffer: WebGLBuffer;
  emptyVao: WebGLVertexArrayObject;
}

/** Basemap lines uploaded as pairs of vertices, one pair per segment, coastlines first. */
interface BasemapLines {
  vao: WebGLVertexArrayObject;
  counts: LineCounts;
}

interface Targets {
  density: Target;
  lines: Target;
  nearA: Target;
  nearB: Target;
  farA: Target;
  farB: Target;
}

// Point colors from the sparsest to the densest areas, evenly spaced after black, which
// keeps empty areas matching the background.
export const DEFAULT_GRADIENT = ["#893426", "#e67f0e", "#faba58", "#fff3da"];

/** Point colors by type of violence: state-based, non-state and one-sided. */
export const TYPE_COLORS: Record<ViolenceType, string> = {
  1: "#3d8bff",
  2: "#2fc46a",
  3: "#ff5ca8",
};
// Type colors run through a ramp like the default gradient's: black, a dark shade at
// this share of the color, the color itself at half brightness, then tints this far
// toward white, ending close to white at the brightest.
const TYPE_DARK_SHADE = 0.5;
const TYPE_LIGHT_TINT = 0.45;
const TYPE_PEAK_TINT = 0.9;
const GRADIENT_START = "#000000";

const gradientStops = (colors: readonly string[]) => [GRADIENT_START, ...colors];

const hexChannels = (hex: string) =>
  [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);

const MAX_PIXEL_RATIO = 2;
const MAP_FILL = 0.96;
// Equal Earth's constants, matching scripts/prep_data.py, written as GLSL floats.
const A1 = "1.340264";
const A2 = "-0.081106";
const A3 = "0.000893";
const A4 = "0.003796";
const M = (Math.sqrt(3) / 2).toFixed(7);

// Width in CSS pixels of an event with no recorded deaths. Sizes between whole pixels
// are drawn by lighting the edge pixels by how much of them the point covers.
const POINT_SIZE = 1.3;
// A point's width grows with the square root of its deaths, so its area grows with
// the deaths: this many CSS pixels for each step of the square root.
const SIZE_PER_ROOT = 0.51;
// Brightness is set as if the smallest points were this wide, so shrinking them
// makes them denser, not dimmer, and larger points keep their brightness.
const LIGHT_BASE_SIZE = 1.7;
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

/** How much points have grown at a zoom. */
const zoomGrowth = (zoom: number) =>
  Math.min(zoom ** (Math.log(MAX_ZOOM_GROWTH) / Math.log(MAP_MAX_ZOOM)), MAX_ZOOM_GROWTH);

/** An event's width on screen in CSS pixels, at a zoom. */
export function pointWidth(deaths: number, zoom: number) {
  const growth = zoomGrowth(zoom);
  return Math.min((POINT_SIZE + SIZE_PER_ROOT * Math.sqrt(deaths)) * growth, MAX_POINT_SIZE * growth);
}

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
// The basemap's gray for land and water alike, before relief. Outside the map is black.
const BASE_GRAY = 0.074;
// Relief lightens slopes facing the light by this much for each step brighter than
// flat ground, as a share of flat ground's gray, and darkens shaded ones by this much.
const RELIEF_LIGHT = 11;
const RELIEF_SHADE = 2.6;
// The relief fades out as the map zooms from the first of these to the second, past
// the zoom that shows a whole country, where the image would turn blurry.
export const RELIEF_FADE_ZOOMS = [12, 24];
// Line grays: coastlines, country borders and province borders. Province borders fade
// in between these zooms.
const COAST_GRAY = 0.2;
const BORDER_GRAY = 0.24;
const PROVINCE_GRAY = 0.14;
const PROVINCE_FADE_ZOOMS = [1.5, 3];
/** Past this zoom the map switches to the detailed lines, once they've loaded. */
export const DETAIL_LINE_ZOOM = 5;
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
uniform float u_rootSize;
uniform float u_lightSize;
uniform float u_maxSize;
flat out float v_size;
flat out float v_light;
flat out float v_unselected;
flat out vec2 v_type;
void main() {
  // Filtered out, or outside the dates: outside the clip volume, so never drawn.
  if (a_visible < 0.5 || a_days.x >= u_window.y || a_days.y < u_window.x) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    return;
  }
  bool outsideArea = any(lessThan(a_position, u_area.xy)) || any(greaterThan(a_position, u_area.zw));
  float size = min(u_pointSize + u_rootSize * sqrt(a_best), u_maxSize);
  v_size = size;
  v_light = pow(u_lightSize / size, ${LIGHT_SPREAD}) * (outsideArea ? ${UNSELECTED_WEIGHT} : 1.0);
  v_unselected = outsideArea ? 1.0 : 0.0;
  // a_visible holds the type of violence: 1 state-based, 2 non-state, 3 one-sided.
  v_type = vec2(a_visible > 1.5 && a_visible < 2.5 ? 1.0 : 0.0, a_visible > 2.5 ? 1.0 : 0.0);
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
flat in vec2 v_type;
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
  // Density in red, the density of non-state and one-sided events in green and blue,
  // and the density of events outside the box in alpha.
  float weight = u_weight * coverage * v_light;
  color = vec4(weight, weight * v_type, weight * v_unselected);
}`;

const LINE_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_position;
uniform vec2 u_scale;
uniform vec2 u_offset;
void main() {
  gl_Position = vec4(a_position * u_scale + u_offset, 0.0, 1.0);
}`;

const LINE_FRAGMENT = `#version 300 es
precision mediump float;
uniform float u_brightness;
out vec4 color;
void main() {
  color = vec4(u_brightness);
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
uniform sampler2D u_lines;
uniform sampler2D u_hillshade;
uniform float u_hasHillshade;
uniform float u_relief;
uniform float u_flat;
// Screen to the world's share: world = (screen * 2 - 1 - offset) / scale.
uniform vec4 u_projection;
uniform vec2 u_extent;
uniform float u_nearGlow;
uniform float u_farGlow;
uniform float u_outsideDesaturation;
uniform float u_colorByType;
uniform vec3 u_typeColors[3];
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
// How far inside the Equal Earth outline a spot is, in the projection's units: below 0
// is outside.
float insideMap(vec2 world) {
  float x = (world.x * 2.0 - 1.0) * u_extent.x;
  float y = (world.y * 2.0 - 1.0) * u_extent.y;
  float theta = clamp(y, -u_extent.y, u_extent.y) / ${A1};
  for (int step = 0; step < 6; step += 1) {
    float t2 = theta * theta;
    float t6 = t2 * t2 * t2;
    float f = theta * (${A1} + ${A2} * t2 + t6 * (${A3} + ${A4} * t2)) - clamp(y, -u_extent.y, u_extent.y);
    theta -= f / (${A1} + 3.0 * ${A2} * t2 + t6 * (7.0 * ${A3} + 9.0 * ${A4} * t2));
  }
  float t2 = theta * theta;
  float t6 = t2 * t2 * t2;
  float edge = ${Math.PI} * cos(theta) / (${M} * (${A1} + 3.0 * ${A2} * t2 + t6 * (7.0 * ${A3} + 9.0 * ${A4} * t2)));
  return min(edge - abs(x), u_extent.y - abs(y));
}
vec3 basemap() {
  vec2 world = (v_uv * 2.0 - 1.0 - u_projection.zw) / u_projection.xy;
  float inside = insideMap(world);
  // Half a screen pixel of blending at the edge.
  float pixel = fwidth(world.x) * u_extent.x;
  float onMap = smoothstep(-pixel, pixel, inside);
  float gray = ${BASE_GRAY.toFixed(3)};
  if (u_hasHillshade > 0.5) {
    float shade = texture(u_hillshade, vec2(world.x, 1.0 - world.y)).r / u_flat - 1.0;
    float relief = shade > 0.0 ? shade * ${RELIEF_LIGHT.toFixed(3)} : shade * ${RELIEF_SHADE.toFixed(3)};
    gray *= max(1.0 + relief * u_relief, 0.0);
  }
  float lines = texture(u_lines, v_uv).r;
  return vec3(max(gray, lines) * onMap);
}
void main() {
  vec4 core = toned(texture(u_density, v_uv));
  vec4 near = texture(u_near, v_uv) * u_nearGlow;
  vec4 far = texture(u_far, v_uv) * u_farGlow;
  float nearLight = clamp(near.r, 0.0, 1.0);
  float farLight = clamp(far.r, 0.0, 1.0);
  float light = 1.0 - (1.0 - core.r) * (1.0 - nearLight) * (1.0 - farLight);
  light += (noise(gl_FragCoord.xy) - 0.5) / 255.0;
  vec3 rgb = gradient(light);
  if (u_colorByType > 0.5) {
    // Each type's share of the light, from the density channels.
    vec3 sum = core.rgb + near.rgb + far.rgb;
    vec2 shares = clamp(sum.gb / max(sum.r, 1e-6), 0.0, 1.0);
    float state = max(1.0 - shares.x - shares.y, 0.0);
    vec3 hue = state * u_typeColors[0] + shares.x * u_typeColors[1] + shares.y * u_typeColors[2];
    vec3 ramp[5] = vec3[5](
      vec3(0.0),
      hue * ${TYPE_DARK_SHADE},
      hue,
      mix(hue, vec3(1.0), ${TYPE_LIGHT_TINT}),
      mix(hue, vec3(1.0), ${TYPE_PEAK_TINT})
    );
    float position = clamp(light, 0.0, 1.0) * 4.0;
    int stop = min(int(position), 3);
    rgb = mix(ramp[stop], ramp[stop + 1], position - float(stop));
  }
  // Grays by the share of the light that comes from events outside the box.
  float outside = (core.a + near.a + far.a) / max(core.r + near.r + far.r, 1e-6);
  float gray = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3(gray), clamp(outside, 0.0, 1.0) * u_outsideDesaturation);
  // Points light up the basemap under them.
  rgb = 1.0 - (1.0 - rgb) * (1.0 - basemap());
  color = vec4(rgb, 1.0);
}`;

/** 0 below the first zoom, 1 past the second, eased between, with zooms compared by doubling. */
function smoothstep([from, to]: number[], zoom: number) {
  const t = Math.min(1, Math.max(0, Math.log2(zoom / from!) / Math.log2(to! / from!)));
  return t * t * (3 - 2 * t);
}

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

function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: number = gl.RGBA16F,
): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
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
  private lineData: Partial<Record<LineDetail, { segments: Uint16Array; counts: LineCounts }>> = {};
  private lines: Partial<Record<LineDetail, BasemapLines>> = {};
  private hillshadeImage: TexImageSource | null = null;
  private hillshade: { texture: WebGLTexture; flat: number } | null = null;
  private flatShade = 1;
  private showRelief = true;
  private gradient = new Float32Array(gradientStops(DEFAULT_GRADIENT).flatMap(hexChannels));
  private typeColors = new Float32Array(VIOLENCE_TYPES.flatMap((type) => hexChannels(TYPE_COLORS[type])));
  private colorByType = false;
  /** What the GPU gets for each event: its type of violence if it passes the filters, else 0. */
  private visibleTypes: Uint8Array;

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
    this.visibleTypes = new Uint8Array(data.meta.count);

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
    const { type } = this.data.attrs;
    const types = this.visibleTypes;
    for (let index = 0; index < visible.length; index += 1) types[index] = visible[index] ? type[index]! : 0;
    this.uploadVisible();
    this.requestDraw();
  }

  /** Colors points by type of violence instead of by brightness. */
  setColorByType(isOn: boolean) {
    this.colorByType = isOn;
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

  /** Basemap lines at one level of detail, as segment endpoints on the events' grid. */
  setLines(detail: LineDetail, segments: Uint16Array, counts: LineCounts) {
    this.lineData[detail] = { segments, counts };
    this.uploadLines();
    this.requestDraw();
  }

  /**
   * The hillshade in Equal Earth, gray, with flat ground and water at `flat`, out of 255.
   */
  setHillshade(image: TexImageSource, flat: number) {
    this.hillshadeImage = image;
    this.flatShade = flat / 255;
    this.uploadHillshade();
    this.requestDraw();
  }

  /** Shows or hides the relief. */
  setReliefVisible(isVisible: boolean) {
    this.showRelief = isVisible;
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
    this.lines = {};
    this.uploadLines();
    this.hillshade = null;
    this.uploadHillshade();
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
        "u_rootSize",
        "u_lightSize",
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
        "u_lines",
        "u_hillshade",
        "u_hasHillshade",
        "u_relief",
        "u_flat",
        "u_projection",
        "u_extent",
        "u_colorByType",
        "u_typeColors",
      ]),
      lines: createProgram(gl, LINE_VERTEX, LINE_FRAGMENT, ["u_scale", "u_offset", "u_brightness"]),
      pointsVao,
      visibleBuffer,
      emptyVao: gl.createVertexArray()!,
    };
  }

  private uploadLines() {
    const { gl } = this;
    if (!this.resources) return;
    for (const [detail, data] of Object.entries(this.lineData) as [LineDetail, typeof this.lineData.coarse][]) {
      if (!data || this.lines[detail]) continue;
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, data.segments, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, true, 0, 0);
      gl.bindVertexArray(null);
      this.lines[detail] = { vao, counts: data.counts };
    }
  }

  private uploadHillshade() {
    const { gl, hillshadeImage } = this;
    if (!hillshadeImage || !this.resources || this.hillshade) return;
    let source = hillshadeImage;
    // Smaller GPUs get a smaller copy.
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const { width, height } = hillshadeImage as { width: number; height: number };
    if (width > maxSize) {
      const canvas = document.createElement("canvas");
      canvas.width = maxSize;
      canvas.height = Math.round((height * maxSize) / width);
      canvas.getContext("2d")!.drawImage(hillshadeImage as CanvasImageSource, 0, 0, canvas.width, canvas.height);
      source = canvas;
    }
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.hillshade = { texture, flat: this.flatShade };
  }

  private uploadVisible() {
    const { gl, resources } = this;
    if (!resources) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.visibleBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.visibleTypes);
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
      lines: createTarget(gl, canvas.width, canvas.height, gl.R8),
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
    const growth = zoomGrowth(zoom);
    const pointSize = Math.max(0.5, POINT_SIZE * growth * pixelRatio);
    const lightSize = Math.max(0.5, LIGHT_BASE_SIZE * growth * pixelRatio);
    const baseWeight = this.pointWeight(lightSize, fill[0] * fill[1] * zoom ** 2);
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
    gl.uniform1f(uniforms.u_rootSize!, SIZE_PER_ROOT * growth * pixelRatio);
    gl.uniform1f(uniforms.u_lightSize!, lightSize);
    gl.uniform1f(
      uniforms.u_maxSize!,
      Math.min(MAX_POINT_SIZE * growth * pixelRatio, this.maxPointSize - 1),
    );
    gl.uniform1f(uniforms.u_weight!, weight);
    gl.uniform2f(uniforms.u_roundSizes!, ROUND_POINT_SIZES[0]!, ROUND_POINT_SIZES[1]!);
    gl.drawArrays(gl.POINTS, 0, this.data.meta.count);
    const projection = [scaleX, scaleY, -scaleX * x, -scaleY * y];
    this.drawLines(resources, targets, projection);

    gl.disable(gl.BLEND);
    this.drawGlow(resources, targets, projection);
  }

  /** Draws the basemap lines into their own buffer, which the composite lays under the points. */
  private drawLines(resources: Resources, targets: Targets, projection: number[]) {
    const { gl } = this;
    const { zoom } = this.camera;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.lines.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const set = (zoom >= DETAIL_LINE_ZOOM && this.lines.fine) || this.lines.coarse;
    if (!set) return;
    const { lines } = resources;
    gl.useProgram(lines.program);
    gl.bindVertexArray(set.vao);
    gl.uniform2f(lines.uniforms.u_scale!, projection[0]!, projection[1]!);
    gl.uniform2f(lines.uniforms.u_offset!, projection[2]!, projection[3]!);
    // Where lines overlap, they keep the brightest one's gray rather than adding up.
    gl.blendEquation(gl.MAX);
    const { coast, border, province } = set.counts;
    const provinceGray = PROVINCE_GRAY * smoothstep(PROVINCE_FADE_ZOOMS, zoom);
    const draw = (gray: number, first: number, count: number) => {
      if (gray <= 0 || count === 0) return;
      gl.uniform1f(lines.uniforms.u_brightness!, gray);
      gl.drawArrays(gl.LINES, first * 2, count * 2);
    };
    draw(provinceGray, coast + border, province);
    draw(COAST_GRAY, 0, coast);
    draw(BORDER_GRAY, coast, border);
    gl.blendEquation(gl.FUNC_ADD);
  }

  /** Fewer events get brighter points, so a single year reads as well as all of them. */
  private pointWeight(pointSize: number, filled: number) {
    const plotPixels = this.canvas.width * this.canvas.height * filled;
    const coverage = (Math.max(1, this.shownCount) * pointSize ** 2) / plotPixels;
    return POINT_WEIGHT * Math.min(1, (FULL_WEIGHT_COVERAGE / coverage) ** WEIGHT_FALLOFF);
  }

  private drawGlow(resources: Resources, targets: Targets, projection: number[]) {
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
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, targets.lines.texture);
    gl.uniform1i(composite.uniforms.u_lines!, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.hillshade?.texture ?? null);
    gl.uniform1i(composite.uniforms.u_hillshade!, 4);
    gl.uniform1f(composite.uniforms.u_hasHillshade!, this.hillshade ? 1 : 0);
    gl.uniform1f(composite.uniforms.u_flat!, this.hillshade?.flat ?? 1);
    const relief = this.showRelief ? 1 - smoothstep(RELIEF_FADE_ZOOMS, this.camera.zoom) : 0;
    gl.uniform1f(composite.uniforms.u_relief!, relief);
    gl.uniform4f(composite.uniforms.u_projection!, projection[0]!, projection[1]!, projection[2]!, projection[3]!);
    const { xMax, yMax } = this.data.meta.extent;
    gl.uniform2f(composite.uniforms.u_extent!, xMax, yMax);
    gl.uniform1i(composite.uniforms.u_density!, 0);
    gl.uniform1i(composite.uniforms.u_near!, 1);
    gl.uniform1i(composite.uniforms.u_far!, 2);
    gl.uniform1f(composite.uniforms.u_nearGlow!, NEAR_GLOW);
    gl.uniform1f(composite.uniforms.u_farGlow!, FAR_GLOW);
    gl.uniform3fv(composite.uniforms.u_stops!, this.gradient);
    gl.uniform1f(composite.uniforms.u_outsideDesaturation!, UNSELECTED_DESATURATION);
    gl.uniform1f(composite.uniforms.u_colorByType!, this.colorByType ? 1 : 0);
    gl.uniform3fv(composite.uniforms.u_typeColors!, this.typeColors);
    pass(null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
