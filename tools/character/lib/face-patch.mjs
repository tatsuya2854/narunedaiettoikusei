// 3Dでも表情を動かすための下ごしらえ（無料・ローカル）。
//
//  1. テクスチャに焼き込まれた顔（目・眉・口・ほっぺ）を見つける
//  2. その3D上の位置と、元絵の顔パーツの位置を合わせて「元絵の座標 ⇔ 3D」の対応を決める（キャリブレーション）
//  3. 顔の凹凸をならす（Tripo は目・口・ほっぺを浮き彫りとしても作るので、色を消しても陰影で見えてしまう）
//  4. 焼き込みの顔を肌色で塗りつぶす
//  5. 頭の前面にぴったり沿う薄い「顔シート」（FacePatch）を作り、頭の骨に付ける
//     → ゲーム側はこのシートに、2Dと同じ顔パーツを2Dと同じ表情の数値（EXPR）で描く。目は開けない
import * as THREE from "three";
import sharp from "sharp";

// 2x2 の透明PNG。単色だと最適化（prune）が「色の数値」に置き換えてテクスチャごと消し、UV も消されるので、画素ごとに色を変えてある
const TRANSPARENT_PNG = await sharp(Buffer.from([255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 0]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer().then((b) => new Uint8Array(b));

/**
 * @param {import("@gltf-transform/core").Document} doc リグ済み（生出力の向き：正面 +X・上 +Y）
 * @param {{ features:number[], rect:number[], headBone?:string, grid?:number }} face
 *   features 元絵での顔パーツ（眉・目・口・ほっぺ）全体の外枠 [x0,y0,x1,y1]
 *   rect     顔シートを張る範囲（元絵の座標）。features より少し広く
 */
export async function buildFacePatch(doc, { features, rect, headBone = "Head", grid = 40 }) {
  const root = doc.getRoot();
  const head = root.listNodes().find((n) => n.getName() === headBone);
  if (!head) throw new Error(`頭の骨 ${headBone} がありません`);
  const geoms = collect(doc);
  const box = new THREE.Box3(); for (const g of geoms) for (const p of g.P) box.expandByPoint(p);
  const height = box.max.y - box.min.y, midX = (box.min.x + box.max.x) / 2;

  // 1) テクスチャの画素ごとに3D上の位置を出し、焼き込みの顔パーツ（黒い線・桃色）を見つける
  const texs = await analyzeTextures(geoms, midX, box);
  // 2) キャリブレーション：顔パーツの画素の3D上の外枠（正面から見た z・y）＝ 元絵の features
  const zs = [], ys = [];
  for (const t of texs) for (let i = 0; i < t.W * t.H; i++) if (t.feat[i]) { zs.push(t.pos[i * 3 + 2]); ys.push(t.pos[i * 3 + 1]); }
  if (process.env.FACE_DEBUG) {
    const Wd = 600, Hd = 600, img = Buffer.alloc(Wd * Hd * 3, 255);
    for (const t of texs) for (let i = 0; i < t.W * t.H; i++) {
      if (!t.covered[i] || !t.front[i]) continue;
      const z = t.pos[i * 3 + 2], y = t.pos[i * 3 + 1];
      const X = Math.round(((box.max.z - z) / (box.max.z - box.min.z)) * (Wd - 1)), Y = Math.round(((box.max.y - y) / (box.max.y - box.min.y)) * (Hd - 1));
      const o = (Y * Wd + X) * 3; if (o < 0 || o >= img.length) continue;
      if (t.feat[i]) { img[o] = 255; img[o + 1] = 0; img[o + 2] = 0; } else if (img[o] === 255 && img[o + 1] === 255) { img[o] = 200; img[o + 1] = 200; img[o + 2] = 200; }
    }
    await sharp(img, { raw: { width: Wd, height: Hd, channels: 3 } }).png().toFile(process.env.FACE_DEBUG);
  }
  if (zs.length < 200) throw new Error(`焼き込みの顔パーツが見つかりません（${zs.length}画素）`);
  const pct = (a, q) => a[Math.floor((a.length - 1) * q)];
  zs.sort((x, y) => x - y); ys.sort((x, y) => x - y);
  const zMax = pct(zs, 0.995), zMin = pct(zs, 0.005), yMax = pct(ys, 0.995), yMin = pct(ys, 0.005);
  const [fx0, fy0, fx1, fy1] = features;
  // 正面から見て、見る人の左 = キャラの右 = +Z
  const toSource = (p) => [fx0 + ((zMax - p.z) / (zMax - zMin)) * (fx1 - fx0), fy0 + ((yMax - p.y) / (yMax - yMin)) * (fy1 - fy0)];
  const toScene = (sx, sy) => ({ z: zMax - ((sx - fx0) / (fx1 - fx0)) * (zMax - zMin), y: yMax - ((sy - fy0) / (fy1 - fy0)) * (yMax - yMin) });

  // 3) 顔の凹凸をならす
  const cut = {};
  const smoothed = smoothFace(geoms, toSource, rect, midX, cut);
  // 4) 焼き込みの顔を塗りつぶす
  let erased = 0;
  // 塗る範囲は顔パーツより少し広く（なじませる帯が顔パーツにかからないように。口は下端にあるので下を多めに）
  const fw = features[2] - features[0], fh = features[3] - features[1];
  const featRect = [features[0] - fw * 0.1, features[1] - fh * 0.14, features[2] + fw * 0.1, features[3] + fh * 0.22];
  for (const t of texs) erased += await paintOut(t, toSource, rect, featRect, cut.x ?? midX);
  // 5) 顔シート
  const triangles = addPatch(doc, geoms, head, box, toScene, rect, grid, height);
  return { triangles, erased, smoothed, calib: { zMin, zMax, yMin, yMax } };
}

// スキン付きメッシュの頂点を、基本姿勢のシーン座標で集める
function collect(doc) {
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh() || !node.getSkin()) continue;
    const skin = node.getSkin(), j0 = skin.listJoints()[0], ibm = skin.getInverseBindMatrices();
    const B = new THREE.Matrix4().fromArray(j0.getWorldMatrix()).multiply(new THREE.Matrix4().fromArray(ibm ? ibm.getElement(0, []) : new THREE.Matrix4().toArray()));
    for (const prim of node.getMesh().listPrimitives()) {
      const pos = prim.getAttribute("POSITION"), v = [0, 0, 0], P = [];
      for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); P.push(new THREE.Vector3(...v).applyMatrix4(B)); }
      out.push({ prim, P, B });
    }
  }
  if (!out.length) throw new Error("スキン付きのメッシュがありません");
  return out;
}
const triIndex = (prim, P) => { const idx = prim.getIndices(), n = idx ? idx.getCount() : P.length; return { n, at: (k) => (idx ? idx.getScalar(k) : k) }; };

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
const isLine = (r, g, b) => lum(r, g, b) < 150 && chroma(r, g, b) < 90;
const isPink = (r, g, b) => r > 150 && r - g > 55 && b > g - 20;
function isSkin(r, g, b, strict = 0) {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2;
  if (max === min) return false;
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r / 255 ? ((g - b) / 255 / d) % 6 : max === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
  h *= 60; if (h < 0) h += 360;
  // 帽子のクリーム色（色相 約42°・とても明るい）は肌に含めない
  return h >= 8 && h <= 38 && l > 0.5 + strict * 2 && l < 0.9 && s > 0.3 + strict * 3;
}

async function analyzeTextures(geoms, midX, box) {
  const byTex = new Map();
  for (const g of geoms) {
    const tex = g.prim.getMaterial()?.getBaseColorTexture();
    if (!tex || !g.prim.getAttribute("TEXCOORD_0")) continue;
    if (!byTex.has(tex)) byTex.set(tex, []);
    byTex.get(tex).push(g);
  }
  // 頭の高さ（全身の下から 55% より上）
  const headLow = box.min.y + 0.55 * (box.max.y - box.min.y);
  const out = [];
  for (const [tex, list] of byTex) {
    const { data: px, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const pos = new Float32Array(W * H * 3), covered = new Uint8Array(W * H), front = new Uint8Array(W * H);
    const uv = [0, 0];
    for (const { prim, P } of list) {
      const U = prim.getAttribute("TEXCOORD_0"), { n, at } = triIndex(prim, P);
      for (let t = 0; t < n; t += 3) {
        const ids = [at(t), at(t + 1), at(t + 2)], pts = ids.map((k) => P[k]);
        const nrm = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
        // 三角形の巻き方向がそろっていないので、法線の表裏ではなく「傾き」と「体の前半分か」で正面を決める
        const isFront = Math.abs(nrm.x) > 0.35 && (pts[0].x + pts[1].x + pts[2].x) / 3 > midX;
        const tuv = ids.map((k) => { U.getElement(k, uv); return [uv[0] * W, uv[1] * H]; });
        raster(tuv, W, H, (i, w) => {
          covered[i] = 1; if (isFront) front[i] = 1;
          for (let c = 0; c < 3; c++) pos[i * 3 + c] = pts[0].getComponent(c) * w[0] + pts[1].getComponent(c) * w[1] + pts[2].getComponent(c) * w[2];
        });
      }
    }
    // 顔パーツ：正面向きの面・頭の高さにある、肌の上の黒い線と桃色。つながっている同じ色をたどって全部拾う
    const feat = new Uint8Array(W * H);
    const isFeat = (i) => { const o = i * 4; return isLine(px[o], px[o + 1], px[o + 2]) || isPink(px[o], px[o + 1], px[o + 2]); };
    let frontier = [];
    for (let i = 0; i < W * H; i++) if (covered[i] && front[i] && pos[i * 3 + 1] > headLow && isFeat(i) && onSkin(px, i, W, H)) { feat[i] = 1; frontier.push(i); }
    for (let step = 0; step < 200 && frontier.length; step++) {
      const next = [];
      for (const i of frontier) for (const j of neighbors4(i, W, H)) if (!feat[j] && covered[j] && isFeat(j)) { feat[j] = 1; next.push(j); }
      frontier = next;
    }
    out.push({ tex, px, W, H, pos, covered, front, feat });
  }
  return out;
}
// 黒い線・桃色が「肌の上」にあるか（帽子の点は帽子色の上なので除く）
function onSkin(px, i, W, H) {
  const x = i % W, y = (i / W) | 0;
  let skin = 0, other = 0;
  for (let dy = -8; dy <= 8; dy += 4) for (let dx = -8; dx <= 8; dx += 4) {
    const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const q = (Y * W + X) * 4; if (isLine(px[q], px[q + 1], px[q + 2]) || isPink(px[q], px[q + 1], px[q + 2])) continue;
    if (isSkin(px[q], px[q + 1], px[q + 2])) skin++; else other++;
  }
  // まわりがほぼ肌色のものだけ（帽子と顔の境目の線は片側が帽子色なので除く）
  return skin >= 6 && skin >= other * 4;
}

// 焼き込みの顔パーツを肌色で塗りつぶす
async function paintOut(t, toSource, rect, featRect, midX) {
  const { tex, px, W, H, pos, covered, front, feat } = t;
  const [rx0, ry0, rx1, ry1] = rect;
  const inFace = new Uint8Array(W * H);
  const v = new THREE.Vector3();
  for (let i = 0; i < W * H; i++) {
    if (!covered[i] || !front[i]) continue;   // 肌色の見本は正面の面からだけ取る
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const [sx, sy] = toSource(v);
    if (sx > rx0 && sx < rx1 && sy > ry0 && sy < ry1) inFace[i] = 1;
  }
  // 位置合わせ済みなので、顔パーツの範囲（元絵の座標）の中は色に関係なく肌色で塗る。
  // テクスチャには顔パーツのまわりの陰影も描き込まれているため。口の中のように正面を向いていない面も含める（体の前半分なら）。
  // 範囲の端の帯では、元の色となじませる
  const [fx0, fy0, fx1, fy1] = featRect;
  const bandX = (fx1 - fx0) * 0.08, bandY = (fy1 - fy0) * 0.12, bandBottom = (fy1 - fy0) * 0.35;
  const blend = new Float32Array(W * H);
  const grow = feat.slice();
  for (let i = 0; i < W * H; i++) {
    if (!covered[i] || pos[i * 3] < midX) continue;
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const [sx, sy] = toSource(v);
    // 下（あご）は元の陰影が濃いので、なじませる帯を広く取る
    const f = Math.min((sx - fx0) / bandX, (fx1 - sx) / bandX, (sy - fy0) / bandY, (fy1 + bandBottom * 0.6 - sy) / bandBottom);
    if (f <= 0) continue;
    blend[i] = f >= 1 ? 1 : f * f * (3 - 2 * f);
  }
  // 線の縁（黒と肌の中間色）も残らないよう、まわり3画素以内の「肌色でない」画素も塗る
  for (let pass = 0; pass < 3; pass++) {
    const cur = grow.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cur[i] || !covered[i] || !(cur[i - 1] || cur[i + 1] || cur[i - W] || cur[i + W])) continue;
      const o = i * 4; if (!isSkin(px[o], px[o + 1], px[o + 2], 0.06)) grow[i] = 1;
    }
  }
  // 顔の肌色（顔の範囲で、きれいな肌色の画素の中央値）。元絵はフラットな塗りなので、この1色で塗れば跡が残らない
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < W * H; i++) { if (!inFace[i] || grow[i]) continue; const o = i * 4; if (isSkin(px[o], px[o + 1], px[o + 2], 0.06)) { rs.push(px[o]); gs.push(px[o + 1]); bs.push(px[o + 2]); } }
  if (!rs.length) throw new Error("顔の肌色が取れません（キャリブレーションがずれている？）");
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  const skin = [med(rs), med(gs), med(bs)];
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const k = grow[i] ? 1 : blend[i];
    if (!k) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) px[o + c] = px[o + c] + (skin[c] - px[o + c]) * k;
    n++;
  }
  // 島の継ぎ目の余白（どの面にも使われていない画素）にも塗った色を広げる。表示のときに元の色がにじまないように
  let edge = []; for (let i = 0; i < W * H; i++) if ((grow[i] || blend[i] > 0.5)) edge.push(i);
  const done = new Uint8Array(W * H); for (const i of edge) done[i] = 1;
  for (let step = 0; step < 6 && edge.length; step++) {
    const next = [];
    for (const i of edge) for (const j of neighbors4(i, W, H)) {
      if (done[j] || covered[j]) continue;
      done[j] = 1; const o = j * 4, q = i * 4; px[o] = px[q]; px[o + 1] = px[q + 1]; px[o + 2] = px[q + 2]; next.push(j);
    }
    edge = next;
  }
  if (process.env.FACE_DEBUG) {
    let left = 0, unc = 0, back = 0, outR = 0; const samp = [];
    for (let i = 0; i < W * H; i++) {
      const o = i * 4; if (!isPink(px[o], px[o + 1], px[o + 2])) continue;
      if (!covered[i]) { unc++; continue; }
      if (pos[i * 3] < midX) { back++; continue; }
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); const [sx, sy] = toSource(v);
      if (samp.length < 8) samp.push([Math.round(sx), Math.round(sy), blend[i].toFixed(2)]);
      left++;
    }
    console.error("pink left(front)", left, "uncovered", unc, "back", back, samp);
  }
  const mime = tex.getMimeType();
  let img = sharp(px, { raw: { width: W, height: H, channels: 4 } });
  img = mime === "image/png" ? img.png() : mime === "image/webp" ? img.webp({ quality: 95 }) : img.removeAlpha().jpeg({ quality: 95 });
  tex.setImage(new Uint8Array(await img.toBuffer()));
  return n;
}

/**
 * 顔の範囲の頂点をならす（Taubin 平滑化：縮みにくい）。UV の切れ目で頂点が分かれているので、位置で束ねて一緒に動かす。
 * 範囲の端に向かって効きを弱め、頭の形は変えない。
 */
function smoothFace(geoms, toSource, rect, midX, cut = {}) {
  const [rx0, ry0, rx1, ry1] = rect;
  const padX = (rx1 - rx0) * 0.15, padY = (ry1 - ry0) * 0.15;
  let moved = 0;
  for (const g of geoms) {
    const { prim, P } = g, { n, at } = triIndex(prim, P);
    const key = (p) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
    const groupOf = new Map(), groups = [];
    P.forEach((p, i) => { const k = key(p); if (!groupOf.has(k)) { groupOf.set(k, groups.length); groups.push({ p: p.clone(), members: [] }); } groups[groupOf.get(k)].members.push(i); });
    const gi = P.map((p) => groupOf.get(key(p)));
    const nb = groups.map(() => new Set());
    for (let t = 0; t < n; t += 3) { const a = gi[at(t)], b = gi[at(t + 1)], c = gi[at(t + 2)]; nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b); }
    // 顔のまわり（範囲の外側の帯）の頭の表面に楕円体を当てはめ、顔の頂点をその面へ寄せる（凹凸が消え、丸い顔になる）。
    // 頭は顔のあたりが少し平たいので、球ではなく楕円体（軸はそろえる）
    const inBand = (sx, sy, k) => { const ex = (rx1 - rx0) * k, ey = (ry1 - ry0) * k; return sx > rx0 - ex && sx < rx1 + ex && sy > ry0 - ey && sy < ry1 + ey; };
    const ring = [];
    groups.forEach(({ p }) => {
      if (p.x < midX) return;
      const [sx, sy] = toSource(p);
      if (inBand(sx, sy, 0.45) && !inBand(sx, sy, 0.16)) ring.push(p);
    });
    const ell = fitEllipsoid(ring) || (() => { const sp = fitSphere(ring); return sp && { c: sp.c, r: new THREE.Vector3(sp.r, sp.r, sp.r) }; })();
    // 口の中のように頭の中心近くまでくぼんだ所も拾う（楕円体の中心より前なら対象）
    const cutX = ell ? ell.c.x : midX;
    cut.x = Math.min(cut.x ?? cutX, cutX);
    // 範囲（rect）の中は全部効かせ、外側の帯で弱める
    const w = groups.map(({ p }) => {
      if (p.x < cutX) return 0;
      const [sx, sy] = toSource(p);
      const f = Math.min((sx - (rx0 - padX)) / padX, ((rx1 + padX) - sx) / padX, (sy - (ry0 - padY)) / padY, ((ry1 + padY) - sy) / padY);
      return f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
    });
    const pos = groups.map((q, i) => {
      if (!w[i] || !ell) return q.p.clone();
      const d = q.p.clone().sub(ell.c);
      const t = 1 / Math.sqrt((d.x / ell.r.x) ** 2 + (d.y / ell.r.y) ** 2 + (d.z / ell.r.z) ** 2);
      return q.p.clone().lerp(ell.c.clone().add(d.multiplyScalar(t)), w[i]);
    });
    // つなぎ目をなじませる
    const step = (lambda) => {
      const next = pos.map((p) => p.clone());
      for (let i = 0; i < pos.length; i++) {
        if (!w[i] || !nb[i].size) continue;
        const avg = new THREE.Vector3(); for (const j of nb[i]) avg.add(pos[j]);
        next[i].add(avg.multiplyScalar(1 / nb[i].size).sub(pos[i]).multiplyScalar(lambda * w[i]));
      }
      for (let i = 0; i < pos.length; i++) pos[i].copy(next[i]);
    };
    for (let k = 0; k < 3; k++) { step(0.5); step(-0.53); }
    const posAttr = prim.getAttribute("POSITION"), inv = g.B.clone().invert(), tmp = [0, 0, 0];
    groups.forEach((grp, i) => { if (!w[i]) return; moved++; for (const m of grp.members) { P[m].copy(pos[i]); posAttr.setElement(m, P[m].clone().applyMatrix4(inv).toArray(tmp)); } });
    // 法線を作り直す（動かした頂点）
    const nrm = prim.getAttribute("NORMAL");
    if (nrm) {
      const acc = groups.map(() => new THREE.Vector3());
      for (let t = 0; t < n; t += 3) {
        const ia = at(t), ib = at(t + 1), ic = at(t + 2);
        const fn = new THREE.Vector3().subVectors(P[ib], P[ia]).cross(new THREE.Vector3().subVectors(P[ic], P[ia]));
        acc[gi[ia]].add(fn); acc[gi[ib]].add(fn); acc[gi[ic]].add(fn);
      }
      const nm = new THREE.Matrix3().getNormalMatrix(inv);
      groups.forEach((grp, i) => {
        if (!w[i]) return;
        const old = new THREE.Vector3(...nrm.getElement(grp.members[0], [0, 0, 0]));
        const nn = acc[i].clone().applyMatrix3(nm).normalize();
        if (nn.dot(old) < 0) nn.negate();
        for (const m of grp.members) nrm.setElement(m, nn.toArray());
      });
    }
  }
  return moved;
}

// 顔シート：顔の範囲に格子を張り、正面から光線を当てて表面に沿わせる。頭の骨の子にする
function addPatch(doc, geoms, head, box, toScene, rect, N, height) {
  const all = [];
  for (const { prim, P } of geoms) { const { n, at } = triIndex(prim, P); for (let t = 0; t < n; t++) { const p = P[at(t)]; all.push(p.x, p.y, p.z); } }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(all, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const ray = new THREE.Raycaster();
  const eps = height * 0.004;
  const headInv = new THREE.Matrix4().fromArray(head.getWorldMatrix()).invert();
  const [rx0, ry0, rx1, ry1] = rect;
  const verts = [], uvs = [], ok = [], depth = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const sx = rx0 + ((rx1 - rx0) * i) / N, sy = ry0 + ((ry1 - ry0) * j) / N;
    const { z, y } = toScene(sx, sy);
    ray.set(new THREE.Vector3(box.max.x + height, y, z), new THREE.Vector3(-1, 0, 0));
    const hit = ray.intersectObject(mesh, false)[0];
    const p = hit ? hit.point.clone().add(new THREE.Vector3(eps, 0, 0)) : new THREE.Vector3(box.max.x, y, z);
    ok.push(!!hit); depth.push(p.x);
    verts.push(p.applyMatrix4(headInv)); uvs.push((sx - rx0) / (rx1 - rx0), (sy - ry0) / (ry1 - ry0));
  }
  const index = [], at = (i, j) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const q = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
    if (!q.every((k) => ok[k])) continue;
    const d = q.map((k) => depth[k]);
    if (Math.max(...d) - Math.min(...d) > height * 0.04) continue;   // 奥行きが飛ぶところ（耳など）はつながない
    index.push(q[0], q[2], q[1], q[1], q[2], q[3]);
  }
  const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(verts.flatMap((v) => v.toArray()))).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uvs)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(index)).setBuffer(buffer))
    .setMaterial(doc.createMaterial("FacePatch").setBaseColorFactor([1, 1, 1, 0]).setAlphaMode("BLEND")
      // 透明な小さいダミー（ゲーム側で表情のテクスチャに差し替える）。テクスチャが無いと最適化で UV が消されるため
      .setBaseColorTexture(doc.createTexture("FacePatch").setMimeType("image/png").setImage(TRANSPARENT_PNG)));
  head.addChild(doc.createNode("FacePatch").setMesh(doc.createMesh("FacePatch").addPrimitive(prim)).setExtras({ faceRect: rect }));
  return index.length / 3;
}

function raster(t, W, H, cb) {
  const [a, b, c] = t;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(d) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / d;
    const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
    cb(y * W + x, [w0, w1, w2]);
  }
}

// 最小二乗で球を当てはめる： x²+y²+z² = 2ax + 2by + 2cz + d
function fitSphere(pts) {
  if (pts.length < 20) return null;
  const A = Array.from({ length: 4 }, () => new Float64Array(4)), b = new Float64Array(4);
  for (const p of pts) {
    const row = [2 * p.x, 2 * p.y, 2 * p.z, 1], rhs = p.x * p.x + p.y * p.y + p.z * p.z;
    for (let i = 0; i < 4; i++) { b[i] += row[i] * rhs; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; }
  }
  // ガウスの消去法
  for (let i = 0; i < 4; i++) {
    let m = i; for (let r = i + 1; r < 4; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    for (let r = 0; r < 4; r++) { if (r === i) continue; const f = A[r][i] / A[i][i]; for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = [0, 1, 2, 3].map((i) => b[i] / A[i][i]);
  const c = new THREE.Vector3(x[0], x[1], x[2]);
  return { c, r: Math.sqrt(x[3] + c.lengthSq()) };
}

// 軸をそろえた楕円体： A x² + B y² + C z² + D x + E y + F z = 1 を最小二乗で解く
function fitEllipsoid(pts) {
  if (pts.length < 40) return null;
  const n = 6, M = Array.from({ length: n }, () => new Float64Array(n)), b = new Float64Array(n);
  for (const p of pts) {
    const row = [p.x * p.x, p.y * p.y, p.z * p.z, p.x, p.y, p.z];
    for (let i = 0; i < n; i++) { b[i] += row[i]; for (let j = 0; j < n; j++) M[i][j] += row[i] * row[j]; }
  }
  for (let i = 0; i < n; i++) {
    let m = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[m][i])) m = r;
    [M[i], M[m]] = [M[m], M[i]]; [b[i], b[m]] = [b[m], b[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let r = 0; r < n; r++) { if (r === i) continue; const f = M[r][i] / M[i][i]; for (let c = i; c < n; c++) M[r][c] -= f * M[i][c]; b[r] -= f * b[i]; }
  }
  const [A, B, C, D, E, F] = [0, 1, 2, 3, 4, 5].map((i) => b[i] / M[i][i]);
  if (A <= 0 || B <= 0 || C <= 0) return null;
  const c = new THREE.Vector3(-D / (2 * A), -E / (2 * B), -F / (2 * C));
  const g = 1 + A * c.x * c.x + B * c.y * c.y + C * c.z * c.z;
  if (g <= 0) return null;
  return { c, r: new THREE.Vector3(Math.sqrt(g / A), Math.sqrt(g / B), Math.sqrt(g / C)) };
}

// 上下左右の隣（行の端で次の行に回り込まない）
function neighbors4(i, W, H) {
  const x = i % W, out = [];
  if (x > 0) out.push(i - 1);
  if (x < W - 1) out.push(i + 1);
  if (i >= W) out.push(i - W);
  if (i < W * (H - 1)) out.push(i + W);
  return out;
}
