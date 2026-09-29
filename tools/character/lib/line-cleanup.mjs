// 横や腕に回り込んだ「輪郭線」をテクスチャから消す（無料・ローカル）。
// 画像→3D は、元絵の黒い輪郭線を横や腕の面にも貼ってしまう（横から見ると縦のスジになる）。
// 正面を向いた面の線（目・口・帽子の縁など）は残し、正面から外れた面の暗い画素だけを周りの色で埋める。
// UV もメッシュも変えないので、リグ後・アニメ後のモデルにそのまま掛けられる。
import sharp from "sharp";

/**
 * @param {import("@gltf-transform/core").Document} doc
 * @param {{ forward?: number[], keepFacing?: number, dark?: number }} o
 *   forward    モデルの正面方向（Tripo の生出力は +X）
 *   keepFacing 正面との向きの内積がこれ以上の面の線は残す（0.5 ≒ 正面から60°以内）
 *   dark       これより暗い画素を「線」とみなす（0〜255 の明るさ）
 */
export async function removeSideLines(doc, { forward = [1, 0, 0], keepFacing = 0.5, dark = 80 } = {}) {
  const root = doc.getRoot();
  const report = [];
  // テクスチャごとに、どの画素がどれだけ正面を向いた面に属するかを塗る
  const byTex = new Map();
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const tex = prim.getMaterial()?.getBaseColorTexture();
    const pos = prim.getAttribute("POSITION"), uv = prim.getAttribute("TEXCOORD_0");
    if (!tex || !pos || !uv) continue;
    if (!byTex.has(tex)) byTex.set(tex, []);
    byTex.get(tex).push(prim);
  }
  for (const [tex, prims] of byTex) {
    const img = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: W, height: H } = img.info, px = img.data;
    const facing = new Float32Array(W * H).fill(NaN);
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], ua = [0, 0], ub = [0, 0], uc = [0, 0];
    for (const prim of prims) {
      const pos = prim.getAttribute("POSITION"), uv = prim.getAttribute("TEXCOORD_0"), idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const I = (k) => (idx ? idx.getScalar(k) : k);
      for (let t = 0; t < n; t += 3) {
        pos.getElement(I(t), a); pos.getElement(I(t + 1), b); pos.getElement(I(t + 2), c);
        uv.getElement(I(t), ua); uv.getElement(I(t + 1), ub); uv.getElement(I(t + 2), uc);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        const len = Math.hypot(nx, ny, nz) || 1;
        const f = (nx * forward[0] + ny * forward[1] + nz * forward[2]) / len;
        rasterize(facing, W, H, ua, ub, uc, f);
      }
    }
    // モデルの表面に実際に使われている画素（島の外の黒い余白は含まない）
    const covered = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (!Number.isNaN(facing[i])) covered[i] = 1;
    // 三角形の境目で塗り漏れた画素は、隣の画素の向きで埋める（線がそこだけ残るのを防ぐ）
    for (let pass = 0; pass < 3; pass++) {
      const src = facing.slice();
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!Number.isNaN(src[i])) continue;
        const n = [src[i - 1], src[i + 1], src[i - W], src[i + W]].filter((v) => !Number.isNaN(v));
        if (n.length) facing[i] = Math.max(...n);
      }
    }
    // 正面から外れた面の、暗い画素 = 回り込んだ線
    const mask = new Uint8Array(W * H);
    let count = 0;
    for (let i = 0; i < W * H; i++) {
      const f = facing[i];
      if (Number.isNaN(f) || f >= keepFacing) continue;
      const o = i * 4, l = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      const chroma = Math.max(px[o], px[o + 1], px[o + 2]) - Math.min(px[o], px[o + 1], px[o + 2]);
      // 線は「色味のない黒」。茶色の髪（暗いが色味がある）は消さない
      if ((l < dark && chroma < 45) || (l < 55 && chroma < 70)) { mask[i] = 1; count++; }
    }
    // 線の縁の中間色（アンチエイリアス・JPEGのにじみ）も残らないよう、2画素ふくらませる
    let grow = mask.slice();
    for (let pass = 0; pass < 2; pass++) {
      const cur = grow.slice();
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (cur[i] || !covered[i] || facing[i] >= keepFacing) continue;
        if (cur[i - 1] || cur[i + 1] || cur[i - W] || cur[i + W]) {
          const o = i * 4, l = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
          const chroma = Math.max(px[o], px[o + 1], px[o + 2]) - Math.min(px[o], px[o + 1], px[o + 2]);
          if (l < 195 && chroma < 90) grow[i] = 1;
        }
      }
    }
    // 島の外の余白も埋める対象にする。境目で黒い余白が表面ににじむのを防ぐ（テクスチャのパディング）
    for (let i = 0; i < W * H; i++) if (!covered[i]) grow[i] = 1;
    inpaint(px, W, H, grow);
    const buf = await sharp(px, { raw: { width: W, height: H, channels: 4 } }).removeAlpha()
      .toFormat(tex.getMimeType() === "image/png" ? "png" : "jpeg", { quality: 95 }).toBuffer();
    tex.setImage(new Uint8Array(buf));
    report.push({ texture: `${W}x${H}`, removedPixels: count });
  }
  return report;
}

// UV 三角形を画素に塗る（その画素の面の向きを記録。重なったら正面寄りを優先）
function rasterize(out, W, H, a, b, c, v) {
  const ax = a[0] * W, ay = a[1] * H, bx = b[0] * W, by = b[1] * H, cx = c[0] * W, cy = c[1] * H;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(d) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / d;
    const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / d;
    const w2 = 1 - w0 - w1;
    // 境目の取りこぼしを防ぐため、少しだけ外側まで含める
    if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
    const i = y * W + x;
    if (Number.isNaN(out[i]) || v > out[i]) out[i] = v;
  }
}

// 消す画素を、外側から周りの色の平均で少しずつ埋めていく
function inpaint(px, W, H, mask) {
  let todo = [];
  for (let i = 0; i < W * H; i++) if (mask[i]) todo.push(i);
  for (let pass = 0; pass < 64 && todo.length; pass++) {
    const next = [], fill = [];
    for (const i of todo) {
      const x = i % W, y = (i / W) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H || (!dx && !dy)) continue;
        const j = Y * W + X;
        if (mask[j]) continue;
        const o = j * 4; r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
      }
      if (n >= 2) fill.push([i, r / n, g / n, b / n]); else next.push(i);
    }
    for (const [i, r, g, b] of fill) { const o = i * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; mask[i] = 0; }
    todo = next;
  }
}
