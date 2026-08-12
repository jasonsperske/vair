import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, type Object3D } from "three";
import type { SkyStyle } from "@vair/shared";

/**
 * The sky (plan.md §13 — local and instant, never a round trip).
 *
 * An inside-out sphere with a vertical gradient rather than a cube map: styles
 * are two colours and a star toggle, so they cross-fade by changing uniforms
 * with no texture loading, no network, and nothing to evict. That matters on a
 * headset reached over `adb reverse` with no guaranteed internet.
 *
 * `void` is the default and hides the mesh entirely, leaving §2's black.
 */

type SkySpec = { horizon: number; zenith: number; stars: number };

const STYLES: Record<SkyStyle, SkySpec> = {
  void: { horizon: 0x000000, zenith: 0x000000, stars: 0 },
  day: { horizon: 0x9fc4e8, zenith: 0x2f6fb5, stars: 0 },
  dusk: { horizon: 0xe8894a, zenith: 0x2a1e4a, stars: 0.25 },
  night: { horizon: 0x0a1226, zenith: 0x02040c, stars: 1 },
  overcast: { horizon: 0x8d939b, zenith: 0x5a6068, stars: 0 },
  storm: { horizon: 0x3d434b, zenith: 0x1b1f26, stars: 0 },
};

/** Inside the camera's 200m far plane, outside anything the user can build. */
const RADIUS = 150;

export class Sky {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private style: SkyStyle = "void";

  constructor(parent: Object3D) {
    this.material = new ShaderMaterial({
      side: BackSide,
      // The sky is behind everything and must never occlude or be occluded.
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uHorizon: { value: new Color(0x000000) },
        uZenith: { value: new Color(0x000000) },
        uStars: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHorizon;
        uniform vec3 uZenith;
        uniform float uStars;
        varying vec3 vDir;

        float hash(vec3 p) {
          return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        }

        void main() {
          // Below the horizon mirrors the horizon colour, so looking down past
          // the ground disc's fade meets sky rather than a hard black edge.
          float t = smoothstep(0.0, 0.55, abs(vDir.y));
          vec3 color = mix(uHorizon, uZenith, vDir.y > 0.0 ? t : t * 0.25);

          if (uStars > 0.0) {
            // Quantise the direction into cells and light a sparse few. Cheap,
            // stable as the head turns, and needs no texture.
            vec3 cell = floor(vDir * 220.0);
            float h = hash(cell);
            float star = smoothstep(0.9975, 1.0, h) * (0.4 + 0.6 * hash(cell + 1.0));
            color += star * uStars;
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    this.mesh = new Mesh(new SphereGeometry(RADIUS, 32, 24), this.material);
    // Drawn first, before the ground and everything else.
    this.mesh.renderOrder = -2;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  setStyle(style: SkyStyle): void {
    this.style = style;
    if (style === "void") {
      this.mesh.visible = false;
      return;
    }
    const spec = STYLES[style];
    this.mesh.visible = true;
    (this.material.uniforms.uHorizon!.value as Color).setHex(spec.horizon);
    (this.material.uniforms.uZenith!.value as Color).setHex(spec.zenith);
    this.material.uniforms.uStars!.value = spec.stars;
  }

  get current(): SkyStyle {
    return this.style;
  }
}
