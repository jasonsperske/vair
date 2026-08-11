import { HemisphereLight, type Object3D } from "three";
import type { Environment as EnvironmentState } from "@vair/shared";
import { ambientUnits } from "../scene/lights.js";
import { Ground } from "./ground.js";

/**
 * Everything the scene document's `environment` block controls: the ground and
 * the ambient fill.
 *
 * Grouped so `SceneView` applies one `environment_set` to one object rather
 * than fanning out to several, and so both stay driven by the folded document
 * — which is what makes a reloaded scene come back with its floor and its
 * brightness intact.
 */
export class SceneEnvironment {
  private readonly ground: Ground;
  private readonly ambient: HemisphereLight;

  constructor(parent: Object3D) {
    this.ground = new Ground(parent);
    // Sky/ground tinted rather than flat white: in a void, a flat fill makes
    // every object look pasted on, while a slight vertical gradient gives
    // shapes enough form to read. The void stays a void — no environment map,
    // no sky (plan.md §2).
    this.ambient = new HemisphereLight(0x4a5f9e, 0x080a12, 0);
    parent.add(this.ambient);
  }

  apply(state: EnvironmentState): void {
    this.ground.setStyle(state.groundMaterial);
    this.ground.setVisible(state.groundVisible);
    this.ambient.intensity = ambientUnits(state.ambientIntensity);
  }
}
