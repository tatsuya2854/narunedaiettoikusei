// Tripo のプリセットに無い動き（寝る・食べる）を、手元で作る（無料）。
// 「待機（idle）」のクリップを土台に、骨を“体の向きの軸”で回した量を足してキーに焼く。
// 骨ごとのローカル軸はリグ次第でバラバラなので、回転は世界座標（体の前・上・右）で指定し、ローカルに変換する。
import * as THREE from "three";

/**
 * 動きのレシピ。各骨に「どの軸まわりに何度」を時間の関数で与える。
 *   axis: "right"（前後にうなずく・腕を前へ上げる）/ "up"（左右を向く）/ "forward"（首をかしげる）
 *   deg(t): 時間 t（秒）→ 角度
 * period は1ループの長さ。
 */
export const RECIPES = {
  // こっくり寝る：頭がゆっくり前に落ちて、ときどき持ち上がる。背中も少し丸める。呼吸は遅く
  sleep: {
    period: 4.8, speed: 0.45,
    bones: {
      Spine02: [{ axis: "right", deg: (t, p) => -8 - 2 * wave(t, p) }],
      NeckTwist01: [{ axis: "right", deg: (t, p) => -12 - 6 * nod(t, p) }, { axis: "forward", deg: (t, p) => 8 + 2 * wave(t, p, 0.3) }],
      Head: [{ axis: "right", deg: (t, p) => -10 - 10 * nod(t, p) }],
      L_Upperarm: [{ axis: "forward", deg: () => 4 }],
      R_Upperarm: [{ axis: "forward", deg: () => -4 }],
    },
  },
  // もぐもぐ食べる：右手を口元へ運んで戻す × 2、そのあいだ頭が小さくうなずく
  eat: {
    period: 2.4, speed: 1,
    bones: {
      R_Upperarm: [{ axis: "right", deg: (t, p) => 85 * lift(t, p) }, { axis: "up", deg: (t, p) => 50 * lift(t, p) }],
      R_Forearm: [{ axis: "right", deg: (t, p) => 125 * lift(t, p) }],
      Head: [{ axis: "right", deg: (t, p) => -6 * lift(t, p) + 4 * chew(t, p) }],
      Spine02: [{ axis: "right", deg: (t, p) => -4 * lift(t, p) }],
    },
  },
};

const TAU = Math.PI * 2;
const wave = (t, p, ph = 0) => Math.sin(TAU * (t / p + ph));
// こっくり：ゆっくり落ちて（0→1）、ぴくっと戻る
const nod = (t, p) => { const x = (t % p) / p; return x < 0.8 ? smooth(x / 0.8) : 1 - smooth((x - 0.8) / 0.2); };
// 手を口へ：1周期に2回
const lift = (t, p) => { const x = ((t % p) / p) * 2 % 1; return x < 0.35 ? smooth(x / 0.35) : x < 0.65 ? 1 : 1 - smooth((x - 0.65) / 0.35); };
const chew = (t, p) => Math.sin(TAU * 4 * (t / p)) * lift(t, p);
const smooth = (x) => x * x * (3 - 2 * x);

/**
 * @param {import("@gltf-transform/core").Document} doc  リグ済み・idle 入りのドキュメント
 * @param {string} name   作るクリップ名（RECIPES のキー）
 * @param {{ forward:number[], up:number[], baseClip?: string }} o  モデルの正面・上方向（Tripo 生出力は +X / +Y）
 */
export function addProceduralClip(doc, name, { forward = [1, 0, 0], up = [0, 1, 0], baseClip = "idle" } = {}) {
  const recipe = RECIPES[name];
  if (!recipe) throw new Error(`レシピがありません: ${name}`);
  const root = doc.getRoot();
  const base = root.listAnimations().find((a) => a.getName() === baseClip);
  if (!base) throw new Error(`土台のクリップ ${baseClip} がありません`);
  const F = new THREE.Vector3(...forward).normalize(), U = new THREE.Vector3(...up).normalize();
  const R = new THREE.Vector3().crossVectors(F, U).normalize(); // 体の右（正面×上）。right まわり＋で「上を向く／下げた腕が前に上がる」
  const AX = { right: R, up: U, forward: F };

  // 土台クリップの回転・移動を、骨ごとに時間で引ける形にする
  const tracks = new Map();
  for (const ch of base.listChannels()) {
    const n = ch.getTargetNode(), s = ch.getSampler();
    if (!tracks.has(n)) tracks.set(n, {});
    tracks.get(n)[ch.getTargetPath()] = { t: s.getInput().getArray(), v: s.getOutput().getArray(), size: ch.getTargetPath() === "rotation" ? 4 : 3 };
  }
  const baseDur = Math.max(...[...tracks.values()].flatMap((x) => Object.values(x).map((tr) => tr.t[tr.t.length - 1])));
  const skinJoints = new Set(root.listSkins().flatMap((s) => s.listJoints()));
  const rootsOfSkeleton = [...skinJoints].filter((j) => !j.getParentNode() || !skinJoints.has(j.getParentNode()));
  const byName = new Map([...skinJoints].map((j) => [j.getName(), j]));
  for (const b of Object.keys(recipe.bones)) if (!byName.has(b)) throw new Error(`骨 ${b} がありません（別のリグ？）`);

  const fps = 30, frames = Math.round(recipe.period * fps);
  const times = new Float32Array(frames + 1);
  const outRot = new Map(), outPos = new Map();
  const parentWorld = (node) => {
    // スケルトンの外（Root より上）の親のワールド回転（固定）
    const p = node.getParentNode();
    if (!p || skinJoints.has(p)) return null;
    const m = new THREE.Matrix4().fromArray(p.getWorldMatrix());
    return new THREE.Quaternion().setFromRotationMatrix(m);
  };
  for (let f = 0; f <= frames; f++) {
    const t = f / fps; times[f] = t;
    const bt = ((t * recipe.speed) % baseDur);
    const visit = (node, pWorldOld, pWorldNew) => {
      const tr = tracks.get(node) || {};
      const local = tr.rotation ? sampleQ(tr.rotation, bt) : new THREE.Quaternion(...node.getRotation());
      const worldOld = pWorldOld.clone().multiply(local);
      let worldNew = pWorldNew.clone().multiply(local);
      let newLocal = local;
      const spec = recipe.bones[node.getName()];
      if (spec) {
        // 目標 = （足す回転）×（もとの世界での向き）。親が動いた分も打ち消して、ローカルに戻す
        let target = worldOld.clone();
        for (const { axis, deg } of spec) target = new THREE.Quaternion().setFromAxisAngle(AX[axis], (deg(t, recipe.period) * Math.PI) / 180).multiply(target);
        newLocal = pWorldNew.clone().invert().multiply(target);
        worldNew = target;
      }
      if (!outRot.has(node)) outRot.set(node, new Float32Array((frames + 1) * 4));
      newLocal.normalize().toArray(outRot.get(node), f * 4);
      if (tr.translation) {
        if (!outPos.has(node)) outPos.set(node, new Float32Array((frames + 1) * 3));
        const p = sampleV(tr.translation, bt);
        outPos.get(node).set(p, f * 3);
      }
      for (const c of node.listChildren()) if (skinJoints.has(c)) visit(c, worldOld, worldNew);
    };
    for (const r of rootsOfSkeleton) { const pw = parentWorld(r) || new THREE.Quaternion(); visit(r, pw, pw); }
  }

  const buffer = root.listBuffers()[0] || doc.createBuffer();
  const anim = doc.createAnimation(name);
  const input = doc.createAccessor().setType("SCALAR").setArray(times).setBuffer(buffer);
  const add = (node, path, arr, type) => {
    const s = doc.createAnimationSampler().setInput(input).setOutput(doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer)).setInterpolation("LINEAR");
    anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(s));
  };
  for (const [n, arr] of outRot) add(n, "rotation", arr, "VEC4");
  for (const [n, arr] of outPos) add(n, "translation", arr, "VEC3");
  return anim;
}

function sampleQ(tr, t) {
  const { t: T, v } = tr; const i = idx(T, t), j = Math.min(i + 1, T.length - 1);
  const a = new THREE.Quaternion(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]);
  if (i === j) return a;
  const b = new THREE.Quaternion(v[j * 4], v[j * 4 + 1], v[j * 4 + 2], v[j * 4 + 3]);
  return a.slerp(b, (t - T[i]) / (T[j] - T[i] || 1));
}
function sampleV(tr, t) {
  const { t: T, v } = tr; const i = idx(T, t), j = Math.min(i + 1, T.length - 1), k = i === j ? 0 : (t - T[i]) / (T[j] - T[i] || 1);
  return [0, 1, 2].map((c) => v[i * 3 + c] + (v[j * 3 + c] - v[i * 3 + c]) * k);
}
function idx(T, t) { let lo = 0, hi = T.length - 1; while (lo < hi - 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } return T[hi] <= t ? hi : lo; }
