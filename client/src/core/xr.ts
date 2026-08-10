import {
  Clock as ThreeClock,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Object3D,
} from "three";

export type FrameCallback = (ctx: FrameContext) => void;

export type FrameContext = {
  /** DOMHighResTimeStamp, same domain as performance.now(). */
  xrTime: number;
  dt: number;
  frame: XRFrame | null;
  referenceSpace: XRReferenceSpace | null;
};

export type XRRuntime = {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  /** Parented to nothing — world space, local-floor origin, y=0 is the floor. */
  root: Object3D;
  onFrame(cb: FrameCallback): () => void;
  enter(): Promise<void>;
  exit(): void;
  isPresenting(): boolean;
  onSessionChange(cb: (present: boolean) => void): void;
};

export async function isSupported(): Promise<boolean> {
  if (!("xr" in navigator) || !navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

export function createRuntime(): XRRuntime {
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1); // The XR compositor owns resolution; never devicePixelRatio here.
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 1);
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.display = "none";

  const scene = new Scene();
  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 200);
  const root = scene;

  const frameCallbacks = new Set<FrameCallback>();
  const sessionCallbacks = new Set<(present: boolean) => void>();
  const threeClock = new ThreeClock();
  const ctx: FrameContext = { xrTime: 0, dt: 0, frame: null, referenceSpace: null };

  renderer.setAnimationLoop((time, frame) => {
    ctx.xrTime = time;
    ctx.dt = Math.min(threeClock.getDelta(), 0.1); // clamp so a hitch can't teleport anything
    ctx.frame = frame ?? null;
    ctx.referenceSpace = renderer.xr.getReferenceSpace();
    for (const cb of frameCallbacks) cb(ctx);
    renderer.render(scene, camera);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let session: XRSession | null = null;

  async function enter(): Promise<void> {
    if (session || !navigator.xr) return;
    session = await navigator.xr.requestSession("immersive-vr", {
      // local-floor gives us y=0 at the physical floor, which is what
      // handHeightAboveFloor in the measurement bundle means.
      requiredFeatures: ["local-floor"],
      // Hand tracking is optional on purpose: the controller path must always
      // work (plan.md §14). A user who cannot get the app's attention quits.
      optionalFeatures: ["hand-tracking"],
    });
    session.addEventListener("end", () => {
      session = null;
      renderer.domElement.style.display = "none";
      for (const cb of sessionCallbacks) cb(false);
    });
    await renderer.xr.setSession(session);
    renderer.xr.setFoveation(1); // max foveation; we are fill-bound, not detail-bound
    renderer.domElement.style.display = "";
    for (const cb of sessionCallbacks) cb(true);
  }

  function exit(): void {
    void session?.end();
  }

  return {
    renderer,
    scene,
    camera,
    root,
    onFrame(cb) {
      frameCallbacks.add(cb);
      return () => frameCallbacks.delete(cb);
    },
    enter,
    exit,
    isPresenting: () => session !== null,
    onSessionChange(cb) {
      sessionCallbacks.add(cb);
    },
  };
}
