// Tripo API（v2 / https://api.tripo3d.ai/v2/openapi）プロバイダ。
// 仕様は公式ドキュメントの原文（2026-09-29 確認）に合わせてある:
//   https://platform.tripo3d.ai/docs/endpoint/{generation,task,upload,wallet,animation,generate-multiview-image}.md
//
// 守っていること:
//   ・APIキーは環境変数 TRIPO_API_KEY（.env）からだけ読む。ログにもエラーにも出さない
//   ・有料タスクを作る POST は自動リトライしない（1回だけ）
//   ・待つ（GET /task/:id）のは無料なので、通信エラーだけ回数を決めてやり直す
//   ・出力URLは数分で切れるので、成功したらすぐ落とす。403 ならタスクを引き直して新しいURLで取る
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { ProviderError, RETARGET_MAX_PER_TASK } from "./provider.mjs";

const BASE = "https://api.tripo3d.ai/v2/openapi";
const FINAL = new Set(["success", "failed", "banned", "expired", "cancelled", "unknown"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TripoApiProvider {
  constructor({ apiKey, pricing, fetchImpl = fetch, log = console.log }) {
    if (!apiKey) throw new Error("TRIPO_API_KEY がありません（.env に書くか、--provider mock を使ってください）");
    if (!/^tsk_/.test(apiKey)) throw new Error("TRIPO_API_KEY は tsk_ で始まるAPIキーを入れてください（tcli_ のクライアントIDは使えません）");
    this.name = "tripo-api(v2)";
    this.paid = true;
    this.pricing = pricing;
    this.fetch = fetchImpl;
    this.log = log;
    // キーはクロージャに閉じ込め、インスタンスのプロパティに置かない（うっかり JSON.stringify されないように）
    this._auth = () => ({ Authorization: `Bearer ${apiKey}` });
  }

  async _req(method, path, { json, form } = {}) {
    const headers = this._auth();
    let body;
    if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await this.fetch(`${BASE}${path}`, { method, headers, body });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    if (!res.ok || (data && typeof data.code === "number" && data.code !== 0)) {
      throw new ProviderError(`Tripo ${method} ${path} → HTTP ${res.status} code=${data?.code ?? "-"} ${data?.message || data?.raw || ""}`.trim(),
        { status: res.status, code: data?.code, body: data });
    }
    return data.data ?? data;
  }

  async getBalance() {
    const d = await this._req("GET", "/user/balance");
    return { balance: d.balance, frozen: d.frozen };
  }

  estimate(op, o = {}) {
    const P = this.pricing;
    switch (op) {
      case "image_to_model":
      case "multiview_to_model": {
        const table = String(o.modelVersion || "").startsWith("P1") ? P.image_to_model_P1 : P[op];
        const tex = o.texture === false && !o.pbr ? table.untextured : table.textured;
        return tex + (o.texture !== false ? P.texture_quality_addon[o.textureQuality || "standard"] ?? NaN : 0)
          + (P.geometry_quality_addon[o.geometryQuality || "standard"] ?? NaN);
      }
      case "generate_multiview_image": return P.generate_multiview_image;
      case "animate_prerigcheck": return P.animate_prerigcheck;
      case "animate_rig": return P.animate_rig;
      case "animate_retarget": return P.animate_retarget_per_animation * (o.animations?.length || 1);
      default: return null;
    }
  }

  async uploadImage(path) {
    const ext = extname(path).slice(1).toLowerCase().replace("jpg", "jpeg");
    const form = new FormData();
    form.append("file", new Blob([await readFile(path)], { type: `image/${ext}` }), basename(path));
    const d = await this._req("POST", "/upload/sts", { form });
    if (!d.image_token) throw new ProviderError("upload: image_token がありません", { body: d });
    return { type: ext === "jpeg" ? "jpg" : ext, file_token: d.image_token };
  }

  // --- 有料: タスクを作る（1回だけ。リトライしない） ---
  async _create(payload) {
    const d = await this._req("POST", "/task", { json: payload });
    if (!d.task_id) throw new ProviderError("task_id が返りませんでした", { body: d });
    return d.task_id;
  }

  startGenerateMultiview({ file }) { return this._create({ type: "generate_multiview_image", file }); }

  startImageToModel({ file, modelVersion, texture = true, pbr = false, textureQuality = "standard", faceLimit, orientation, seed }) {
    const p = { type: "image_to_model", file, model_version: modelVersion, texture, pbr, texture_quality: textureQuality,
      texture_alignment: "original_image" };
    if (faceLimit) p.face_limit = faceLimit;
    if (orientation) p.orientation = orientation;
    if (seed != null) p.model_seed = seed;
    return this._create(p);
  }

  startMultiviewToModel({ files, originalTaskId, modelVersion, texture = true, pbr = false, textureQuality = "standard", faceLimit }) {
    const p = { type: "multiview_to_model", model_version: modelVersion, texture, pbr, texture_quality: textureQuality };
    if (originalTaskId) p.original_task_id = originalTaskId; else p.files = files; // [front, left, back, right]
    if (faceLimit) p.face_limit = faceLimit;
    return this._create(p);
  }

  startPrerigCheck({ modelTaskId }) { return this._create({ type: "animate_prerigcheck", original_model_task_id: modelTaskId }); }

  startRig({ modelTaskId, rigType = "biped", modelVersion = "v1.0-20240301" }) {
    // retarget できるのは spec=tripo だけ（公式）。プリセットが多い（cheer 等）のは v1.0 biped
    return this._create({ type: "animate_rig", original_model_task_id: modelTaskId, out_format: "glb", rig_type: rigType, spec: "tripo", model_version: modelVersion });
  }

  startRetarget({ rigTaskId, animations }) {
    if (!animations?.length || animations.length > RETARGET_MAX_PER_TASK) throw new Error(`retarget は1タスク1〜${RETARGET_MAX_PER_TASK}本`);
    return this._create({ type: "animate_retarget", original_model_task_id: rigTaskId, out_format: "glb", animations,
      bake_animation: true, export_with_geometry: true, animate_in_place: true });
  }

  // --- 無料: 待つ・取る ---
  async getTask(taskId) { return this._req("GET", `/task/${encodeURIComponent(taskId)}`); }

  async waitTask(taskId, { timeoutMs = 15 * 60_000, intervalMs = 4000, onProgress } = {}) {
    const t0 = Date.now();
    let netErrors = 0, last = -1;
    for (;;) {
      let t;
      try { t = await this.getTask(taskId); netErrors = 0; }
      catch (e) {
        // 429 は Retry-After ぶん待つ。ネットワーク系は数回まで。いずれも「待つ」だけなのでクレジットは使わない
        if (e.status === 404 || e.status === 401 || e.status === 403) throw e;
        if (++netErrors > 5) throw e;
        await sleep(intervalMs * netErrors); continue;
      }
      if (t.progress !== last) { last = t.progress; onProgress?.(t.status, t.progress); }
      if (FINAL.has(t.status)) {
        return { status: t.status, output: t.output || {}, consumedCredits: t.consumed_credit ?? null, raw: t };
      }
      if (Date.now() - t0 > timeoutMs) throw new ProviderError(`待ち時間切れ（task ${taskId} はまだ ${t.status}）。あとで同じコマンドを流せば続きから待ちます`, { taskId });
      await sleep(intervalMs);
    }
  }

  async downloadOutput(taskId, key, dest) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = await this.getTask(taskId);          // 毎回引き直す＝URLが切れていても新しいものを使う
      const url = pick(t.output, key);
      if (!url) throw new ProviderError(`出力 ${key} がありません（task ${taskId}）`, { taskId, body: t.output });
      const res = await this.fetch(url);
      if (res.status === 403 && attempt < 2) continue;
      if (!res.ok) throw new ProviderError(`ダウンロード失敗 HTTP ${res.status}（task ${taskId} ${key}）`, { taskId, status: res.status });
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    }
  }
}

function pick(output, key) {
  if (!output) return null;
  if (key.includes(".")) return key.split(".").reduce((o, k) => o?.[k], output);
  return output[key];
}
