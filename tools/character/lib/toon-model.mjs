// なるねぇを「どうぶつの森」風のなめらかな形で作る（無料・手元）。
// AI（Tripo）のメッシュは表面がデコボコで、顔や体の比率も崩れるので、元絵の比率どおりに単純な形から組み立てる。
//
//   ・丸い大きな頭（顔の前は少し平ら）＋ 耳付きの帽子（顔の穴のまわりにふちどり）＋ 帽子の点3つ
//   ・ポニーテール（右上に向かって太→細）
//   ・Tシャツ（ずんどう・半袖）、短パン、短くて太い脚、丸い靴、短い腕と丸い手
//   ・顔は描かない（ゲームが2Dと同じ顔パーツで描く「顔シート」を付ける）
//   ・骨は動きのレシピ（procedural-clips.mjs）と同じ名前。重みはなめらかに分ける
//
// 座標：正面 +Z・上 +Y・キャラの左 +X。背丈はおよそ 1.0
import "./node-gltf-env.mjs";
import * as THREE from "three";
import { mergeVertices, mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// 色（元絵から拾った色。少し明るく・澄ませる）
export const PALETTE = {
  skin: 0xf8d2b8, hood: 0xf7f0de, hoodShade: 0xefe4cc, dot: 0x3a2f2c, hair: 0x7a4a22,
  shirt: 0xf7c52e, shorts: 0x9c9c9e, shoe: 0xffffff, sock: 0xffffff, cheek: 0xf6a7a9,
};

// 比率（元絵：頭の幅 ≒ 体の幅の 1.0 倍、頭の高さ ≒ 背丈の 0.52）
const H = 1.0;
const HEAD_R = 0.25, HEAD_Y = 0.70;             // 頭の中心
const HEAD_SCALE = new THREE.Vector3(1.2, 0.94, 0.98);
const NECK_Y = 0.46, CHEST_Y = 0.38, HIP_Y = 0.22;

function bones() {
  const b = {};
  const add = (name, parent, x, y, z) => { const o = new THREE.Bone(); o.name = name; o.position.set(x, y, z); if (parent) b[parent].add(o); b[name] = o; };
  add("Root", null, 0, 0, 0);
  add("Hip", "Root", 0, HIP_Y, 0);
  add("Waist", "Hip", 0, 0.03, 0);
  add("Spine02", "Waist", 0, 0.12, 0);
  add("NeckTwist01", "Spine02", 0, NECK_Y - HIP_Y - 0.15, 0);
  add("Head", "NeckTwist01", 0, 0.02, 0);
  // 腕：肩から少し下向き（元絵の A ポーズ）
  const sh = [0.13, CHEST_Y + 0.02 - HIP_Y - 0.15], ua = 0.085, fa = 0.07, down = -0.55;
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    add(`${side}_Clavicle`, "Spine02", s * 0.02, sh[1], 0);
    add(`${side}_Upperarm`, `${side}_Clavicle`, s * (sh[0] - 0.02), 0, 0);
    add(`${side}_Forearm`, `${side}_Upperarm`, s * Math.cos(down) * ua, Math.sin(down) * ua, 0);
    add(`${side}_Hand`, `${side}_Forearm`, s * Math.cos(down) * fa, Math.sin(down) * fa, 0);
  }
  add("Pelvis", "Hip", 0, 0, 0);
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    add(`${side}_Thigh`, "Pelvis", s * 0.065, -0.03, 0);
    add(`${side}_Calf`, `${side}_Thigh`, 0, -0.08, 0);
    add(`${side}_Foot`, `${side}_Calf`, 0, -0.08, 0.01);
  }
  return b;
}

const mat = (name, color) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }); m.name = name; return m; };

/** 形（ジオメトリ）を骨の重み付きで作る。weights(p) → [[骨名, 重み], ...] */
function skinned(geo, weights, boneIndex) {
  geo = geo.index ? geo.toNonIndexed() : geo.clone();
  // テクスチャを使わないので UV・法線は捨て、位置だけで頂点を溶接する（球の継ぎ目で陰影が割れないように）
  for (const k of Object.keys(geo.attributes)) if (k !== "position") geo.deleteAttribute(k);
  geo = mergeVertices(geo, 1e-5);
  geo.computeVertexNormals();
  const n = geo.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(geo.attributes.position, i);
    const w = weights(p).filter(([, v]) => v > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = w.reduce((s, [, v]) => s + v, 0) || 1;
    w.forEach(([name, v], k) => { si[i * 4 + k] = boneIndex[name]; sw[i * 4 + k] = v / sum; });
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const blend = (a, b, t) => [[a, 1 - t], [b, t]];

// 太さが変わるチューブ（ポニーテール・腕・脚）
function taperTube(points, radius, radial = 20, seg = 40, cap = true) {
  const curve = new THREE.CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(seg, false);
  const pos = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, c = curve.getPointAt(t), r = radius(t), N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(c.x + r * (Math.cos(a) * N.x + Math.sin(a) * B.x), c.y + r * (Math.cos(a) * N.y + Math.sin(a) * B.y), c.z + r * (Math.cos(a) * N.z + Math.sin(a) * B.z));
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  if (cap) for (const [i, t] of [[0, 0], [seg, 1]]) {
    const c = curve.getPointAt(t), ci = pos.length / 3; pos.push(c.x, c.y, c.z);
    for (let j = 0; j < radial; j++) { const a = i * (radial + 1) + j; idx.push(...(i ? [a, ci, a + 1] : [a + 1, ci, a])); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}

// 回転体（服・靴）
// 輪郭は下→上の順で渡す（逆だと面が内向きになって透けて見える）
const lathe = (profile, seg = 48) => { const pts = profile.map(([r, y]) => new THREE.Vector2(r, y)); if (pts[0].y > pts.at(-1).y) pts.reverse(); return new THREE.LatheGeometry(pts, seg); };

export function buildToonCharacter() {
  const B = bones();
  const root = new THREE.Group(); root.name = "Character";
  root.add(B.Root);
  root.updateMatrixWorld(true);
  const list = Object.values(B), boneIndex = Object.fromEntries(list.map((b, i) => [b.name, i]));
  const skeleton = new THREE.Skeleton(list);
  const W = (name) => new THREE.Vector3().setFromMatrixPosition(B[name].matrixWorld);
  const meshes = [];
  // 部品は材質ごとにまとめて1つのメッシュにする（iPhone で描画の回数・スキンの数を減らす）
  const parts = new Map();
  const add = (name, geo, material, weights) => {
    const g = skinned(geo, typeof weights === "string" ? () => [[weights, 1]] : weights, boneIndex);
    if (!parts.has(material)) parts.set(material, []);
    parts.get(material).push(g);
  };
  const M = Object.fromEntries(Object.entries(PALETTE).map(([k, c]) => [k, mat(k, c)]));
  const headC = new THREE.Vector3(0, HEAD_Y, 0.01);

  // --- 頭（肌）：丸い大きな頭。顔の前は少し平ら・あごはふっくら ---
  const head = new THREE.SphereGeometry(HEAD_R, 48, 36);
  const hp = head.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < hp.count; i++) {
    v.fromBufferAttribute(hp, i).multiply(HEAD_SCALE);
    if (v.z > 0) v.z *= 1 - 0.12 * smooth(v.z / (HEAD_R * HEAD_SCALE.z));   // 顔の前を少し平らに
    if (v.y < 0) v.x *= 1 + 0.04 * smooth(-v.y / HEAD_R);                 // ほっぺのふくらみ
    hp.setXYZ(i, v.x + headC.x, v.y + headC.y, v.z + headC.z);
  }
  add("Head_skin", head, M.skin, "Head");

  // --- 帽子：頭より少し大きい殻。顔の範囲はなめらかに頭の内側へ沈める（切り抜くと縁がギザギザになるため）。
  //     帽子と顔の境目は「殻が頭の面に潜り込む線」になり、ふっくらした縁に見える
  const hr = HEAD_R * 1.05;
  const hood = new THREE.SphereGeometry(hr, 80, 60);
  const hq = hood.attributes.position, u = new THREE.Vector3();
  for (let i = 0; i < hq.count; i++) {
    u.fromBufferAttribute(hq, i);
    const nx = u.x / hr, ny = u.y / hr, nz = u.z / hr;
    // 顔の穴：前側の楕円（元絵の顔の出ている範囲）。m < 1 が顔
    const m = nz > 0 ? (nx / 0.93) ** 2 + ((ny + 0.33) / 0.87) ** 2 : 9;
    const dent = 1 - smooth((m - 0.78) / 0.3);              // 顔の中で 1、縁の帯で 0 へ
    const low = smooth((-ny - 0.5) / 0.2);                   // 首のまわり（下側）も沈める
    const k = 1 - 0.3 * Math.max(dent, low);
    u.multiplyScalar(k).multiply(HEAD_SCALE).add(headC);
    hq.setXYZ(i, u.x, u.y, u.z);
  }
  add("Hood", hood, M.hood, "Head");
  // 耳：帽子の上の左右に、大きめの丸い三角（元絵では頭の幅いっぱいの位置から斜めに立つ）
  for (const s of [1, -1]) {
    const ear = new THREE.SphereGeometry(HEAD_R * 0.34, 28, 18);
    ear.scale(0.9, 1.3, 0.42); ear.rotateZ(s * -0.62); ear.rotateY(s * 0.12);
    ear.translate(headC.x + s * HEAD_R * 0.98, headC.y + HEAD_R * 0.82, headC.z + HEAD_R * 0.05);
    add(`Ear_${s > 0 ? "L" : "R"}`, ear, M.hood, "Head");
    const inner = new THREE.SphereGeometry(HEAD_R * 0.2, 20, 12);
    inner.scale(0.85, 1.25, 0.3); inner.rotateZ(s * -0.62); inner.rotateY(s * 0.12);
    inner.translate(headC.x + s * HEAD_R * 1.0, headC.y + HEAD_R * 0.8, headC.z + HEAD_R * 0.15);
    add(`EarInner_${s > 0 ? "L" : "R"}`, inner, M.hoodShade, "Head");
  }
  // 帽子の点3つ（おでこの上）
  for (const [dx, dy, sx] of [[-0.3, 0.72, 1.4], [0.3, 0.72, 1.4], [0, 0.62, 0.8]]) {
    const d = new THREE.SphereGeometry(HEAD_R * 0.045, 12, 8); d.scale(sx, 0.7, 0.5);
    const x = dx * hr * HEAD_SCALE.x, y = dy * hr * HEAD_SCALE.y, z = Math.sqrt(Math.max(0, 1 - (dx * dx + dy * dy))) * hr * HEAD_SCALE.z;
    const dir = new THREE.Vector3(x / HEAD_SCALE.x, y / HEAD_SCALE.y, z / HEAD_SCALE.z).normalize();
    d.lookAt(dir); d.translate(headC.x + x * 1.01, headC.y + y * 1.01, headC.z + z * 1.01);
    add("HoodDot", d, M.dot, "Head");
  }
  // ポニーテール：頭の右上（見る人の右＝キャラの左 +X）から、右へ大きく張り出す平たい葉っぱ形（元絵どおり）
  // 正面から見て、頭の右上の外に大きく出るように（元絵）。付け根は頭の横うしろ
  const s0 = headC.clone().add(new THREE.Vector3(HEAD_R * 1.05, HEAD_R * 0.55, 0));
  const pony = [s0, s0.clone().add(new THREE.Vector3(0.08, 0.1, 0)), s0.clone().add(new THREE.Vector3(0.18, 0.16, 0)), s0.clone().add(new THREE.Vector3(0.31, 0.15, 0))];
  const ponyGeo = taperTube(pony, (t) => HEAD_R * (0.46 * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) ** 0.8 + 0.01), 28, 64);
  // 前後に平たく（葉っぱ形）：付け根を中心に z をつぶす
  const pp = ponyGeo.attributes.position;
  for (let i = 0; i < pp.count; i++) pp.setZ(i, s0.z + (pp.getZ(i) - s0.z) * 0.45);
  add("Ponytail", ponyGeo, M.hair, "Head");

  // --- 体：Tシャツ（ずんどう）。首元は少し狭く、すそは少し広い ---
  const shirt = lathe([[0.001, 0.465], [0.06, 0.465], [0.12, 0.45], [0.155, 0.42], [0.168, 0.37], [0.172, 0.30], [0.176, 0.24], [0.172, 0.222], [0.001, 0.222]], 64);
  shirt.scale(1.0, 1, 0.78);
  add("Shirt", shirt, M.shirt, (p) => blend("Waist", "Spine02", smooth((p.y - 0.24) / 0.14)));
  // 半袖（肩から少し下向き）と腕・丸い手
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    const a = W(`${side}_Upperarm`), f = W(`${side}_Forearm`), h = W(`${side}_Hand`);
    const sleeve = taperTube([a.clone().add(new THREE.Vector3(-s * 0.035, 0.012, 0)), a.clone().lerp(f, 0.75)], (t) => 0.058 - 0.006 * t, 24, 10);
    add(`Sleeve_${side}`, sleeve, M.shirt, (p) => blend("Spine02", `${side}_Upperarm`, smooth(((p.x - a.x) * s + 0.02) / 0.05)));
    const arm = taperTube([a.clone().lerp(f, 0.55), f, h], (t) => 0.04 - 0.004 * t, 20, 16);
    add(`Arm_${side}`, arm, M.skin, (p) => blend(`${side}_Upperarm`, `${side}_Forearm`, smooth(((p.x - f.x) * s + 0.03) / 0.06)));
    const hand = new THREE.SphereGeometry(0.052, 24, 16); hand.scale(1.05, 0.95, 0.9); hand.translate(h.x + s * 0.022, h.y - 0.012, h.z);
    add(`Hand_${side}`, hand, M.skin, `${side}_Hand`);
  }
  // 短パン
  const shorts = lathe([[0.001, 0.238], [0.17, 0.238], [0.176, 0.2], [0.182, 0.15], [0.178, 0.132], [0.001, 0.132]], 64);
  shorts.scale(1, 1, 0.8);
  add("Shorts", shorts, M.shorts, (p) => p.y > 0.17 ? [["Hip", 1]] : [["Hip", 0.5], [p.x > 0 ? "L_Thigh" : "R_Thigh", 0.5]]);
  // 脚（短く太め）・靴下・丸い靴
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    const t = W(`${side}_Thigh`), c = W(`${side}_Calf`), f = W(`${side}_Foot`);
    const leg = taperTube([t.clone().add(new THREE.Vector3(0, 0.02, 0)), c, f.clone().add(new THREE.Vector3(0, 0.01, 0))], () => 0.054, 20, 16);
    add(`Leg_${side}`, leg, M.skin, (p) => blend(`${side}_Thigh`, `${side}_Calf`, smooth((c.y + 0.03 - p.y) / 0.06)));
    const shoe = new THREE.SphereGeometry(0.085, 32, 20); shoe.scale(1.0, 0.6, 1.25); shoe.translate(f.x + s * 0.008, 0.05, f.z + 0.03);
    add(`Shoe_${side}`, shoe, M.shoe, `${side}_Foot`);
  }
  for (const [material, geos] of parts) {
    const m = new THREE.SkinnedMesh(mergeGeometries(geos), material);
    m.name = material.name === "hood" ? "Hood" : material.name === "skin" ? "Head_skin" : material.name;
    m.bind(skeleton); root.add(m); meshes.push(m);
  }
  return { root, bones: B, skeleton, meshes, headCenter: headC, headRadius: HEAD_R, headScale: HEAD_SCALE };
}

/**
 * 顔シート：頭の前面に沿う格子（UV は元絵の顔の範囲 rect に対応）。頭の骨の子にする（重み Head のスキン）
 * 元絵の頭（head cell: x 196〜1021, y 96〜739）の幅 ⇔ 3Dの頭の幅、で位置を合わせる
 */
export function buildFaceSheet(built, { rect, sourceHead = [196, 96, 1021, 739], N = 40 }) {
  const { headCenter: c, headRadius: R, headScale: S } = built;
  const [hx0, hy0, hx1, hy1] = sourceHead, [rx0, ry0, rx1, ry1] = rect;
  // 元絵の座標 → 頭の正面から見た位置（頭の幅いっぱい＝ 2R·Sx）。縦も同じ縮尺（元絵の比率を保つ）
  const k = (2 * R * S.x) / (hx1 - hx0);
  const cxSrc = (hx0 + hx1) / 2, cySrc = hy0 + (hy1 - hy0) * 0.52;   // 頭の中心（帽子の耳を除いた真ん中あたり）
  const pos = [], uv = [], idx = [];
  const surfaceZ = (x, y) => {  // 頭（肌）の前面の z。頭の作り方と同じ式
    const nx = x / (R * S.x), ny = y / (R * S.y);
    const zz = 1 - nx * nx - ny * ny;
    if (zz <= 0) return null;
    let z = Math.sqrt(zz) * R * S.z;
    z *= 1 - 0.12 * smooth(z / (R * S.z));
    return z;
  };
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const sx = rx0 + ((rx1 - rx0) * i) / N, sy = ry0 + ((ry1 - ry0) * j) / N;
    // 見る人の右 = キャラの左 = +X。元絵の y は下向きなので反転
    const x = (sx - cxSrc) * k, y = -(sy - cySrc) * k;
    const z = surfaceZ(x, y) ?? 0;
    pos.push(c.x + x, c.y + y, c.z + z + R * 0.012);
    uv.push((sx - rx0) / (rx1 - rx0), (sy - ry0) / (ry1 - ry0));
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, d = a + N + 1, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
