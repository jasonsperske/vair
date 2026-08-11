import {
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Group,
  type WebGLRenderer,
} from "three";

/**
 * Visible hands: one sphere per tracked joint, sized by the joint's own radius.
 *
 * Rendered here rather than with three's XRHandModelFactory because its only
 * lifelike profile, 'mesh', fetches a glTF from a CDN at runtime. The headset
 * reaches this app over `adb reverse` on localhost and may have no route to the
 * internet at all, so a remote asset would leave a developer with invisible
 * hands and no obvious reason why. The procedural profiles avoid that but come
 * with a fixed white material; drawing the joints directly costs about the same
 * and keeps the palette consistent with the void and the wisps.
 *
 * One InstancedMesh per hand — 25 joints in a single draw call, and we are
 * already reading these joints every frame for pinch detection.
 */

/** WebXR hands expose 25 joints; allocate for the maximum and draw what exists. */
const MAX_JOINTS = 25;

/** Used when a runtime omits jointRadius. Roughly a fingertip. */
const FALLBACK_RADIUS = 0.008;

export class HandModels {
  private readonly meshes: InstancedMesh[] = [];
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3();

  constructor(
    private readonly renderer: WebGLRenderer,
    parent: Object3D,
  ) {
    const geometry = new SphereGeometry(1, 10, 8);

    for (let i = 0; i < 2; i++) {
      const material = new MeshStandardMaterial({
        color: 0x6f8fd0,
        // A little self-lit: the void has one dim hemisphere light, and hands
        // that read as black silhouettes are worse than no hands at all.
        emissive: 0x1b2440,
        roughness: 0.55,
        metalness: 0.05,
      });
      const mesh = new InstancedMesh(geometry, material, MAX_JOINTS);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      parent.add(mesh);
      this.meshes.push(mesh);
    }
  }

  set visible(v: boolean) {
    this.enabled = v;
    if (!v) for (const mesh of this.meshes) mesh.visible = false;
  }

  get visible(): boolean {
    return this.enabled;
  }

  private enabled = true;

  /** Call once per frame, after the XR frame has updated the joint poses. */
  update(): void {
    if (!this.enabled) return;

    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i]!;
      const hand = this.renderer.xr.getHand(i) as unknown as {
        joints?: Record<string, (Group & { jointRadius?: number }) | undefined>;
      };
      const joints = hand.joints;

      if (!joints) {
        mesh.visible = false;
        continue;
      }

      let drawn = 0;
      for (const joint of Object.values(joints)) {
        if (!joint?.visible || drawn >= MAX_JOINTS) continue;

        joint.updateWorldMatrix(true, false);
        joint.matrixWorld.decompose(this.position, this.quaternion, this.scale);
        // The joint's own radius, so knuckles read thicker than fingertips and
        // a child's hand is not drawn at adult scale.
        this.matrix.compose(
          this.position,
          this.quaternion,
          this.scale.setScalar(joint.jointRadius ?? FALLBACK_RADIUS),
        );
        mesh.setMatrixAt(drawn++, this.matrix);
      }

      mesh.count = drawn;
      // Hidden rather than zero-count so a lost hand disappears cleanly instead
      // of leaving its last pose frozen in the air.
      mesh.visible = drawn > 0;
      if (drawn > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
