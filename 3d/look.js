// 3Dキャラの「見た目」まわり：表情（顔シート）・着せ替え（服の色替え）・頭の大きさの測定。
import * as T from "./vendor/three-char.js";

/**
 * 表情。モデルの顔シート（FacePatch）に、2Dと同じ顔パーツ（naru.webp の目・眉・口・ほっぺ）を
 * 2Dと同じ表情の数値（EOUT：[dx, dy, 回転, 横倍率, 縦倍率]）で描く。目は2Dと同じく開かない（閉じた目のパーツしか無い）。
 * @param face { src, cells, scale, feat, ex }  index.html から渡される2Dの顔パーツ情報
 */
/**
 * どうぶつの森風のトゥーン（アニメ調）の陰影。明るい面・少し暗い面・影の3段で、境目はなめらかすぎない
 */
export function toonGradient() {
  const t = new T.DataTexture(new Uint8Array([168, 214, 255]), 3, 1, T.RedFormat);
  t.minFilter = t.magFilter = T.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
export function applyToon(model, gradient) {
  model.traverse((o) => {
    if (!o.isMesh || o.name === "FacePatch") return;
    const old = o.material;
    o.material = new T.MeshToonMaterial({ color: old.color, gradientMap: gradient, name: old.name });
    old.dispose();
  });
}

export async function createFace(model, face, { toon = null } = {}) {
  const patch = model.getObjectByName("FacePatch");
  const mesh = patch?.isMesh ? patch : patch?.children?.find((c) => c.isMesh);
  if (!mesh || !face) return null;
  const rect = patch.userData?.faceRect || mesh.userData?.faceRect;
  if (!rect) return null;
  const img = await loadImage(face.src);
  const [rx0, ry0, rx1, ry1] = rect;
  const W = 384, H = Math.round((W * (ry1 - ry0)) / (rx1 - rx0));
  const k = W / (rx1 - rx0);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const tex = new T.CanvasTexture(cv);
  // 毎回ミップマップを作ると重いので作らない（顔はいつも同じくらいの大きさで見える）
  tex.colorSpace = T.SRGBColorSpace; tex.flipY = false; tex.generateMipmaps = false;
  tex.minFilter = T.LinearFilter; tex.magFilter = T.LinearFilter;
  // 顔シートには法線が無いので作る。外（正面）を向くようにそろえる
  mesh.geometry.computeVertexNormals();
  mesh.updateWorldMatrix(true, false);
  const nrm = mesh.geometry.attributes.normal, nm = new T.Matrix3().getNormalMatrix(mesh.matrixWorld);
  let sumZ = 0; const tmp = new T.Vector3();
  for (let i = 0; i < nrm.count; i++) sumZ += tmp.fromBufferAttribute(nrm, i).applyMatrix3(nm).z;
  if (sumZ < 0) { for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i)); }
  // glTF の仮の材質（透明のダミーテクスチャ）は捨てる
  for (const v of Object.values(mesh.material)) if (v?.isTexture) v.dispose();
  mesh.material.dispose();
  const common = { map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  mesh.material = toon ? new T.MeshToonMaterial({ ...common, gradientMap: toon }) : new T.MeshStandardMaterial({ ...common, roughness: 0.9, metalness: 0 });
  mesh.renderOrder = 2;
  // 2D と同じ計算：パーツの元の位置（元絵の座標）を中心に、回して伸ばして動かす
  const parts = face.feat.map((n) => {
    const c = face.cells[n], w = c.w / face.scale, h = c.h / face.scale;
    return { n, c, w, h, cx: c.ox + w / 2, cy: c.oy + h / 2 };
  });
  const ex = face.ex || 2.2;
  // 描き直すのは「値が変わったとき」だけ・多くても毎秒20回まで（テクスチャの転送は iPhone で重い）
  const last = new Float32Array(parts.length * 5).fill(NaN);
  let lastAt = 0;
  function draw(E, force = false) {
    const now = performance.now();
    if (!force && now - lastAt < 50) return false;
    let changed = force;
    for (let i = 0; i < parts.length; i++) {
      const e = E?.[parts[i].n];
      for (let j = 0; j < 5; j++) { const v = e ? e[j] : j < 3 ? 0 : 1; if (!(Math.abs(v - last[i * 5 + j]) < 0.004)) { last[i * 5 + j] = v; changed = true; } }
    }
    if (!changed) return false;
    lastAt = now;
    g.clearRect(0, 0, W, H);
    for (const p of parts) {
      const e = E?.[p.n] || [0, 0, 0, 1, 1];
      g.save();
      g.translate((p.cx - rx0 + e[0] * ex) * k, (p.cy - ry0 + e[1] * ex) * k);
      g.rotate((e[2] * Math.PI) / 180);
      g.scale(e[3], e[4]);
      g.drawImage(img, p.c.ax, p.c.ay, p.c.w, p.c.h, (-p.w / 2) * k, (-p.h / 2) * k, p.w * k, p.h * k);
      g.restore();
    }
    tex.needsUpdate = true;
    return true;
  }
  draw({}, true);
  // 目の位置（アクセのサングラス用）：顔シートの UV から探す
  const eyeAt = (n) => {
    const p = parts.find((q) => q.n === n); if (!p) return null;
    const u = (p.cx - rx0) / (rx1 - rx0), v = (p.cy - ry0) / (ry1 - ry0);
    const uv = mesh.geometry.attributes.uv, pos = mesh.geometry.attributes.position;
    let best = -1, bd = Infinity;
    for (let i = 0; i < uv.count; i++) { const d = (uv.getX(i) - u) ** 2 + (uv.getY(i) - v) ** 2; if (d < bd) { bd = d; best = i; } }
    if (best < 0) return null;
    const at = new T.Vector3();
    // スキン付きの顔シートは、骨の変形を通した位置で取る
    if (mesh.isSkinnedMesh) { mesh.updateWorldMatrix(true, true); mesh.skeleton.update(); mesh.getVertexPosition(best, at); return at.applyMatrix4(mesh.matrixWorld); }
    mesh.updateWorldMatrix(true, false);
    return at.set(pos.getX(best), pos.getY(best), pos.getZ(best)).applyMatrix4(mesh.matrixWorld);
  };
  return { draw, eyes: { L: eyeAt("eyeL"), R: eyeAt("eyeR") }, dispose: () => { tex.dispose(); mesh.material.dispose(); } };
}

/**
 * 頭の中心と大きさ（基本姿勢で測る）。アクセの大きさと置き場所に使う。
 * 首（頭の骨）より上の頂点から、ポニーテールや耳に引っぱられないよう、真ん中あたりの分布で決める。
 */
export function measureHead(model, headBone) {
  model.updateWorldMatrix(true, true);
  const neckY = new T.Vector3().setFromMatrixPosition(headBone.matrixWorld).y;
  const xs = [], ys = [], zs = [];
  const v = new T.Vector3();
  // 手元で作った体は、頭（肌）と帽子だけで測る（耳・ポニーテール・点を入れると大きく出る）
  const only = model.getObjectByName("Hood") ? new Set(["Hood", "Head_skin"]) : null;
  model.traverse((o) => {
    if (!o.isSkinnedMesh || o.name === "FacePatch" || (only && !only.has(o.name))) return;
    o.skeleton.update();   // 骨の行列を今の位置に（まだ一度も描いていないと古いままで、頭の位置がずれる）
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 2) {
      // 骨の行列にモデルの位置合わせ（ずらし）がすでに入っているので、matrixWorld は掛けない。
      // 掛けると頭の中心が二重にずれる（実測：顔の中心と頭の骨で確認）
      o.getVertexPosition(i, v);
      if (v.y > neckY) { xs.push(v.x); ys.push(v.y); zs.push(v.z); }
    }
  });
  const pts = xs.map((x, i) => new T.Vector3(x, ys[i], zs[i]));
  const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor((b.length - 1) * p)]; };
  const x0 = q(xs, only ? 0.005 : 0.08), x1 = q(xs, only ? 0.995 : 0.92), y0 = neckY, y1 = q(ys, only ? 0.995 : 0.97), z0 = q(zs, only ? 0.005 : 0.03), z1 = q(zs, only ? 0.995 : 0.97);
  const c = new T.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const r = new T.Vector3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);
  /**
   * 頭の断面：高さ y で、真上から見た頭の輪郭（n 方向ごとの中心からの距離）。
   * 耳・ポニーテールの出っ張りは、まわりの方向の中央値で抑える
   */
  function ring(y, n = 48, tol = r.y * 0.06) {
    const band = pts.filter((p) => Math.abs(p.y - y) < tol);
    const dist = new Array(n).fill(0);
    for (const p of band) {
      const a = Math.atan2(p.x - c.x, p.z - c.z), k = ((Math.round((a / (Math.PI * 2)) * n) % n) + n) % n;
      dist[k] = Math.max(dist[k], Math.hypot(p.x - c.x, p.z - c.z));
    }
    const filled = dist.map((d, i) => d || dist[(i + 1) % n] || dist[(i + n - 1) % n] || Math.min(r.x, r.z));
    const med = filled.map((_, i) => { const w = [-3, -2, -1, 0, 1, 2, 3].map((k) => filled[(i + k + n) % n]).sort((a, b) => a - b); return w[3]; });
    return med.map((d, i) => { const a = (i / n) * Math.PI * 2; return new T.Vector3(c.x + Math.sin(a) * d, y, c.z + Math.cos(a) * d); });
  }
  return { c, r, ring };
}

/**
 * 着せ替え：体のテクスチャで、黄色いシャツとグレーの短パンの画素だけ色を変える（2D と同じやり方・同じしきい値）。
 * モデルを作り直さない（クレジットを使わない）。
 */
export function createOutfitter(model) {
  // 手元で作った体（どうぶつの森風）は、シャツ・短パンが別々の材質なので色を変えるだけ
  const byName = {};
  model.traverse((o) => { if (o.isMesh && o.material?.name) (byName[o.material.name] ||= []).push(o.material); });
  if (byName.shirt && byName.shorts) {
    const base = { shirt: byName.shirt[0].color.clone(), shorts: byName.shorts[0].color.clone() };
    const set = (name, hsl) => byName[name].forEach((m) => (hsl ? m.color.setHSL(hsl[0] / 360, hsl[1], hsl[2], T.SRGBColorSpace) : m.color.copy(base[name])));
    return { apply: (o) => { set("shirt", o?.shirt); set("shorts", o?.shorts); }, dispose: () => {} };
  }
  let mesh = null;
  model.traverse((o) => { if (!mesh && o.isSkinnedMesh && o.material?.map) mesh = o; });
  if (!mesh) return null;
  const baseTex = mesh.material.map;
  let pixels = null, cur = null;   // 元の画素（1回だけ読む）と、今の服のテクスチャ（1枚だけ持つ）
  const read = () => {
    if (pixels) return pixels;
    const im = baseTex.image, cv = document.createElement("canvas");
    cv.width = im.width; cv.height = im.height;
    const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
    pixels = g.getImageData(0, 0, cv.width, cv.height);
    cv.width = cv.height = 0;
    return pixels;
  };
  const drop = () => { if (cur) { cur.tex.dispose(); cur.tex.image.width = cur.tex.image.height = 0; cur = null; } };
  function apply(outfit) {
    if (!outfit || !outfit.shirt) { mesh.material.map = baseTex; mesh.material.needsUpdate = true; drop(); return; }
    if (cur?.id === outfit.id) return;
    const data = read();
    const out = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height), d = out.data;
    const SH = outfit.shirt, SO = outfit.shorts;
    for (let i = 0; i < d.length; i += 4) {
      const [h, s, l] = hsl(d[i], d[i + 1], d[i + 2]);
      let t = null, b = 0;
      if (h >= 38 && h <= 56 && s > 0.55 && l > 0.25 && l < 0.7) { t = SH; b = 0.55; }      // 黄色いシャツ
      else if (s < 0.12 && l > 0.28 && l < 0.72) { t = SO; b = 0.6; }                      // グレーの短パン
      if (t) { const n = rgb(t[0], t[1], Math.min(0.96, (l * t[2]) / b)); d[i] = n[0]; d[i + 1] = n[1]; d[i + 2] = n[2]; }
    }
    const c2 = document.createElement("canvas"); c2.width = data.width; c2.height = data.height;
    c2.getContext("2d").putImageData(out, 0, 0);
    const tex = new T.CanvasTexture(c2);
    tex.colorSpace = baseTex.colorSpace; tex.flipY = baseTex.flipY; tex.wrapS = baseTex.wrapS; tex.wrapT = baseTex.wrapT;
    mesh.material.map = tex; mesh.material.needsUpdate = true;
    drop();
    cur = { id: outfit.id, tex };
  }
  return { apply, dispose: () => { drop(); pixels = null; } };
}

function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function rgb(h, s, l) {
  h /= 360;
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
}
function loadImage(src) {
  return new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ng; im.src = src; });
}
