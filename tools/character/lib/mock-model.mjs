// Mock プロバイダ用の「なるねぇっぽい」三頭身モデルを手続き的に作って GLB にする。
// 本物の Tripo 出力の代わりに、パイプライン（生成→確認→リグ→アニメ→最適化→ゲーム登録）を
// クレジットを使わずに最後まで通すためのもの。見た目の再現は目的にしていない。
import "./node-gltf-env.mjs";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

const C = { skin: 0xf6cfb2, hood: 0xf7efdc, shirt: 0xf7c52b, shorts: 0x9a9a9a, shoe: 0xffffff, hair: 0x6b3d17, line: 0x222222, cheek: 0xf4a3a8 };
const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0 });

// 骨の名前は Mixamo 系に合わせる（ゲーム側は名前に依存しない。アクセの取り付け点だけ character.json で名前指定）
function makeSkeleton() {
  const b = {};
  const add = (name, parent, x, y, z) => { const o = new THREE.Bone(); o.name = name; o.position.set(x, y, z); if (parent) b[parent].add(o); b[name] = o; };
  add("Hips", null, 0, 0.42, 0);
  add("Spine", "Hips", 0, 0.08, 0);
  add("Neck", "Spine", 0, 0.16, 0);
  add("Head", "Neck", 0, 0.04, 0);
  add("LeftArm", "Spine", 0.13, 0.13, 0); add("LeftForeArm", "LeftArm", 0.1, -0.03, 0); add("LeftHand", "LeftForeArm", 0.07, -0.02, 0);
  add("RightArm", "Spine", -0.13, 0.13, 0); add("RightForeArm", "RightArm", -0.1, -0.03, 0); add("RightHand", "RightForeArm", -0.07, -0.02, 0);
  add("LeftUpLeg", "Hips", 0.07, -0.05, 0); add("LeftLeg", "LeftUpLeg", 0, -0.17, 0); add("LeftFoot", "LeftLeg", 0, -0.15, 0.02);
  add("RightUpLeg", "Hips", -0.07, -0.05, 0); add("RightLeg", "RightUpLeg", 0, -0.17, 0); add("RightFoot", "RightLeg", 0, -0.15, 0.02);
  return b;
}

// 形を1つの骨に剛体で縛った SkinnedMesh にする（骨ワールド座標で置く）
function part(geo, color, bone, bones, skeleton, worldPos) {
  geo.translate(worldPos.x, worldPos.y, worldPos.z);
  const n = geo.attributes.position.count, idx = bones.indexOf(bone);
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(n).fill(0).flatMap(() => [idx, 0, 0, 0]), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
  const m = new THREE.SkinnedMesh(geo, mat(color));
  m.name = `${bone.name}_part`;
  m.bind(skeleton);
  return m;
}

function buildCharacter({ rigged }) {
  const root = new THREE.Group(); root.name = "Character";
  const b = makeSkeleton(); root.add(b.Hips);
  root.updateMatrixWorld(true);
  const bones = Object.values(b), skeleton = new THREE.Skeleton(bones);
  const wp = (name, dx = 0, dy = 0, dz = 0) => new THREE.Vector3().setFromMatrixPosition(b[name].matrixWorld).add(new THREE.Vector3(dx, dy, dz));
  const parts = [
    [new THREE.SphereGeometry(0.25, 32, 24).scale(1.08, 0.92, 0.95), C.skin, "Head", wp("Head", 0, 0.2, 0)],
    [new THREE.SphereGeometry(0.265, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(1.08, 0.95, 0.97), C.hood, "Head", wp("Head", 0, 0.21, 0)],
    [new THREE.ConeGeometry(0.06, 0.1, 16), C.hood, "Head", wp("Head", 0.17, 0.43, 0)],
    [new THREE.ConeGeometry(0.06, 0.1, 16), C.hood, "Head", wp("Head", -0.17, 0.43, 0)],
    [new THREE.CapsuleGeometry(0.05, 0.16, 6, 12).rotateZ(-0.9), C.hair, "Head", wp("Head", 0.24, 0.36, -0.1)],
    [new THREE.SphereGeometry(0.035, 12, 8).scale(1.3, 0.8, 0.4), C.cheek, "Head", wp("Head", 0.12, 0.13, 0.22)],
    [new THREE.SphereGeometry(0.035, 12, 8).scale(1.3, 0.8, 0.4), C.cheek, "Head", wp("Head", -0.12, 0.13, 0.22)],
    [new THREE.TorusGeometry(0.035, 0.008, 6, 16, Math.PI), C.line, "Head", wp("Head", 0.07, 0.2, 0.23)],
    [new THREE.TorusGeometry(0.035, 0.008, 6, 16, Math.PI), C.line, "Head", wp("Head", -0.07, 0.2, 0.23)],
    [new THREE.CylinderGeometry(0.12, 0.14, 0.2, 20), C.shirt, "Spine", wp("Spine", 0, 0.08, 0)],
    [new THREE.CylinderGeometry(0.135, 0.13, 0.09, 20), C.shorts, "Hips", wp("Hips", 0, -0.02, 0)],
    [new THREE.CapsuleGeometry(0.035, 0.08, 4, 10).rotateZ(Math.PI / 2 + 0.3), C.shirt, "LeftArm", wp("LeftArm", 0.05, -0.015, 0)],
    [new THREE.CapsuleGeometry(0.035, 0.08, 4, 10).rotateZ(-Math.PI / 2 - 0.3), C.shirt, "RightArm", wp("RightArm", -0.05, -0.015, 0)],
    [new THREE.CapsuleGeometry(0.03, 0.06, 4, 10).rotateZ(Math.PI / 2 + 0.3), C.skin, "LeftForeArm", wp("LeftForeArm", 0.035, -0.01, 0)],
    [new THREE.CapsuleGeometry(0.03, 0.06, 4, 10).rotateZ(-Math.PI / 2 - 0.3), C.skin, "RightForeArm", wp("RightForeArm", -0.035, -0.01, 0)],
    [new THREE.SphereGeometry(0.04, 12, 10), C.skin, "LeftHand", wp("LeftHand")],
    [new THREE.SphereGeometry(0.04, 12, 10), C.skin, "RightHand", wp("RightHand")],
    [new THREE.CapsuleGeometry(0.04, 0.1, 4, 10), C.skin, "LeftUpLeg", wp("LeftUpLeg", 0, -0.09, 0)],
    [new THREE.CapsuleGeometry(0.04, 0.1, 4, 10), C.skin, "RightUpLeg", wp("RightUpLeg", 0, -0.09, 0)],
    [new THREE.CapsuleGeometry(0.038, 0.08, 4, 10), C.skin, "LeftLeg", wp("LeftLeg", 0, -0.08, 0)],
    [new THREE.CapsuleGeometry(0.038, 0.08, 4, 10), C.skin, "RightLeg", wp("RightLeg", 0, -0.08, 0)],
    [new THREE.SphereGeometry(0.06, 16, 10).scale(1, 0.7, 1.4), C.shoe, "LeftFoot", wp("LeftFoot", 0, -0.01, 0.02)],
    [new THREE.SphereGeometry(0.06, 16, 10).scale(1, 0.7, 1.4), C.shoe, "RightFoot", wp("RightFoot", 0, -0.01, 0.02)],
  ];
  if (!rigged) {
    // リグ前：骨なしの静的メッシュ（Tripo の image_to_model 出力に相当）
    const g = new THREE.Group(); g.name = "Character";
    for (const [geo, color, , p] of parts) { geo.translate(p.x, p.y, p.z); g.add(new THREE.Mesh(geo, mat(color))); }
    return { root: g, bones: null };
  }
  for (const [geo, color, bone, p] of parts) root.add(part(geo, color, b[bone], bones, skeleton, p));
  return { root, bones: b };
}

// --- アニメーション（骨の回転を時間の式で書き、キーに落とす） ---
const E = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
function track(boneName, times, fn) {
  const v = []; for (const t of times) v.push(...fn(t).toArray());
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, v);
}
function ptrack(boneName, times, base, fn) {
  const v = []; for (const t of times) { const d = fn(t); v.push(base.x + d[0], base.y + d[1], base.z + d[2]); }
  return new THREE.VectorKeyframeTrack(`${boneName}.position`, times, v);
}
const steps = (dur, n = 24) => Array.from({ length: n + 1 }, (_, i) => (dur * i) / n);
const TAU = Math.PI * 2;

export const MOCK_CLIPS = {
  idle(b) {
    const d = 2.4, t = steps(d), w = (x) => Math.sin((TAU * x) / d);
    return new THREE.AnimationClip("idle", d, [
      ptrack("Hips", t, b.Hips.position, (x) => [0, 0.006 * w(x), 0]),
      track("Spine", t, (x) => E(0.03 * w(x), 0, 0)),
      track("Head", t, (x) => E(0, 0, 0.05 * Math.sin((TAU * x) / d + 1))),
      track("LeftArm", t, (x) => E(0, 0, -0.1 - 0.05 * w(x))),
      track("RightArm", t, (x) => E(0, 0, 0.1 + 0.05 * w(x))),
    ]);
  },
  walk(b) {
    const d = 0.9, t = steps(d), w = (x) => Math.sin((TAU * x) / d);
    return new THREE.AnimationClip("walk", d, [
      ptrack("Hips", t, b.Hips.position, (x) => [0, 0.012 * Math.abs(Math.cos((TAU * x) / d)), 0]),
      track("LeftUpLeg", t, (x) => E(0.5 * w(x), 0, 0)),
      track("RightUpLeg", t, (x) => E(-0.5 * w(x), 0, 0)),
      track("LeftLeg", t, (x) => E(Math.max(0, -0.6 * w(x)), 0, 0)),
      track("RightLeg", t, (x) => E(Math.max(0, 0.6 * w(x)), 0, 0)),
      track("LeftArm", t, (x) => E(-0.5 * w(x), 0, -1.0)),
      track("RightArm", t, (x) => E(0.5 * w(x), 0, 1.0)),
      track("Head", t, (x) => E(0, 0, 0.04 * w(x))),
    ]);
  },
  jump(b) {
    const d = 1.1, t = steps(d, 33);
    const h = (x) => { const p = x / d; return p < 0.25 ? -0.04 * Math.sin((p / 0.25) * Math.PI) : p < 0.8 ? 0.22 * Math.sin(((p - 0.25) / 0.55) * Math.PI) : -0.03 * Math.sin(((p - 0.8) / 0.2) * Math.PI); };
    const up = (x) => { const p = x / d; return p > 0.25 && p < 0.8 ? Math.sin(((p - 0.25) / 0.55) * Math.PI) : 0; };
    const crouch = (x) => Math.max(0, -h(x)) * 12;
    return new THREE.AnimationClip("jump", d, [
      ptrack("Hips", t, b.Hips.position, (x) => [0, h(x), 0]),
      track("LeftArm", t, (x) => E(0, 0, -1.0 + 1.8 * up(x))),
      track("RightArm", t, (x) => E(0, 0, 1.0 - 1.8 * up(x))),
      track("LeftUpLeg", t, (x) => E(-0.6 * crouch(x), 0, 0)),
      track("RightUpLeg", t, (x) => E(-0.6 * crouch(x), 0, 0)),
      track("LeftLeg", t, (x) => E(1.0 * crouch(x) + 0.4 * up(x), 0, 0)),
      track("RightLeg", t, (x) => E(1.0 * crouch(x) + 0.4 * up(x), 0, 0)),
    ]);
  },
  happy(b) {
    const d = 1.6, t = steps(d, 32), w = (x) => Math.sin((TAU * 2 * x) / d);
    return new THREE.AnimationClip("happy", d, [
      ptrack("Hips", t, b.Hips.position, (x) => [0, 0.05 * Math.abs(Math.sin((TAU * x) / d)), 0]),
      track("LeftArm", t, (x) => E(0, 0, 1.0 + 0.3 * w(x))),
      track("RightArm", t, (x) => E(0, 0, -1.0 - 0.3 * w(x))),
      track("LeftForeArm", t, (x) => E(0, 0, 0.4 * w(x))),
      track("RightForeArm", t, (x) => E(0, 0, -0.4 * w(x))),
      track("Head", t, (x) => E(0, 0, 0.12 * w(x))),
      track("Spine", t, (x) => E(0, 0.1 * w(x), 0)),
    ]);
  },
};

export async function buildMockGlb({ rigged = false, clips = [] } = {}) {
  const { root, bones } = buildCharacter({ rigged });
  const scene = new THREE.Scene(); scene.add(root);
  const animations = rigged ? clips.map((n) => { const f = MOCK_CLIPS[n]; if (!f) throw new Error(`mock: unknown clip ${n}`); return f(bones); }) : [];
  const out = await new GLTFExporter().parseAsync(scene, { binary: true, animations });
  return Buffer.from(out);
}
