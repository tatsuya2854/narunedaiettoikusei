// pipeline.json の読み書き。有料タスクは「作成した瞬間」にIDを保存する。
// 待機中に落ちても、次回は同じタスクの結果を取りに行くだけで、二重に作らない（＝クレジットを二重に使わない）。
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const STAGES = ["prepared", "generated", "approved", "rejected", "rigged", "animated", "optimized", "registered"];

export async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}
export async function writeJson(p, data) {
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, p);   // 途中で落ちても壊れたJSONを残さない
}

export async function loadPipeline(paths) {
  return readJson(paths.pipeline, { characterId: paths.id, stage: null, tasks: {}, candidates: [], review: null, credits: { spent: 0, log: [] } });
}
export async function savePipeline(paths, p) {
  p.updatedAt = new Date().toISOString();
  // 出力のダウンロードURL（署名付き・数分で切れる）は残さない。公開リポジトリに載るため。必要なときはタスクを引き直す
  for (const t of Object.values(p.tasks || {})) {
    for (const [k, v] of Object.entries(t.output || {})) if (typeof v === "string" && /^https?:/.test(v)) t.output[k] = "(url)";
  }
  await writeJson(paths.pipeline, p);
}
