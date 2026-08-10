import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from "three";
import type { InteractionState } from "../input/state-machine.js";

/**
 * plan.md §7 — the wisps are the system's state indicator.
 *
 * The one rule that is not aesthetic: LOW SALIENCE WHILE THINKING. If wisps
 * orbit conspicuously the user turns to watch them, which changes their facing
 * direction, which corrupts the next "further back". Everything else here can
 * be retuned freely; that constraint cannot.
 */

const COUNT = 512;

type StateStyle = {
  color: number;
  /** Distance from the focus point the swarm settles at. */
  radius: number;
  /** How hard particles are pulled to their target. */
  attraction: number;
  brightness: number;
  /** Upward bias, m/s. */
  rise: number;
  swirl: number;
};

const STYLES: Record<InteractionState, StateStyle> = {
  IDLE: { color: 0x5f7cc0, radius: 2.6, attraction: 0.4, brightness: 0.35, rise: 0.0, swirl: 0.15 },
  LISTENING: { color: 0x5aa8ff, radius: 0.35, attraction: 3.5, brightness: 1.0, rise: 0.35, swirl: 0.9 },
  TRANSCRIBING: { color: 0x6fb4ff, radius: 0.16, attraction: 5.0, brightness: 0.9, rise: 0.05, swirl: 1.4 },
  // Deliberately dim, deliberately far out, deliberately slow.
  THINKING: { color: 0x3f6bb0, radius: 3.4, attraction: 0.5, brightness: 0.22, rise: 0.0, swirl: 0.25 },
  APPLYING: { color: 0x7fd0ff, radius: 0.5, attraction: 4.0, brightness: 0.85, rise: 0.0, swirl: 1.1 },
  NEEDS_INPUT: { color: 0xffb23f, radius: 0.7, attraction: 2.0, brightness: 0.9, rise: 0.1, swirl: 0.5 },
  FAILED: { color: 0xff4d4d, radius: 0.9, attraction: 2.5, brightness: 1.0, rise: -0.2, swirl: 0.3 },
};

export class WispField {
  readonly points: Points;

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly phases: Float32Array;
  private readonly seeds: Float32Array;

  private readonly color = new Color(STYLES.IDLE.color);
  private readonly targetColor = new Color(STYLES.IDLE.color);
  private style: StateStyle = STYLES.IDLE;
  private brightness = STYLES.IDLE.brightness;

  private readonly focus = new Vector3(0, 1.4, -1);
  private readonly target = new Vector3();
  private readonly tmp = new Vector3();

  constructor() {
    this.positions = new Float32Array(COUNT * 3);
    this.velocities = new Float32Array(COUNT * 3);
    this.phases = new Float32Array(COUNT);
    this.seeds = new Float32Array(COUNT);

    const sizes = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.5 + Math.random() * 2.5;
      this.positions[i * 3] = Math.cos(a) * r;
      this.positions[i * 3 + 1] = 0.4 + Math.random() * 2.0;
      this.positions[i * 3 + 2] = Math.sin(a) * r;
      this.phases[i] = a;
      this.seeds[i] = 0.4 + Math.random() * 0.6;
      sizes[i] = 0.008 + Math.random() * 0.018;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("aSize", new Float32BufferAttribute(sizes, 1));
    geometry.setAttribute("aSeed", new Float32BufferAttribute(this.seeds, 1));

    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uColor: { value: this.color },
        uBrightness: { value: this.brightness },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aSeed;
        uniform float uTime;
        varying float vTwinkle;
        void main() {
          vTwinkle = 0.65 + 0.35 * sin(uTime * 1.7 * aSeed + aSeed * 40.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Perspective-correct sizing: a wisp is a world-space object, not a
          // fixed pixel blob, or the swarm reads as flat UI stuck to the face.
          gl_PointSize = aSize * 900.0 / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uBrightness;
        varying float vTwinkle;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          float falloff = pow(1.0 - r * 2.0, 2.2);
          gl_FragColor = vec4(uColor * vTwinkle * uBrightness, falloff * uBrightness);
        }
      `,
    });

    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
  }

  /**
   * @param focus where the swarm converges — the active hand while listening,
   *              the target object while applying, the user otherwise.
   */
  setState(state: InteractionState): void {
    this.style = STYLES[state];
    this.targetColor.setHex(this.style.color);
  }

  setFocus(p: Vector3): void {
    this.focus.copy(p);
  }

  update(dt: number, elapsed: number): void {
    const mat = this.points.material as ShaderMaterial;
    // Ease colour and brightness rather than snapping: a hard cut in the
    // periphery reads as a flash and pulls the eye, which is the one thing the
    // THINKING state must not do.
    this.color.lerp(this.targetColor, Math.min(1, dt * 4));
    this.brightness += (this.style.brightness - this.brightness) * Math.min(1, dt * 3);
    mat.uniforms.uBrightness.value = this.brightness;
    mat.uniforms.uTime.value = elapsed;

    const pos = this.positions;
    const vel = this.velocities;
    const { radius, attraction, rise, swirl } = this.style;
    const damping = Math.exp(-2.2 * dt);

    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      const seed = this.seeds[i];
      const phase = this.phases[i] + elapsed * swirl * seed;

      // Each particle orbits its own point on a shell around the focus, so the
      // swarm tightens and loosens without ever collapsing to a single dot.
      this.target.set(
        this.focus.x + Math.cos(phase) * radius * seed,
        this.focus.y + Math.sin(phase * 0.7) * radius * 0.35 * seed,
        this.focus.z + Math.sin(phase) * radius * seed,
      );

      this.tmp.set(
        this.target.x - pos[i3],
        this.target.y - pos[i3 + 1],
        this.target.z - pos[i3 + 2],
      );

      vel[i3] = vel[i3] * damping + this.tmp.x * attraction * dt;
      vel[i3 + 1] = vel[i3 + 1] * damping + (this.tmp.y * attraction + rise) * dt;
      vel[i3 + 2] = vel[i3 + 2] * damping + this.tmp.z * attraction * dt;

      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
    }

    const attr = this.points.geometry.getAttribute("position");
    (attr.array as Float32Array).set(pos);
    attr.needsUpdate = true;
  }
}
