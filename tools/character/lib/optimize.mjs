// Web（iPhone Safari）向けの最適化。無料・ローカルのみ。
//  1. アニメのクリップ名を状態名に揃える（idle/walk/jump/happy …）
//  2. テクスチャを縮小して WebP に（iOS Safari 14+ 対応。KTX2 はデコーダ込みで重くなるので今は使わない）
//  3. 三角形が多すぎるときだけ間引く（スキンの重みは保つ）
//  4. 頂点を量子化 + meshopt 圧縮（デコーダ 30KB 程度。Draco より軽い）
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, resample, weld, simplify, textureCompress, quantize, meshopt, getSceneVertexCount, VertexCountMethod } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import { removeSideLines } from "./line-cleanup.mjs";
import { buildFacePatch } from "./face-patch.mjs";

export async function makeIO() {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder,
  });
}

export function stats(doc) {
  const root = doc.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices(), pos = p.getAttribute("POSITION");
    tris += Math.floor((idx ? idx.getCount() : pos?.getCount() || 0) / 3);
  }
  return {
    triangles: tris,
    vertices: getSceneVertexCount(root.listScenes()[0], VertexCountMethod.UPLOAD_NAIVE),
    textures: root.listTextures().map((t) => ({ size: t.getSize(), mime: t.getMimeType(), bytes: t.getImage()?.byteLength || 0 })),
    animations: root.listAnimations().map((a) => a.getName()),
    skins: root.listSkins().length,
    joints: root.listSkins().reduce((n, s) => n + s.listJoints().length, 0),
  };
}

/**
 * クリップを状態に対応付けて名前を付け直す。
 * Tripo が複数アニメを1ファイルで返すときのクリップ名は公式に書かれていないので、
 *   ① 名前にプリセット名（idle, walk, cheer…）が入っていればそれで
 *   ② だめなら頼んだ順番で
 * 対応付ける。数が合わなければ止める（勝手に推測しない）。
 * @param {Record<string,string>} wanted 状態 → プリセット（例 { IDLE: "preset:idle" }）
 * @returns {Record<string,string>} 状態 → 付け直したクリップ名
 */
export function mapClips(doc, wanted) {
  const anims = doc.getRoot().listAnimations();
  const states = Object.keys(wanted);
  const presetName = (p) => p.replace(/^(preset:(biped:)?|local:)/, "").toLowerCase();
  const byName = {};
  for (const s of states) {
    const key = presetName(wanted[s]);
    const hit = anims.filter((a) => a.getName().toLowerCase().replace(/[^a-z0-9_]/g, "").includes(key));
    if (hit.length === 1) byName[s] = hit[0];
  }
  let map = byName;
  if (Object.keys(byName).length !== states.length || new Set(Object.values(byName)).size !== states.length) {
    if (anims.length !== states.length) {
      throw new Error(`クリップの数（${anims.length}: ${anims.map((a) => a.getName()).join(", ")}）が頼んだ数（${states.length}）と合いません。手で確認してください`);
    }
    map = Object.fromEntries(states.map((s, i) => [s, anims[i]]));
  }
  const out = {};
  for (const [s, a] of Object.entries(map)) { a.setName(s.toLowerCase()); out[s] = s.toLowerCase(); }
  return out;
}

/** 名前に head を含む関節を探す（アクセの取り付け点）。無ければ null */
export function findHeadBone(doc) {
  const joints = doc.getRoot().listSkins().flatMap((s) => s.listJoints());
  const names = joints.map((j) => j.getName());
  return names.find((n) => /(^|[^a-z])head$/i.test(n)) || names.find((n) => /head/i.test(n) && !/end|top|nub/i.test(n)) || null;
}

/** 全体を Y 軸まわりに回して焼き込む。Tripo の出力は +X が正面（export_orientation の既定 "+x"）なので -90 で +Z 正面に揃える */
export function rotateY(doc, deg) {
  if (!deg) return;
  const r = (deg * Math.PI) / 180;
  const q = [0, Math.sin(r / 2), 0, Math.cos(r / 2)];
  for (const scene of doc.getRoot().listScenes()) {
    const wrap = doc.createNode("orientation").setRotation(q);
    for (const n of scene.listChildren()) { scene.removeChild(n); wrap.addChild(n); }
    scene.addChild(wrap);
  }
}

export async function optimizeGlb({ input, output, wanted, maxTextureSize = 1024, maxTriangles = 15000, rotateYDeg = 0, sideLines = null, face = null }) {
  const io = await makeIO();
  const doc = await io.read(input);
  // 横に回り込んだ輪郭線を消す（回転を焼き込む前＝生出力の向きで判定する）
  const lines = sideLines ? await removeSideLines(doc, sideLines) : null;
  // 表情用：焼き込みの顔を消して、顔シートを付ける（輪郭線を消した後に）
  const faceInfo = face ? await buildFacePatch(doc, face) : null;
  rotateY(doc, rotateYDeg);
  const before = stats(doc);
  const clipMap = mapClips(doc, wanted);
  const headBone = findHeadBone(doc);

  await doc.transform(dedup(), prune(), resample(), weld());
  const mid = stats(doc);
  if (mid.triangles > maxTriangles) {
    // 目標に届く比率で間引く。輪郭がくずれすぎないよう error は小さめ
    const ratio = Math.max(0.05, maxTriangles / mid.triangles);
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002, lockBorder: true }));
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [maxTextureSize, maxTextureSize], quality: 88 }),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    prune(),
  );
  const after = stats(doc);
  await io.write(output, doc);
  return { before, after, clipMap, headBone, lines, face: faceInfo };
}

/**
 * 同じリグの GLB を何本か受け取り、1本目にほかのアニメを足して1つにする（骨は名前で対応付ける）。
 * @param {{file:string, name:string}[]} parts
 */
export async function mergeAnimations(parts, output) {
  const io = await makeIO();
  const base = await io.read(parts[0].file);
  const nodes = new Map(base.getRoot().listNodes().map((n) => [n.getName(), n]));
  const buffer = base.getRoot().listBuffers()[0] || base.createBuffer();
  const keep = base.getRoot().listAnimations();
  if (keep.length !== 1) throw new Error(`${parts[0].file}: アニメが ${keep.length} 本（1本のはず）`);
  keep[0].setName(parts[0].name);
  for (const part of parts.slice(1)) {
    const doc = await io.read(part.file);
    const anims = doc.getRoot().listAnimations();
    if (anims.length !== 1) throw new Error(`${part.file}: アニメが ${anims.length} 本（1本のはず）`);
    const out = base.createAnimation(part.name);
    for (const ch of anims[0].listChannels()) {
      const target = nodes.get(ch.getTargetNode()?.getName());
      if (!target) throw new Error(`${part.file}: 骨 ${ch.getTargetNode()?.getName()} が1本目にありません（別のリグ？）`);
      const sm = ch.getSampler();
      const copy = (acc) => base.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice()).setBuffer(buffer);
      const sampler = base.createAnimationSampler().setInput(copy(sm.getInput())).setOutput(copy(sm.getOutput())).setInterpolation(sm.getInterpolation());
      out.addSampler(sampler).addChannel(base.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(sampler));
    }
  }
  await io.write(output, base);
  return base.getRoot().listAnimations().map((a) => a.getName());
}
