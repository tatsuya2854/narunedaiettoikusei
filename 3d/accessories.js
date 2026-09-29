// 3D のアクセサリー（どうぶつの森のような、ぽってり丸い小物）。
// 絵ではなく、three.js の基本形（球・ドーナツ・円柱・円すい）を組み合わせてその場で作る。ファイルは増えない。
// 頭の大きさ（head）に合わせて大きさを決め、頭の骨に付けるので、動いても頭にくっついてくる。
//
// head: { c: 頭の中心, r: 半径 {x,y,z}, eyes: {L, R}（顔シートから求めた目の位置。無ければ推定）}
// 座標：モデルの世界（正面 +Z・上 +Y・キャラの左 +X）
import * as T from "./vendor/three-char.js";

const mat = (color, o = {}) => new T.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...o });
const INK = 0x2a2323;

function place(obj, pos, rot = [0, 0, 0], scale = 1) {
  obj.position.copy(pos); obj.rotation.set(...rot); obj.scale.setScalar(scale);
  return obj;
}

export const ACCESSORIES = {
  // リボン：頭の左上（見る人の右上）に、ふっくらした蝶結び
  ribbon(h) {
    const g = new T.Group(), m = mat(0xff5e86), s = h.r.y * 0.36;
    const loop = (sign) => {
      const b = new T.Mesh(new T.SphereGeometry(1, 20, 14), m);
      b.scale.set(0.9, 0.62, 0.42); b.position.set(sign * 0.72, 0, 0); b.rotation.z = sign * -0.25;
      return b;
    };
    g.add(loop(1), loop(-1));
    const knot = new T.Mesh(new T.SphereGeometry(0.34, 16, 12), mat(0xe8456f)); g.add(knot);
    // 耳の内側・おでこの上の斜めに、しっかり見える大きさで
    return place(g, h.c.clone().add(new T.Vector3(-h.r.x * 0.42, h.r.y * 0.92, h.r.z * 0.45)), [-0.3, 0, 0.35], s * 1.5);
  },
  // おはな：頭の右上（見る人の左上）に、白い花びらと黄色い真ん中
  flower(h) {
    const g = new T.Group(), s = h.r.y * 0.36, petal = mat(0xffffff), center = mat(0xffc93c);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2, p = new T.Mesh(new T.SphereGeometry(0.5, 16, 12), petal);
      p.scale.set(1, 1, 0.45); p.position.set(Math.cos(a) * 0.72, Math.sin(a) * 0.72, 0); g.add(p);
    }
    const c = new T.Mesh(new T.SphereGeometry(0.46, 16, 12), center); c.scale.set(1, 1, 0.6); c.position.z = 0.15; g.add(c);
    return place(g, h.c.clone().add(new T.Vector3(-h.r.x * 0.5, h.r.y * 0.82, h.r.z * 0.6)), [-0.55, -0.35, 0.25], s * 1.4);
  },
  // ハチマキ：おでこの高さで、頭の形にぴったり沿って一周。うしろで結び目がぴょこっと出る
  band(h) {
    const g = new T.Group(), m = mat(0xf0334b);
    const y = h.c.y + h.r.y * 0.3, off = h.r.y * 0.035;
    const pts = h.ring ? h.ring(y).map((p) => p.clone().sub(new T.Vector3(h.c.x, y, h.c.z)).multiplyScalar(1).setLength(p.clone().sub(new T.Vector3(h.c.x, y, h.c.z)).length() + off).add(new T.Vector3(h.c.x, y, h.c.z)))
      : Array.from({ length: 48 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return new T.Vector3(h.c.x + Math.sin(a) * h.r.x, y, h.c.z + Math.cos(a) * h.r.z); });
    const tube = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts, true), 96, h.r.y * 0.07, 10, true), m);
    tube.scale.set(1, 1.8, 1);   // 布らしく縦に少し広く
    tube.position.y = -y * 0.8;  // scale の分を戻す（y 方向に伸ばしても高さはそのまま）
    g.add(tube);
    // 正面の白い丸（ハチマキの日の丸）
    const front = pts.reduce((a, b) => (b.z > a.z ? b : a));
    const mark = new T.Mesh(new T.CircleGeometry(h.r.y * 0.09, 24), mat(0xffffff)); mark.position.copy(front).add(new T.Vector3(0, 0, h.r.y * 0.075)); g.add(mark);
    // うしろの結び目
    const back = pts.reduce((a, b) => (b.z < a.z ? b : a));
    for (const sign of [1, -1]) {
      const t = new T.Mesh(new T.CapsuleGeometry(h.r.y * 0.05, h.r.y * 0.28, 4, 10), m);
      t.position.copy(back).add(new T.Vector3(sign * h.r.x * 0.12, -h.r.y * 0.14, -h.r.y * 0.06)); t.rotation.z = sign * 0.6; g.add(t);
    }
    return g;
  },
  // サングラス：左右のレンズを目の位置の顔の表面に沿わせ、顔の丸みに合わせて少し外へ向ける（目は閉じたまま、上からかけるだけ）
  shades(h) {
    const g = new T.Group(), frame = mat(INK, { roughness: 0.35 }), lens = mat(0x1d2b45, { roughness: 0.15, metalness: 0.2 });
    const eyeL = h.eyes?.L || h.c.clone().add(new T.Vector3(h.r.x * 0.38, 0, h.r.z * 0.9));
    const eyeR = h.eyes?.R || h.c.clone().add(new T.Vector3(-h.r.x * 0.38, 0, h.r.z * 0.9));
    const half = eyeL.distanceTo(eyeR) / 2, rr = half * 0.62;
    const lensAt = (eye) => {
      // 顔の表面の向き（頭の中心から目へ。上下は弱める）
      const n = eye.clone().sub(h.c); n.y *= 0.3; n.normalize();
      const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), n);
      const l = new T.Mesh(new T.CylinderGeometry(rr, rr, rr * 0.22, 28), lens);
      l.quaternion.copy(q).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI / 2));
      l.position.copy(eye).add(n.clone().multiplyScalar(rr * 0.3));
      const f = new T.Mesh(new T.TorusGeometry(rr, rr * 0.12, 8, 28), frame);
      f.quaternion.copy(q); f.position.copy(eye).add(n.clone().multiplyScalar(rr * 0.42));
      g.add(l, f);
      return eye.clone().add(n.clone().multiplyScalar(rr * 0.42));
    };
    const a = lensAt(eyeL), b = lensAt(eyeR);
    // 鼻の上のブリッジ（両レンズの内側の縁をつなぐ）
    const inner = (p, other) => p.clone().add(other.clone().sub(p).setLength(rr));
    const p0 = inner(a, b), p1 = inner(b, a);
    const bridge = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3([p0, p0.clone().lerp(p1, 0.5).add(new T.Vector3(0, rr * 0.2, rr * 0.15)), p1]), 12, rr * 0.09, 6), frame);
    g.add(bridge);
    return g;
  },
  // ヘッドホン：頭の上を通るバンドと、耳のあたりの丸いカップ
  phones(h) {
    const g = new T.Group(), band = mat(0x3a3a48), cup = mat(0x4fc3f7), pad = mat(0xf2f2f2);
    const arc = new T.Mesh(new T.TorusGeometry(1, 0.07, 10, 40, Math.PI), band);
    arc.scale.set(h.r.x * 1.08, h.r.y * 1.07, 1); g.add(arc);
    for (const sign of [1, -1]) {
      const c = new T.Mesh(new T.CylinderGeometry(h.r.y * 0.3, h.r.y * 0.3, h.r.x * 0.2, 24), cup);
      c.rotation.z = Math.PI / 2; c.position.set(sign * h.r.x * 1.02, 0, 0); g.add(c);
      const p = new T.Mesh(new T.TorusGeometry(h.r.y * 0.22, h.r.y * 0.07, 8, 24), pad);
      p.rotation.y = Math.PI / 2; p.position.set(sign * h.r.x * 0.93, 0, 0); g.add(p);
    }
    return place(g, h.c.clone().add(new T.Vector3(0, -h.r.y * 0.05, -h.r.z * 0.05)), [0, 0, 0]);
  },
  // クラウン：頭のてっぺんに、ちょこんと小さな金の王冠
  crown(h) {
    const g = new T.Group(), gold = mat(0xffc629, { roughness: 0.3, metalness: 0.35 }), gem = mat(0xff4d6d, { roughness: 0.2 });
    const base = new T.Mesh(new T.CylinderGeometry(1, 1, 0.55, 28, 1, true), gold); base.material.side = T.DoubleSide; g.add(base);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2, spike = new T.Mesh(new T.ConeGeometry(0.28, 0.6, 12), gold);
      spike.position.set(Math.sin(a) * 0.9, 0.55, Math.cos(a) * 0.9); g.add(spike);
      const ball = new T.Mesh(new T.SphereGeometry(0.12, 10, 8), gold); ball.position.set(Math.sin(a) * 0.9, 0.9, Math.cos(a) * 0.9); g.add(ball);
    }
    const jewel = new T.Mesh(new T.SphereGeometry(0.2, 14, 10), gem); jewel.position.set(0, 0, 1.0); g.add(jewel);
    return place(g, h.c.clone().add(new T.Vector3(h.r.x * 0.05, h.r.y * 1.02, h.r.z * 0.05)), [0.05, 0, -0.1], h.r.y * 0.55);
  },
};

export function hasAccessory(id) { return !!ACCESSORIES[id]; }

/**
 * アクセを作って、頭の骨に付ける。付けた Object3D を返す（外すときは remove + dispose）
 * head（大きさ・目の位置）は読み込み時の基本姿勢で測ってあるので、骨も「そのときの位置」（head.boneRest）を基準にする。
 * 今の骨の位置を使うと、動いている最中に付けたときに頭の後ろなどへずれる。
 */
export function attachAccessory(id, head, headBone) {
  const make = ACCESSORIES[id];
  if (!make || !headBone || !head.boneRest) return null;
  const obj = make(head);
  obj.name = `acc:${id}`;
  // 基本姿勢での置き場所 → 頭の骨のローカルへ（頭と一緒に動く）
  const inv = new T.Matrix4().copy(head.boneRest).invert();
  obj.updateMatrix();
  obj.applyMatrix4(inv);
  headBone.add(obj);
  obj.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } });
  return obj;
}

export function disposeObject(obj) {
  if (!obj) return;
  obj.parent?.remove(obj);
  obj.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
}
