// キャラクター3D化パイプラインの各段階。CLI（cli.mjs）から1キャラずつ呼ぶ。
//
//   init      元画像を source/<id>/ に置き、character.json を作る（元画像は上書きしない）
//   prepare   3D化に渡す入力画像を作る（余白・正方形・サイズ）              無料
//   generate  画像 → 3Dモデル候補を1つ作る                                有料
//   ── ここで止まる（HUMAN CHECKPOINT: review で人が Approve / Reject） ──
//   rig       Approve されたモデルだけ骨を入れる（事前チェックは無料）      有料
//   animate   idle / walk / jump / cheer を1本ずつ当てて1ファイルにまとめる  有料
//   optimize  Web 向けに軽くする                                          無料
//   register  character.json と index.json に登録してゲームから読めるようにする
import { copyFile, mkdir, access, readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import sharp from "sharp";
import { ROOT, CHAR_DIR, charPaths } from "./lib/paths.mjs";
import { loadPipeline, savePipeline, readJson, writeJson } from "./lib/state.mjs";
import { logFailure } from "./lib/guard.mjs";
import { optimizeGlb, makeIO, mergeAnimations } from "./lib/optimize.mjs";
import { removeSideLines } from "./lib/line-cleanup.mjs";
import { addProceduralClip } from "./lib/procedural-clips.mjs";
import { buildToonCharacter, buildFaceSheet } from "./lib/toon-model.mjs";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import * as THREE from "three";
import { writeFile } from "node:fs/promises";

const exists = (p) => access(p).then(() => true, () => false);
const rel = (p) => relative(ROOT, p);
const now = () => new Date().toISOString();

export const DEFAULT_GENERATION = {
  modelVersion: "v3.1-20260211",
  texture: true, pbr: false, textureQuality: "standard",
  faceLimit: 20000,
  multiview: false,
  rigType: "biped", rigVersion: "v1.0-20240301",
  // 状態 → Tripo のプリセット（rig v1.0 biped の一覧から）。1タスク最大5本
  animations: { IDLE: "preset:biped:idle", WALK: "preset:biped:walk", JUMP: "preset:biped:jump", HAPPY: "preset:biped:cheer" },
};

export async function init({ id, name, source }) {
  const P = charPaths(id);
  const ext = extname(source).toLowerCase();
  const dest = join(P.source, `front${ext}`);
  if (await exists(dest)) console.log(`元画像はもうあります（上書きしません）: ${rel(dest)}`);
  else { await mkdir(P.source, { recursive: true }); await copyFile(source, dest); console.log(`元画像を置きました: ${rel(dest)}`); }
  let cfg = await readJson(P.config, null);
  if (!cfg) {
    cfg = {
      characterId: id, name: name || id, version: 0,
      sourceImage: rel(dest),
      model: null, animations: {},
      scale: 1, position: [0, 0, 0], rotation: [0, 0, 0],
      sockets: {},
      generation: DEFAULT_GENERATION,
      optimize: { maxTextureSize: 1024, maxTriangles: 15000, sideLines: { keepFacing: 0.8 } },
      createdAt: now(), updatedAt: now(),
    };
    await writeJson(P.config, cfg);
    console.log(`設定を作りました: ${rel(P.config)}`);
  }
  const p = await loadPipeline(P); p.stage ??= "initialized"; await savePipeline(P, p);
  return cfg;
}

async function loadCfg(P) {
  const cfg = await readJson(P.config, null);
  if (!cfg) throw new Error(`${rel(P.config)} がありません。先に init してください`);
  cfg.generation = { ...DEFAULT_GENERATION, ...cfg.generation };
  return cfg;
}

export async function prepare({ id }) {
  const P = charPaths(id), cfg = await loadCfg(P);
  // 3D化に渡す絵は generation.inputImage で差し替えられる（例: 輪郭線を消した版）。正（Source of Truth）は sourceImage のまま
  const src = join(ROOT, cfg.generation.inputImage || cfg.sourceImage);
  const out = join(P.source, "input.png");   // 派生物。front.* は触らない
  const t = await sharp(src).ensureAlpha().trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  const side = Math.round(Math.max(t.info.width, t.info.height) * 1.15);
  const img = await sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: t.data, left: Math.round((side - t.info.width) / 2), top: Math.round((side - t.info.height) / 2) }])
    .png().toBuffer();
  const size = Math.min(1024, Math.max(side, 512));   // 公式推奨は 256px 以上。拡大しすぎず、1024 で頭打ち
  await sharp(img).resize(size, size, { kernel: "lanczos3" }).png().toFile(out);
  const p = await loadPipeline(P); p.stage = "prepared"; p.input = rel(out); await savePipeline(P, p);
  console.log(`入力画像: ${rel(out)}（${size}x${size}、元 ${t.info.width}x${t.info.height}）`);
}

/** 有料タスクを1つ流す共通処理。作った瞬間に taskId を保存し、再実行時は作らずに待つだけにする */
const RECREATABLE = ["failed", "banned", "expired", "cancelled", "unknown", "create_failed"];
async function runPaidTask({ P, p, guard, provider, slot, plan, start, estimate, allowRecreate = false }) {
  const existing = p.tasks[slot];
  if (existing?.status === "creating" && !allowRecreate) {
    // 前回、作成の POST を送ったが返事を受け取れなかった。Tripo 側ではできているかもしれない
    throw new Error(`${slot}: 前回タスク作成の返事を受け取れずに終わっています（${existing.startedAt}）。Tripo 側にタスクがあるかもしれません。
  → https://platform.tripo3d.ai でタスクを確認し、あれば: npm run character -- adopt ${P.id} --slot ${slot} --task <taskId>
  → 無いと確認できたら: 同じコマンドに --allow-recreate を付けて再実行（有料）`);
  }
  if (existing && existing.status !== "creating" && !RECREATABLE.includes(existing.status)) {
    if (existing.status === "success") return existing;
    console.log(`前回作ったタスク ${existing.taskId} の結果を待ちます（新しく作りません）`);
  } else {
    if (existing) console.log(`前回のタスクは ${existing.status} でした（ログ参照）。人の確認のうえで作り直します`);
    if (!(await guard.approve(plan))) return null;
    // POST の前に「作成中」を残す。返事の前に落ちても、次回むやみに作り直さない（二重課金を防ぐ）
    p.tasks[slot] = { status: "creating", startedAt: now(), estimate };
    await savePipeline(P, p);
    let taskId;
    try { taskId = await start(); }
    catch (e) {
      // HTTP の返事があった失敗 = 作られていない。返事が無い失敗（通信断など）= 作られたか分からないので「作成中」のまま
      if (e.status) { p.tasks[slot] = { status: "create_failed", error: String(e.message).slice(0, 300), at: now() }; await savePipeline(P, p); }
      const log = await logFailure(P.id, slot, e);
      console.error(`✗ タスクを作れませんでした。自動では再実行しません。ログ: ${rel(log)}`);
      throw e;
    }
    p.tasks[slot] = { taskId, status: "queued", createdAt: now(), estimate };
    guard.charge(estimate);
    await savePipeline(P, p);
    console.log(`タスクを作りました: ${taskId}`);
  }
  const rec = p.tasks[slot];
  const r = await provider.waitTask(rec.taskId, { onProgress: (s, pr) => process.stdout.write(`\r  ${slot}: ${s} ${pr ?? ""}%   `) });
  process.stdout.write("\n");
  rec.status = r.status; rec.finishedAt = now(); rec.consumedCredits = r.consumedCredits;
  if (r.consumedCredits) { p.credits.spent += r.consumedCredits; p.credits.log.push({ slot, taskId: rec.taskId, credits: r.consumedCredits, at: now() }); }
  rec.output = r.output;
  await savePipeline(P, p);
  if (r.status !== "success") {
    const log = await logFailure(P.id, slot, `task ${rec.taskId} status=${r.status}`, { raw: r.raw });
    throw new Error(`${slot} が ${r.status} で終わりました（失敗時のクレジットは返金される仕様）。自動では再実行しません。ログ: ${rel(log)}`);
  }
  return rec;
}

function resetDownstream(p) {
  // 新しい候補・別の候補の採用に切り替えたら、前の候補から作った骨・アニメ・最適化は使えない
  for (const k of Object.keys(p.tasks)) if (["prerigcheck", "rig", "retarget"].includes(k.split(":")[0])) delete p.tasks[k];
  delete p.retargetFiles; delete p.animatedFile; delete p.animatedFrom; delete p.requestedAnimations; delete p.optimized;
}

export async function generate({ id, guard, provider, newCandidate = false, allowRecreate = false }) {
  const P = charPaths(id), cfg = await loadCfg(P), g = cfg.generation;
  const p = await loadPipeline(P);
  if (p.review?.decision === "approved" && !newCandidate) {
    console.log(`採用済みのモデル（${p.review.taskId}）があります。作り直すなら --new を付けてください`); return;
  }
  const pending = p.candidates.find((c) => !c.decision);
  if (pending && !newCandidate) {
    console.log(`まだ確認していない候補があります: ${pending.taskId}\n→ npm run character:review -- ${id}`); return;
  }
  if (newCandidate && p.tasks.model?.status === "success") { resetDownstream(p); p.tasks = {}; p.review = null; }
  if (!p.input) throw new Error("入力画像がありません。先に prepare してください");

  let file;
  const opts = { modelVersion: g.modelVersion, texture: g.texture, pbr: g.pbr, textureQuality: g.textureQuality, geometryQuality: "standard" };
  if (g.multiview) {
    const est = provider.estimate("generate_multiview_image");
    file ??= await provider.uploadImage(join(ROOT, p.input));
    const mv = await runPaidTask({ P, p, guard, provider, allowRecreate, slot: "multiview", estimate: est,
      plan: { title: `${cfg.name}: 正面1枚 → 4視点画像（確認用に保存）`, items: [{ label: "generate_multiview_image", credits: est }] },
      start: () => provider.startGenerateMultiview({ file }) });
    if (!mv) return;
    for (const v of ["front", "left", "back", "right"]) await provider.downloadOutput(mv.taskId, `generate_multiview_image.${v}_view_url`, join(P.multiview, `${mv.taskId}_${v}.png`));
    console.log(`4視点画像: ${rel(P.multiview)}（正面がSource of Truth。顔や服が変わっていないか目で確認）`);
  }
  const op = g.multiview ? "multiview_to_model" : "image_to_model";
  const est = provider.estimate(op, opts);
  const rec = await runPaidTask({ P, p, guard, provider, allowRecreate, slot: "model", estimate: est,
    plan: { title: `${cfg.name}: ${g.multiview ? "4視点" : "正面画像"} → 3Dモデル候補 1体`, items: [{ label: `${op} ${g.modelVersion} テクスチャ=${g.textureQuality} 面数上限=${g.faceLimit}`, credits: est }] },
    start: async () => {
      if (g.multiview) return provider.startMultiviewToModel({ originalTaskId: p.tasks.multiview.taskId, ...opts, faceLimit: g.faceLimit });
      const f = await provider.uploadImage(join(ROOT, p.input));
      return provider.startImageToModel({ file: f, ...opts, faceLimit: g.faceLimit });
    } });
  if (!rec) return;
  const dest = join(P.models, `${rec.taskId}.glb`);
  if (!(await exists(dest))) await provider.downloadOutput(rec.taskId, rec.output.pbr_model ? "pbr_model" : "model", dest);
  if (rec.output.rendered_image && !(await exists(join(P.models, `${rec.taskId}.webp`)))) {
    await provider.downloadOutput(rec.taskId, "rendered_image", join(P.models, `${rec.taskId}.webp`)).catch(() => {});
  }
  const preview = await makeReviewPreview(cfg, dest, rec.taskId);
  if (!p.candidates.some((c) => c.taskId === rec.taskId)) p.candidates.push({ taskId: rec.taskId, file: rel(dest), preview, createdAt: now(), decision: null });
  p.stage = "generated";
  await savePipeline(P, p);
  console.log(`\n3Dモデル候補: ${rel(dest)}\n★ ここで止まります。人が確認してください → npm run character:review -- ${id}`);
}

/** 確認画面用に、ゲームに載るときと同じ「横の線を消した」版を作る（無料・ローカル） */
async function makeReviewPreview(cfg, file, taskId) {
  if (taskId.startsWith("mock-") || cfg.optimize?.sideLines === false) return null;
  const io = await makeIO();
  const doc = await io.read(file);
  await removeSideLines(doc, { forward: [1, 0, 0], ...(cfg.optimize?.sideLines || {}) });
  const out = file.replace(/\.glb$/, "_preview.glb");
  await io.write(out, doc);
  return rel(out);
}

/**
 * どうぶつの森風の体で作る（Tripo のメッシュは使わない・無料）。
 * AI のメッシュは表面がデコボコで比率も崩れるので、元絵の比率どおりに単純な形から作り、骨・顔シート・動きを付ける。
 */
export async function toon({ id }) {
  const P = charPaths(id), cfg = await loadCfg(P), p = await loadPipeline(P);
  const built = buildToonCharacter();
  // 顔シート（頭と一緒に動くよう、重み Head のスキン）
  const face = cfg.face;
  if (face) {
    const g = buildFaceSheet(built, { rect: face.rect });
    const n = g.attributes.position.count, bi = built.skeleton.bones.findIndex((b) => b.name === "Head");
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(n).fill(0).flatMap(() => [bi, 0, 0, 0]), 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [1, 0, 0, 0]), 4));
    const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ name: "FacePatch", transparent: true, opacity: 0 }));
    m.name = "FacePatch"; m.userData.faceRect = face.rect; m.bind(built.skeleton); built.root.add(m);
  }
  const scene = new THREE.Scene(); scene.add(built.root);
  const glb = Buffer.from(await new GLTFExporter().parseAsync(scene, { binary: true }));
  const out = join(P.animations, "toon.glb");
  await mkdir(P.animations, { recursive: true });
  await writeFile(out, glb);
  // 動き（どうぶつの森風のレシピ）と、顔シートのダミーテクスチャ（UV を残すため）
  const io = await makeIO();
  const doc = await io.read(out);
  const states = cfg.generation.proceduralAnimations || { IDLE: "idle", WALK: "walk", JUMP: "jump", HAPPY: "happy", DANCE: "dance", SLEEP: "sleep", EAT: "eat" };
  for (const name of Object.values(states)) addProceduralClip(doc, name, { forward: [0, 0, 1], up: [0, 1, 0] });
  const fm = doc.getRoot().listMaterials().find((m) => m.getName() === "FacePatch");
  if (fm) fm.setAlphaMode("BLEND").setBaseColorFactor([1, 1, 1, 0]).setBaseColorTexture(doc.createTexture("FacePatch").setMimeType("image/png").setImage(await placeholderPng()));
  await io.write(out, doc);
  p.animatedFile = rel(out); p.stage = "animated"; p.body = "toon";
  p.requestedAnimations = Object.fromEntries(Object.entries(states).map(([s, n]) => [s, `local:${n}`]));
  p.animatedFrom = { model: p.review?.taskId || "toon", rig: "toon", retarget: "procedural" };
  await savePipeline(P, p);
  console.log(`どうぶつの森風の体: ${rel(out)}（メッシュ ${built.meshes.length}・動き ${Object.keys(states).length}本）`);
}
async function placeholderPng() {
  return new Uint8Array(await sharp(Buffer.from([255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 0]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer());
}

/** 既にある候補の確認用プレビューを作り直す（線の消し方を調整したとき） */
export async function preview({ id }) {
  const P = charPaths(id), cfg = await loadCfg(P), p = await loadPipeline(P);
  for (const c of p.candidates) {
    if (c.taskId.startsWith("mock-")) continue;
    c.preview = await makeReviewPreview(cfg, join(ROOT, c.file), c.taskId);
    console.log(`確認用プレビュー: ${c.preview}`);
  }
  await savePipeline(P, p);
}

export async function decide({ id, taskId, decision, note = "", reviewer = process.env.USER || "human" }) {
  const P = charPaths(id), p = await loadPipeline(P);
  const c = taskId ? p.candidates.find((x) => x.taskId === taskId) : p.candidates.findLast((x) => !x.decision) || p.candidates.at(-1);
  if (!c) throw new Error("確認する候補がありません");
  if (!["approved", "rejected"].includes(decision)) throw new Error("decision は approved / rejected");
  c.decision = decision; c.note = note; c.reviewer = reviewer; c.decidedAt = now();
  if (decision === "approved") {
    if (p.review && p.review.taskId !== c.taskId) resetDownstream(p);
    p.review = { taskId: c.taskId, decision, note, reviewer, at: c.decidedAt }; p.stage = "approved";
  }
  else if (p.review?.taskId === c.taskId) { resetDownstream(p); p.review = null; p.stage = "rejected"; }
  else p.stage = p.review ? p.stage : "rejected";
  await savePipeline(P, p);
  console.log(`${c.taskId} を ${decision === "approved" ? "採用（Approve）" : "不採用（Reject）"} にしました${note ? `: ${note}` : ""}`);
  return c;
}

function requireApproved(p, id) {
  if (p.review?.decision !== "approved") throw new Error(`採用（Approve）されたモデルがありません。リグ・アニメは Approve の後だけ流せます → npm run character:review -- ${id}`);
  // 採用したモデルと、tasks.model が同じものかを確認（別の候補に骨を入れない）
  if (p.tasks.model?.taskId !== p.review.taskId) throw new Error(`採用したモデル ${p.review.taskId} と最新の生成タスクが違います。status で確認してください`);
}

export async function rig({ id, guard, provider, force = false, allowRecreate = false }) {
  const P = charPaths(id), cfg = await loadCfg(P), g = cfg.generation, p = await loadPipeline(P);
  requireApproved(p, id);
  if (p.tasks.rig?.status === "success") { console.log("リグ済みです"); return; }
  const modelTaskId = p.review.taskId;
  // 事前チェックは無料（公式）。false でも「できない」とは限らない（公式）ので、止めて人に判断を返す
  const chk = await runPaidTask({ P, p, guard, provider, allowRecreate, slot: "prerigcheck", estimate: 0,
    plan: { title: `${cfg.name}: 骨を入れられるかの事前チェック`, items: [{ label: "animate_prerigcheck", credits: provider.estimate("animate_prerigcheck") }] },
    start: () => provider.startPrerigCheck({ modelTaskId }) });
  if (!chk) return;
  console.log(`事前チェック: riggable=${chk.output.riggable} rig_type=${chk.output.rig_type}`);
  if (!chk.output.riggable && !force) { console.log("骨を入れられない判定です。モデルを見直すか、--force で試してください（有料）"); return; }
  const est = provider.estimate("animate_rig");
  const rec = await runPaidTask({ P, p, guard, provider, allowRecreate, slot: "rig", estimate: est,
    plan: { title: `${cfg.name}: 骨（リグ）を入れる`, items: [{ label: `animate_rig ${g.rigType} ${g.rigVersion} spec=tripo`, credits: est }] },
    start: () => provider.startRig({ modelTaskId, rigType: chk.output.rig_type || g.rigType, modelVersion: g.rigVersion }) });
  if (!rec) return;
  await provider.downloadOutput(rec.taskId, "model", join(P.animations, `${rec.taskId}_rigged.glb`));
  p.stage = "rigged"; await savePipeline(P, p);
  console.log(`リグ済みモデル: ${rel(join(P.animations, `${rec.taskId}_rigged.glb`))}`);
}

async function checkRetarget(file, firstFile) {
  const io = await makeIO();
  const doc = await io.read(file);
  const anims = doc.getRoot().listAnimations();
  if (anims.length !== 1) throw new Error(`${rel(file)}: アニメが ${anims.length} 本（1本のはず）。ここで止めます（残りの動きは頼んでいません）`);
  if (file === firstFile) return;
  const first = new Set((await io.read(firstFile)).getRoot().listNodes().map((n) => n.getName()));
  const missing = anims[0].listChannels().map((c) => c.getTargetNode()?.getName()).filter((n) => !first.has(n));
  if (missing.length) throw new Error(`${rel(file)}: 1本目に無い骨 ${[...new Set(missing)].slice(0, 5).join(", ")}。ここで止めます`);
}

// 動きを全部手元で作る（既定）。Tripo のプリセットは人間のモーションキャプチャで、三頭身だとフニャフニャになり、
// 手首も丸まる。なので骨（リグ）だけ Tripo に入れてもらい、動きは「どうぶつの森」風のレシピから作る（無料）
async function animateProcedural({ P, cfg, p }) {
  const g = cfg.generation;
  const states = g.proceduralAnimations || { IDLE: "idle", WALK: "walk", JUMP: "jump", HAPPY: "happy", DANCE: "dance", SLEEP: "sleep", EAT: "eat" };
  const rigged = join(P.animations, `${p.tasks.rig.taskId}_rigged.glb`);
  const out = join(P.animations, `${p.tasks.rig.taskId}_procedural.glb`);
  const io = await makeIO();
  const doc = await io.read(rigged);
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  for (const name of Object.values(states)) addProceduralClip(doc, name, { forward: [1, 0, 0], up: [0, 1, 0] });
  await io.write(out, doc);
  p.animatedFile = rel(out); p.stage = "animated";
  p.requestedAnimations = Object.fromEntries(Object.entries(states).map(([s, n]) => [s, `local:${n}`]));
  p.animatedFrom = { model: p.review.taskId, rig: p.tasks.rig.taskId, retarget: "procedural" };
  await savePipeline(P, p);
  console.log(`動き（手元で作成・${Object.keys(states).length}本）: ${rel(out)}`);
}

// Tripo の retarget は animations に複数入れても、返ってくる GLB には最後の1本しか入っていなかった
// （2026-09-29 実測。4本ぶん 40 クレジット消費して cheer だけ）。なので1タスク1本で頼み、手元で1ファイルにまとめる
export async function animate({ id, guard, provider, allowRecreate = false }) {
  const P = charPaths(id), cfg = await loadCfg(P), g = cfg.generation, p = await loadPipeline(P);
  requireApproved(p, id);
  if (p.tasks.rig?.status !== "success") throw new Error("先に rig してください");
  if ((g.motion || "procedural") === "procedural") return animateProcedural({ P, cfg, p });
  // 旧方式（まとめて1タスク）の結果は、実際に入っていた最後の1本として引き継ぐ（作り直さない）
  const states = Object.keys(g.animations);
  if (p.tasks.retarget && !p.tasks[`retarget:${states.at(-1)}`] && p.tasks.retarget.status === "success") {
    p.tasks[`retarget:${states.at(-1)}`] = { ...p.tasks.retarget, note: "まとめて頼んだタスク。中身は最後の1本だけ" };
    p.retargetFiles ??= {};
    if (p.animatedFile) p.retargetFiles[states.at(-1)] = p.animatedFile;
    delete p.tasks.retarget;
    await savePipeline(P, p);
  }
  p.retargetFiles ??= {};
  for (const state of states) {
    const anim = g.animations[state], slot = `retarget:${state}`;
    const est = provider.estimate("animate_retarget", { animations: [anim] });
    const rec = await runPaidTask({ P, p, guard, provider, allowRecreate, slot, estimate: est,
      plan: { title: `${cfg.name}: 動き「${state}」を当てる`, items: [{ label: `animate_retarget ${anim}`, credits: est }] },
      start: () => provider.startRetarget({ rigTaskId: p.tasks.rig.taskId, animations: [anim] }) });
    if (!rec) return;
    const dest = join(ROOT, p.retargetFiles[state] || rel(join(P.animations, `${rec.taskId}_${state.toLowerCase()}.glb`)));
    if (!(await exists(dest))) await provider.downloadOutput(rec.taskId, "model", dest);
    p.retargetFiles[state] = rel(dest);
    await savePipeline(P, p);
    // 次の有料タスクを頼む前に中身を確かめる（1本だけ入っているか・骨が1本目と同じか）。おかしければここで止める
    await checkRetarget(dest, join(ROOT, p.retargetFiles[states[0]]));
  }
  // 1つの GLB にまとめる。クリップ名はプリセット名（idle / walk / jump / cheer）にしておく
  const merged = join(P.animations, `${p.tasks.rig.taskId}_merged.glb`);
  const names = Object.fromEntries(states.map((s) => [s, g.animations[s].replace(/^preset:(biped:)?/, "")]));
  await mergeAnimations(states.map((s) => ({ file: join(ROOT, p.retargetFiles[s]), name: names[s] })), merged);
  // Tripo に無い動き（寝る・食べる）は、idle を土台に手元で作って足す（無料）
  const local = g.localAnimations || {};
  if (Object.keys(local).length) {
    const io = await makeIO();
    const doc = await io.read(merged);
    for (const name of Object.values(local)) addProceduralClip(doc, name, { forward: [1, 0, 0], up: [0, 1, 0], baseClip: names.IDLE || "idle" });
    await io.write(merged, doc);
  }
  p.animatedFile = rel(merged); p.stage = "animated";
  p.requestedAnimations = { ...g.animations, ...Object.fromEntries(Object.entries(local).map(([s, n]) => [s, `local:${n}`])) };
  p.animatedFrom = { model: p.review.taskId, rig: p.tasks.rig.taskId, retarget: states.map((s) => p.tasks[`retarget:${s}`].taskId) };
  await savePipeline(P, p);
  console.log(`アニメ付きモデル（${states.length}本をまとめた）: ${rel(merged)}`);
}

export async function optimize({ id }) {
  const P = charPaths(id), cfg = await loadCfg(P), p = await loadPipeline(P);
  if (!p.animatedFile) throw new Error("先に animate してください");
  if (p.body !== "toon" && p.animatedFrom?.model !== p.review?.taskId) throw new Error(`アニメ付きモデルは採用中のモデル（${p.review?.taskId}）から作られたものではありません。rig / animate からやり直してください`);
  const out = join(P.optimized, `${id}.glb`);
  await mkdir(P.optimized, { recursive: true });
  // Tripo の出力は +X 正面。mock は +Z 正面で作ってある
  const isMock = String(p.animatedFrom?.model || "").startsWith("mock-") || p.body === "toon";   // 手元で作った体は +Z 正面・テクスチャなし
  const rotateYDeg = cfg.optimize.rotateYDeg ?? (isMock ? 0 : -90);
  const sideLines = cfg.optimize.sideLines === false || isMock ? null : { forward: [1, 0, 0], ...(cfg.optimize.sideLines || {}) };
  // 表情（顔シート）は character.json の face があり、Tripo のモデルのときだけ
  const face = !isMock && cfg.face ? cfg.face : null;
  const r = await optimizeGlb({ input: join(ROOT, p.animatedFile), output: out, wanted: p.requestedAnimations, ...cfg.optimize, rotateYDeg, sideLines, face });
  const { size } = await import("node:fs/promises").then((m) => m.stat(out));
  p.optimized = { from: p.animatedFrom, file: rel(out), bytes: size, before: r.before, after: r.after, clipMap: r.clipMap, headBone: r.headBone, at: now() };
  p.stage = "optimized"; await savePipeline(P, p);
  if (r.face) console.log(`表情用の顔シート: ${r.face.triangles}三角形・焼き込みの顔を ${r.face.erased}画素 消去・顔の頂点 ${r.face.smoothed} をならした`);
  console.log(`最適化: ${rel(out)} ${(size / 1024).toFixed(0)}KB  三角形 ${r.before.triangles}→${r.after.triangles}  テクスチャ ${JSON.stringify(r.after.textures.map((t) => t.size))}  クリップ ${JSON.stringify(r.clipMap)}  頭の骨 ${r.headBone}`);
}

export async function register({ id }) {
  const P = charPaths(id), cfg = await loadCfg(P), p = await loadPipeline(P);
  if (!p.optimized) throw new Error("先に optimize してください");
  if (p.body !== "toon" && p.optimized.from?.model !== p.review?.taskId) throw new Error("最適化済みモデルが採用中のモデルと合いません。optimize からやり直してください");
  cfg.model = p.optimized.file;
  cfg.animations = p.optimized.clipMap;
  if (p.optimized.headBone) cfg.sockets.head = { ...(cfg.sockets.head || {}), bone: p.optimized.headBone };
  cfg.version = (cfg.version || 0) + 1;
  cfg.shading = p.body === "toon" ? "toon" : "standard";
  cfg.provenance = { body: p.body || "tripo", provider: p.tasks.model?.taskId?.startsWith("mock-") ? "mock" : "tripo", modelTask: p.review.taskId, rigTask: p.tasks.rig?.taskId, retargetTask: p.tasks.retarget?.taskId, approvedBy: p.review.reviewer, approvedAt: p.review.at };
  cfg.updatedAt = now();
  await writeJson(P.config, cfg);
  const idxPath = join(CHAR_DIR, "index.json");
  const idx = await readJson(idxPath, { characters: [] });
  const entry = { id, config: rel(P.config), version: cfg.version, provider: cfg.provenance.provider };
  idx.characters = idx.characters.filter((c) => c.id !== id).concat(entry);
  idx.default ??= id;
  await writeJson(idxPath, idx);
  p.stage = "registered"; await savePipeline(P, p);
  console.log(`ゲームに登録しました: ${rel(idxPath)} ← ${id} v${cfg.version}（${entry.provider}）`);
}

/** 作成の返事を受け取れなかったタスクを、Tripo 側で見つけたIDで引き取る（作り直さない） */
export async function adopt({ id, slot, taskId }) {
  if (!["multiview", "model", "prerigcheck", "rig", "retarget"].includes(String(slot).split(":")[0])) throw new Error("--slot は multiview / model / prerigcheck / rig / retarget:<状態>（例 retarget:WALK）");
  if (!taskId) throw new Error("--task <taskId> が必要です");
  const P = charPaths(id), p = await loadPipeline(P);
  p.tasks[slot] = { taskId, status: "queued", adoptedAt: now() };
  await savePipeline(P, p);
  console.log(`${slot} に ${taskId} を引き取りました。同じコマンド（build など）を流すと結果を取りに行きます`);
}

export async function status({ id }) {
  const P = charPaths(id), p = await loadPipeline(P);
  console.log(JSON.stringify({ stage: p.stage, review: p.review, candidates: p.candidates, tasks: Object.fromEntries(Object.entries(p.tasks).map(([k, v]) => [k, { taskId: v.taskId, status: v.status, credits: v.consumedCredits }])), creditsSpent: p.credits.spent, optimized: p.optimized && { file: p.optimized.file, bytes: p.optimized.bytes, tris: p.optimized.after.triangles } }, null, 2));
}

export { logFailure };
