import { CircleGeometry, Color, Mesh, ShaderMaterial, type Object3D } from "three";
import {
  MAX_CEILING_HEIGHT,
  MIN_CEILING_HEIGHT,
  type CeilingStyle,
} from "@vair/shared";

/**
 * The ceiling (plan.md §13 — local and instant, never a round trip).
 *
 * A ceiling is what turns the void into a room, and it is the half of the
 * backrooms look that the ground cannot supply on its own: `tiles` over
 * `carpet` is the entire effect.
 *
 * Same faded disc as the ground, for the same reason — a hard rectangular edge
 * overhead reads as a floating slab, while a fade reads as a room whose extent
 * you simply cannot make out.
 */

type CeilingSpec = {
  color: number;
  lineColor: number;
  /** Strength of the grout/joint lines, 0..1. */
  lines: number;
  /** Metres between joints. Office tiles are ~0.6m. */
  spacing: number;
  /** Per-tile brightness jitter, which is what stops tiles looking printed. */
  variation: number;
};

const STYLES: Record<CeilingStyle, CeilingSpec> = {
  void: { color: 0x000000, lineColor: 0x000000, lines: 0, spacing: 1, variation: 0 },
  // Slightly yellowed and unevenly stained, which is what makes it read as a
  // real suspended ceiling rather than a white grid.
  tiles: { color: 0xcfc7a8, lineColor: 0x6f6a58, lines: 0.85, spacing: 0.6, variation: 0.12 },
  concrete: { color: 0x5b5e63, lineColor: 0x4a4d52, lines: 0.25, spacing: 2.4, variation: 0.05 },
  plaster: { color: 0xd8d8d4, lineColor: 0xc9c9c4, lines: 0.05, spacing: 3, variation: 0.02 },
  wood: { color: 0x4a3524, lineColor: 0x33241a, lines: 0.6, spacing: 0.22, variation: 0.08 },
};

const RADIUS = 30;

export class Ceiling {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private style: CeilingStyle = "void";

  constructor(parent: Object3D) {
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: new Color(0x000000) },
        uLineColor: { value: new Color(0x000000) },
        uLines: { value: 0 },
        uSpacing: { value: 1 },
        uVariation: { value: 0 },
        uRadius: { value: RADIUS },
      },
      vertexShader: /* glsl */ `
        varying vec2 vXZ;
        varying float vDist;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vXZ = world.xz;
          vDist = length(world.xz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uLineColor;
        uniform float uLines;
        uniform float uSpacing;
        uniform float uVariation;
        uniform float uRadius;
        varying vec2 vXZ;
        varying float vDist;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(41.7, 289.1))) * 43758.5453);
        }

        void main() {
          vec2 cell = vXZ / uSpacing;

          // Per-tile brightness jitter — the difference between a ceiling and
          // a sheet of graph paper.
          float tint = (hash(floor(cell)) - 0.5) * 2.0 * uVariation;

          // Derivative-scaled joints stay one pixel wide at any distance.
          vec2 g = abs(fract(cell - 0.5) - 0.5) / fwidth(cell);
          float line = 1.0 - min(min(g.x, g.y), 1.0);

          vec3 color = mix(uColor * (1.0 + tint), uLineColor, line * uLines);
          float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, vDist);
          gl_FragColor = vec4(color, fade);
        }
      `,
    });

    this.mesh = new Mesh(new CircleGeometry(RADIUS, 96), this.material);
    // Facing down at the room rather than up at nothing.
    this.mesh.rotation.x = Math.PI / 2;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  setStyle(style: CeilingStyle, height: number): void {
    this.style = style;
    this.mesh.position.y = Math.min(MAX_CEILING_HEIGHT, Math.max(MIN_CEILING_HEIGHT, height));

    if (style === "void") {
      this.mesh.visible = false;
      return;
    }
    const spec = STYLES[style];
    this.mesh.visible = true;
    (this.material.uniforms.uColor!.value as Color).setHex(spec.color);
    (this.material.uniforms.uLineColor!.value as Color).setHex(spec.lineColor);
    this.material.uniforms.uLines!.value = spec.lines;
    this.material.uniforms.uSpacing!.value = spec.spacing;
    this.material.uniforms.uVariation!.value = spec.variation;
  }

  get current(): CeilingStyle {
    return this.style;
  }
}
