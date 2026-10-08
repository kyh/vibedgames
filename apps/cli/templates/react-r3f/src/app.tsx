import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Mesh } from "three";

// Replace the cube with your game.
const SpinningCube = () => {
  const ref = useRef<Mesh>(null);
  useFrame((_state, delta) => {
    const mesh = ref.current;
    if (!mesh) {
      return;
    }
    mesh.rotation.x += delta * 0.5;
    mesh.rotation.y += delta;
  });
  return (
    <mesh ref={ref}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#5be3ff" />
    </mesh>
  );
};

export const App = () => (
  <Canvas camera={{ fov: 60, position: [0, 1.5, 4] }} dpr={[1, 2]}>
    <color args={["#0e1020"]} attach="background" />
    <ambientLight intensity={0.4} />
    <directionalLight intensity={2} position={[3, 5, 2]} />
    <SpinningCube />
    <OrbitControls />
  </Canvas>
);
