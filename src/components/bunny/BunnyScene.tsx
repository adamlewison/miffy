"use client";

import type * as THREE from "three";
import { Component, Suspense, useEffect, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer } from "@react-three/drei";
import { ProceduralBunny } from "./ProceduralBunny";
import { BUNNY_GLB, GlbBunny } from "./GlbBunny";

/** Keep the bunny framed on any screen shape (portrait phones especially). */
function Framing() {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = size.width / size.height;
    const fov = 32;
    const halfTan = Math.tan((fov * Math.PI) / 360);
    // Fit ~2.4 units tall (ears included) and ~1.45 wide, whichever needs more distance.
    const dist = Math.max(1.22 / halfTan, 0.78 / (halfTan * aspect));
    const cam = camera as THREE.PerspectiveCamera;
    cam.fov = fov;
    // Portrait: sit the bunny a bit lower so captions/controls don't cover the face.
    const y = aspect < 0.8 ? 1.0 : 1.08;
    cam.position.set(0, y + 0.1, dist);
    cam.lookAt(0, y, 0);
    cam.updateProjectionMatrix();
  }, [camera, size]);
  return null;
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

export default function BunnyScene() {
  const hasGlb = useHasGlb();
  const [fps, setFps] = useState(60);
  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) setFps(30);
  }, []);

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: 32, near: 0.1, far: 50, position: [0, 1, 4.5] }}
      style={{ position: "absolute", inset: 0 }}
    >
      <Framing />
      <FrameLimiter fps={fps} />

      {/* Warm studio: soft key from upper-left, fill, and a back rim to catch the fuzz. */}
      <hemisphereLight args={["#fff3e4", "#b48a66", 0.55]} />
      <directionalLight position={[-2.2, 3.2, 3]} intensity={1.6} color="#ffe6c9" />
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

