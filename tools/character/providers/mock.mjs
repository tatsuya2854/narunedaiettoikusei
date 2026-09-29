// MockTripoProvider — APIキーが無くても、クレジットを使わずにパイプライン全体を通すための偽物。
// Tripo API と同じ形（タスクを作る → 待つ → 落とす）で振る舞う。出力は手続き的に作った三頭身モデル。
// タスクはファイルに残すので、途中で止めて再開する流れも本物と同じように試せる。
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOG_DIR } from "../lib/paths.mjs";
import { buildMockGlb } from "../lib/mock-model.mjs";
import { ProviderError, RETARGET_MAX_PER_TASK } from "./provider.mjs";

const DB = join(LOG_DIR, "mock-tasks.json");
// Tripo のプリセット名 → モックのクリップ（無いものは近い動きで代用）
const PRESET = { idle: "idle", walk: "walk", run: "walk", jump: "jump", cheer: "happy", victory_celebration: "happy", clap: "happy" };

export class MockTripoProvider {
  constructor({ pricing, failOn = null } = {}) {
    this.name = "mock";
    this.paid = false;
    this.pricing = pricing;
    this.failOn = failOn;  // テスト用: この種類のタスクをわざと失敗させる
  }
  async _db() { try { return JSON.parse(await readFile(DB, "utf8")); } catch { return {}; } }
  async _put(t) { const db = await this._db(); db[t.task_id] = t; await mkdir(dirname(DB), { recursive: true }); await writeFile(DB, JSON.stringify(db, null, 2)); return t.task_id; }

  async getBalance() { return { balance: 99999, frozen: 0 }; }
  estimate(op, o = {}) {
    // 本物と同じ見積もりを表示する（モックでも「本番ならいくらか」が分かるように）
    const P = this.pricing;
    return { image_to_model: P.image_to_model.textured, multiview_to_model: P.multiview_to_model.textured,
      generate_multiview_image: P.generate_multiview_image, animate_prerigcheck: 0, animate_rig: P.animate_rig,
      animate_retarget: P.animate_retarget_per_animation * (o.animations?.length || 1) }[op] ?? null;
  }
  async uploadImage(path) { return { type: "png", file_token: `mock-${randomUUID()}`, _path: path }; }

  _new(type, input) {
    if (this.failOn === type) return this._put({ task_id: `mock-${randomUUID()}`, type, input, status: "failed", output: {} });
    return this._put({ task_id: `mock-${randomUUID()}`, type, input, status: "success", output: {} });
  }
  startGenerateMultiview({ file }) { return this._new("generate_multiview_image", { file }); }
  startImageToModel(o) { return this._new("image_to_model", o); }
  startMultiviewToModel(o) { return this._new("multiview_to_model", o); }
  startPrerigCheck({ modelTaskId }) { return this._new("animate_prerigcheck", { modelTaskId }); }
  startRig({ modelTaskId }) { return this._new("animate_rig", { modelTaskId }); }
  startRetarget({ rigTaskId, animations }) {
    if (!animations?.length || animations.length > RETARGET_MAX_PER_TASK) throw new Error(`retarget は1タスク1〜${RETARGET_MAX_PER_TASK}本`);
    return this._new("animate_retarget", { rigTaskId, animations });
  }

  async waitTask(taskId, { onProgress } = {}) {
    const t = (await this._db())[taskId];
    if (!t) throw new ProviderError(`mock: task ${taskId} がありません`, { status: 404, taskId });
    onProgress?.(t.status, 100);
    const output = {};
    if (t.status === "success") {
      if (t.type === "animate_prerigcheck") Object.assign(output, { riggable: true, rig_type: "biped" });
      else if (t.type === "generate_multiview_image") output.generate_multiview_image = { front_view_url: "mock", left_view_url: "mock", back_view_url: "mock", right_view_url: "mock" };
      else output.model = "mock://model";
    }
    return { status: t.status, output, consumedCredits: 0, raw: t };
  }

  async downloadOutput(taskId, key, dest) {
    const t = (await this._db())[taskId];
    if (!t || t.status !== "success") throw new ProviderError(`mock: ${taskId} は成功していません`, { taskId });
    await mkdir(dirname(dest), { recursive: true });
    if (t.type === "generate_multiview_image") { await copyFile(t.input.file._path, dest); return dest; }
    let buf;
    if (t.type === "image_to_model" || t.type === "multiview_to_model") buf = await buildMockGlb({ rigged: false });
    else if (t.type === "animate_rig") buf = await buildMockGlb({ rigged: true });
    else if (t.type === "animate_retarget") {
      const clips = t.input.animations.map((a) => PRESET[a.replace(/^preset:(biped:)?/, "")] || "idle");
      buf = await buildMockGlb({ rigged: true, clips });
      // 本物で「クリップ名がプリセット名どおりか」は未確認なので、モックはあえて汎用名にして取り込み側の対応付けを試す
      buf = renameClips(buf, clips.map((_, i) => `Animation_${i}`));
    } else throw new ProviderError(`mock: ${t.type} に出力はありません`);
    await writeFile(dest, buf);
    return dest;
  }
}

// GLB の JSON チャンク内のアニメ名だけ差し替える（長さが変わるので作り直す）
function renameClips(glb, names) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));
  (json.animations || []).forEach((a, i) => { a.name = names[i] ?? a.name; });
  let s = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (s.length % 4)) % 4; s = Buffer.concat([s, Buffer.alloc(pad, 0x20)]);
  const rest = glb.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + s.length + rest.length, 8);
  head.writeUInt32LE(s.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, s, rest]);
}
