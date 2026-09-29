// Tripo API v3（https://openapi.tripo3d.ai/v3）プロバイダ。--provider tripo の既定。
// v2 は 2026-11-01 に停止すると Tripo のコンソールに告知が出ている（2026-09-29 確認）。
// 仕様は公式ドキュメントの原文（2026-09-29 確認）に合わせてある:
//   https://developers.tripo3d.ai/en/docs/{files,generation-image-to-model/standard,animations-rig-check,animations-rig,animations-retarget,task-query,account}.md
//
// 守っていること（v2 と同じ）:
//   ・APIキーは TRIPO_API_KEY（.env）からだけ読む。ログにもエラーにも出さない
//   ・有料タスクを作る POST は自動リトライしない
//   ・待つ（GET /tasks/{id}）のは無料なので、通信エラーだけ回数を決めてやり直す
//   ・出力URLは短時間で切れるので、成功したらすぐ落とす。403 ならタスクを引き直す
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { ProviderError, RETARGET_MAX_PER_TASK } from "./provider.mjs";
import { TripoApiProvider } from "./tripo-api.mjs";

const BASE = "https://openapi.tripo3d.ai/v3";
const FINAL = new Set(["success", "failed", "cancelled", "banned", "expired", "unknown"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// パイプラインは v2 の出力名（model / rendered_image）で扱っているので、v3 の名前から読み替える
const OUT_KEY = { model: "model_url", pbr_model: "model_url", rendered_image: "rendered_image_url" };
// v3 のプリセット表記は preset:biped:<name>（rig v1.0）
const toV3Preset = (a) => (/^preset:biped:/.test(a) || !/^preset:/.test(a) ? a : a.replace(/^preset:/, "preset:biped:"));

export class TripoV3Provider {
  constructor({ apiKey, pricing, fetchImpl = fetch }) {
    if (!apiKey) throw new Error("TRIPO_API_KEY がありません（.env に書くか、--provider mock を使ってください）");
    if (!/^tsk_/.test(apiKey)) throw new Error("TRIPO_API_KEY は tsk_ で始まるAPIキーを入れてください（tcli_ のクライアントIDは使えません）");
    this.name = "tripo-api(v3)";
    this.paid = true;
    this.pricing = pricing;
    this.fetch = fetchImpl;
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
      throw new ProviderError(`Tripo ${method} ${path} → HTTP ${res.status} code=${data?.code ?? "-"} ${data?.message || data?.raw || ""} ${data?.suggestion || ""}`.trim(),
        { status: res.status, code: data?.code, body: data });
    }
    return data.data ?? data;
  }

  async getBalance() { const d = await this._req("GET", "/account/balance"); return { balance: d.balance, frozen: d.frozen }; }

  // 見積もりは料金表（tripo-pricing.json）から。v2 と同じ表を使う
  estimate(op, o) { return TripoApiProvider.prototype.estimate.call(this, op, o); }

  async uploadImage(path) {
    const ext = extname(path).slice(1).toLowerCase().replace("jpg", "jpeg");
    const form = new FormData();
    form.append("file", new Blob([await readFile(path)], { type: `image/${ext}` }), basename(path));
    const d = await this._req("POST", "/files", { form });
    if (!d.file_token) throw new ProviderError("upload: file_token がありません", { body: d });
    return d.file_token;
  }

  async _create(path, payload) {
    const d = await this._req("POST", path, { json: payload });
    if (!d.task_id) throw new ProviderError("task_id が返りませんでした", { body: d });
    return d.task_id;
  }

  startGenerateMultiview() { throw new Error("v3 の多視点生成はまだ実装していません（仕様を確認してから足す）。generation.multiview=false で使ってください"); }
  startMultiviewToModel() { return this.startGenerateMultiview(); }

  startImageToModel({ file, modelVersion, texture = true, pbr = false, textureQuality = "standard", faceLimit, orientation, seed }) {
    const p = { input: file, model: modelVersion, texture, pbr, texture_quality: textureQuality, texture_alignment: "original_image" };
    if (faceLimit) p.face_limit = faceLimit;
    if (orientation) p.orientation = orientation;
    if (seed != null) p.model_seed = seed;
    return this._create("/generation/image-to-model", p);
  }

  startPrerigCheck({ modelTaskId }) { return this._create("/animations/rig-check", { input: modelTaskId }); }

  startRig({ modelTaskId, rigType = "biped", modelVersion = "v1.0-20240301" }) {
    return this._create("/animations/rig", { input: modelTaskId, model: modelVersion, rig_type: rigType, spec: "tripo", out_format: "glb" });
  }

  startRetarget({ rigTaskId, animations }) {
    if (!animations?.length || animations.length > RETARGET_MAX_PER_TASK) throw new Error(`retarget は1タスク1〜${RETARGET_MAX_PER_TASK}本`);
    return this._create("/animations/retarget", { input: rigTaskId, animations: animations.map(toV3Preset), out_format: "glb",
      bake_animation: true, export_with_geometry: true, animate_in_place: true });
  }

  async getTask(taskId) { return this._req("GET", `/tasks/${encodeURIComponent(taskId)}`); }

  async waitTask(taskId, { timeoutMs = 15 * 60_000, intervalMs = 4000, onProgress } = {}) {
    const t0 = Date.now();
    let netErrors = 0, last = -1;
    for (;;) {
      let t;
      try { t = await this.getTask(taskId); netErrors = 0; }
      catch (e) {
        if (e.status === 404 || e.status === 401 || e.status === 403) throw e;
        if (++netErrors > 5) throw e;
        await sleep(intervalMs * netErrors); continue;
      }
      if (t.progress !== last) { last = t.progress; onProgress?.(t.status, t.progress); }
      if (FINAL.has(t.status)) {
        const out = { ...(t.output || {}) };
        for (const [k, v] of Object.entries(OUT_KEY)) if (out[v] && !out[k]) out[k] = out[v];
        if (t.status !== "success") out.error = { code: t.error_code, message: t.error_message };
        return { status: t.status, output: out, consumedCredits: t.credits_consumed ?? null, raw: t };
      }
      if (Date.now() - t0 > timeoutMs) throw new ProviderError(`待ち時間切れ（task ${taskId} はまだ ${t.status}）。あとで同じコマンドを流せば続きから待ちます`, { taskId });
      await sleep(intervalMs);
    }
  }

  async downloadOutput(taskId, key, dest) {
    const k = OUT_KEY[key] || key;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = await this.getTask(taskId);          // 毎回引き直す＝URLが切れていても新しいものを使う
      const url = t.output?.[k];
      if (!url) throw new ProviderError(`出力 ${k} がありません（task ${taskId}）`, { taskId, body: t.output });
      const res = await this.fetch(url);
      if (res.status === 403 && attempt < 2) continue;
      if (!res.ok) throw new ProviderError(`ダウンロード失敗 HTTP ${res.status}（task ${taskId} ${k}）`, { taskId, status: res.status });
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    }
  }
}
