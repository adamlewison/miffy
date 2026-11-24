"use client";

import * as THREE from "three";
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer } from "@react-three/drei";
import { ProceduralBunny } from "./ProceduralBunny";
import { BUNNY_GLB, GlbBunny } from "./GlbBunny";
import { FUR_LAYER } from "./fur";

/**
 * Camera framing. The call uses a FaceTime-style shot: her head, shoulders and
 * upper tummy, with a little headroom for her ears and hops, and a gentle
 * handheld drift. The full-body views stay available for /preview.
 */
type Shot = { pos: THREE.Vector3; look: THREE.Vector3 };

function useShot(): Shot {
  const { size } = useThree();
  return useMemo(() => {
    const aspect = size.width / size.height;
    const fov = 32;
    const halfTan = Math.tan((fov * Math.PI) / 360);
    const view = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view");
    const shot = (pos: [number, number, number], look: [number, number, number]) => ({ pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look) });
    if (view === "face") return shot([0, 1.25, 1.55], [0, 1.18, 0]);
    if (view === "paw") return shot([0.75, 0.75, 1.35], [0.2, 0.55, 0.15]);
    if (view === "full" || view === "side") {
      // Whole toy: fit ~2.4 units tall (ears included) and ~1.45 wide.
      const dist = Math.max(1.22 / halfTan, 0.78 / (halfTan * aspect));
      const y = aspect < 0.8 ? 1.0 : 1.08;
      if (view === "side") return shot([dist * 0.75, y + 0.15, dist * 0.66], [0, y - 0.05, 0]);
      return shot([0, y + 0.1, dist], [0, y, 0]);
    }
    // FaceTime: from mid-tummy (~0.4) to a bit above her ear tops (~1.55). On wide
    // screens fit her shoulders-and-ears width instead, so she never looks tiny.
    // Phones (portrait) fit her head and ears across; tall screens then show a little more of her.
    const halfVis = aspect < 1 ? Math.max(0.72, 0.42 / aspect) : Math.max(0.6, 0.72 / aspect);
    const dist = halfVis / halfTan;
    const bottom = 0.32 - Math.min(0.14, (halfVis - 0.6) * 0.45);
    const cy = bottom + halfVis;
    // The phone sits just below her eye line, looking very slightly up at her.
    return shot([0, cy - 0.04, dist], [0, cy, 0]);
  }, [size]);
}

function Framing({ shot }: { shot: Shot }) {
  const { camera } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    cam.layers.enable(FUR_LAYER); // fur shells (excluded from the contact-shadow pass)
    cam.fov = 32;
    cam.position.copy(shot.pos);
    cam.lookAt(shot.look);
    cam.updateProjectionMatrix();
  }, [camera, shot]);
  // A phone propped on the bed is never perfectly still: a slow, tiny drift.
  const look = useRef(new THREE.Vector3());
  useFrame(({ clock }) => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("view")) return;
    const t = clock.elapsedTime;
    camera.position.set(
      shot.pos.x + 0.008 * Math.sin(t * 0.31) + 0.003 * Math.sin(t * 1.13),
      shot.pos.y + 0.006 * Math.sin(t * 0.27 + 1) + 0.002 * Math.sin(t * 0.97),
      shot.pos.z + 0.01 * Math.sin(t * 0.19),
    );
    look.current.copy(shot.look);
    look.current.x += 0.004 * Math.sin(t * 0.23 + 2);
    camera.lookAt(look.current);
  });
  return null;
}

/** Her bedroom behind her, soft and out of focus like a phone camera's portrait mode. */
function Room({ shot }: { shot: Shot }) {
  const { size } = useThree();
  const aspect = size.width / size.height;
  const url = aspect < 1 ? "/room-portrait.jpg" : "/room-landscape.jpg";
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let alive = true;
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      if (alive) setTex(t);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  // A plane far behind her that fills the view (object-fit: cover), with margin for the drift.
  const z = -2.6;
  const dist = shot.pos.z - z;
  const viewH = 2 * Math.tan((32 * Math.PI) / 360) * dist * 1.1;
  const viewW = viewH * aspect;
  const imgAspect = tex ? (tex.image as HTMLImageElement).width / (tex.image as HTMLImageElement).height : 1;
  const [w, h] = viewW / viewH > imgAspect ? [viewW, viewW / imgAspect] : [viewH * imgAspect, viewH];
  if (!tex) return null;
  return (
    <mesh position={[0, shot.look.y + 0.05, z]} renderOrder={-10}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={tex} toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

/** Cap the frame rate (30fps on phones) to save battery and avoid lag. */
function FrameLimiter({ fps }: { fps: number }) {
  const { invalidate } = useThree();
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last >= 1000 / fps - 2) {
        last = t;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps, invalidate]);
  return null;
}

class GlbBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("[bunny.glb] failed to load, using placeholder bunny", err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function useHasGlb() {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(BUNNY_GLB, { method: "HEAD" })
      .then((r) => setHas(r.ok && !(r.headers.get("content-type") ?? "").includes("text/html")))
      .catch(() => setHas(false));
  }, []);
  return has;
}

function Scene() {
  const shot = useShot();
  const room = typeof window !== "undefined" && !new URLSearchParams(window.location.search).has("view");
  return (
    <>
      <Framing shot={shot} />
      {room && <Room shot={shot} />}
    </>
  );
}

export default function BunnyScene() {
  const hasGlb = useHasGlb();
  const [fps, setFps] = useState(60);
  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) setFps(30);
  }, []);

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, fps < 60 ? 1.75 : 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: 32, near: 0.1, far: 50, position: [0, 1, 4.5] }}
      style={{ position: "absolute", inset: 0 }}
    >
      <Scene />
      <FrameLimiter fps={fps} />

      {/* Warm studio: soft key from upper-left, fill, and a back rim to catch the fuzz. */}
      <hemisphereLight args={["#f7f2ec", "#9c8b7b", 0.6]} />
      <directionalLight position={[-2.2, 3.2, 3]} intensity={1.55} color="#fff1e2" />
      <directionalLight position={[2.5, 1.5, 2]} intensity={0.45} color="#ffeedd" />
      <directionalLight position={[0, 2.5, -3]} intensity={1.1} color="#fff6ea" />
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={1.4} color="#fff1e0" position={[-3, 3, 3]} scale={[4, 3, 1]} />
        <Lightformer form="rect" intensity={0.6} color="#ffd9b8" position={[3, 1, 2]} scale={[3, 3, 1]} />
        <Lightformer form="ring" intensity={0.8} color="#ffffff" position={[0, 4, -3]} scale={2} />
      </Environment>

      <Suspense fallback={null}>
        {hasGlb === true ? (
          <GlbBoundary fallback={<ProceduralBunny />}>
            <GlbBunny />
          </GlbBoundary>
        ) : hasGlb === false ? (
          <ProceduralBunny />
        ) : null}
      </Suspense>

      <ContactShadows position={[0, 0.001, 0]} opacity={0.35} scale={3} blur={2.6} far={1.2} resolution={256} color="#6b4a32" frames={Infinity} />
    </Canvas>
  );
}

