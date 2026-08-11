import {
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  type Object3D,
} from "three";
import { GROUND_STYLES, type GroundStyle } from "@vair/shared";

/**
 * The ground plane (plan.md §13 — local and instant, never a round trip).
 *
 * It exists for a practical reason as much as an aesthetic one: an object
 * resting on nothing reads as floating, which makes "put a cube here" almost
 * impossible to judge. Deixis already raycasts the y=0 plane whether or not
 * anything is drawn there, so this makes visible a surface the system was
 * already using.
 *
 * A disc rather than an infinite plane, faded out at the rim. A hard-edged
 * quad in an unlit void looks like a floating platform; a fade reads as ground
 * receding into the dark and hides the fact that it ends at all.
 */

type StyleSpec = { color: number; gridColor: number; grid: number };

const STYLES: Record<GroundStyle, StyleSpec> = {
  // `void` is handled by hiding the mesh; the entry keeps the record total.
  void: { color: 0x000000, gridColor: 0x000000, grid: 0 },
  grid: { color: 0x05070f, gridColor: 0x2a3a6b, grid: 1 },
  grass: { color: 0x2f4a2a, gridColor: 0x3c5c35, grid: 0.15 },
  stone: { color: 0x3a3d44, gridColor: 0x4a4e57, grid: 0.3 },
  sand: { color: 0x6b5c3e, gridColor: 0x7a6a49, grid: 0.1 },
  snow: { color: 0x8f9bb3, gridColor: 0xa8b4c9, grid: 0.1 },
  wood: { color: 0x4a3524, gridColor: 0x5c432e, grid: 0.4 },
  water: { color: 0x14314f, gridColor: 0x1e4a72, grid: 0.2 },
};

const RADIUS = 30;

export class Ground {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private style: GroundStyle = "grid";

  constructor(parent: Object3D) {
    this.material = new ShaderMaterial({
      transparent: true,
      // The rim fades to fully transparent, so writing depth there would
      // occlude whatever is beyond it with nothing visible doing the occluding.
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uColor: { value: new Color(STYLES.grid.color) },
        uGridColor: { value: new Color(STYLES.grid.gridColor) },
        uGrid: { value: STYLES.grid.grid },
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
        uniform vec3 uGridColor;
        uniform float uGrid;
        uniform float uRadius;
        varying vec2 vXZ;
        varying float vDist;

        void main() {
          // Screen-space derivative keeps the lines one pixel wide at any
          // distance, so the grid neither aliases into noise far away nor
          // fattens into stripes underfoot.
          vec2 g = abs(fract(vXZ - 0.5) - 0.5) / fwidth(vXZ);
          float line = 1.0 - min(min(g.x, g.y), 1.0);

          vec3 color = mix(uColor, uGridColor, line * uGrid);
          float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, vDist);
          gl_FragColor = vec4(color, fade);
        }
      `,
    });

    this.mesh = new Mesh(new CircleGeometry(RADIUS, 96), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    // Drawn before everything else and never depth-writing, so wisps and props
    // above it composite correctly without sorting artefacts.
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  get current(): GroundStyle {
    return this.style;
  }

  setStyle(style: GroundStyle): void {
    this.style = style;
    if (style === "void") {
      this.mesh.visible = false;
      return;
    }
    const spec = STYLES[style];
    this.mesh.visible = true;
    (this.material.uniforms.uColor!.value as Color).setHex(spec.color);
    (this.material.uniforms.uGridColor!.value as Color).setHex(spec.gridColor);
    this.material.uniforms.uGrid!.value = spec.grid;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible && this.style !== "void";
  }
}

export { GROUND_STYLES };
