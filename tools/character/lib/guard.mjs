// クレジット保護。有料の処理は必ずここを通す。
//  ・実行前に「何を・何回・見積もり何クレジット・今の残高」を表示する
//  ・1回の実行で使ってよい上限（--max-credits / CHARACTER_MAX_CREDITS）を超える計画は始めない
//  ・人の確認（y を入力、または --yes）が無ければ始めない
//  ・有料APIは自動リトライしない（失敗したらログを残して止まる）
import { createInterface } from "node:readline/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "./paths.mjs";

export const DEFAULT_MAX_CREDITS = 150;

export class CreditGuard {
  constructor({ provider, maxCredits, assumeYes = false, dryRun = false, interactive = process.stdin.isTTY }) {
    this.provider = provider;
    this.max = Number.isFinite(maxCredits) ? maxCredits : DEFAULT_MAX_CREDITS;
    this.assumeYes = assumeYes;
    this.dryRun = dryRun;
    this.interactive = interactive;
    this.spentThisRun = 0;
  }

  /**
   * @param {{title:string, items:{op:string, label:string, credits:number|null}[]}} plan
   * @returns {Promise<boolean>} 実行してよければ true
   */
  async approve(plan) {
    const est = plan.items.reduce((s, i) => s + (i.credits ?? NaN), 0);
    const bal = await this.provider.getBalance().catch((e) => ({ error: e.message }));
    const lines = [
      "",
      "┌─ 有料処理の確認 ─────────────────────────────",
      `│ プロバイダ : ${this.provider.name}${this.provider.paid ? "" : "（無料・モック）"}`,
      `│ 処理       : ${plan.title}`,
      ...plan.items.map((i) => `│   - ${i.label}  … ${i.credits == null ? "見積もり不明" : `${i.credits} クレジット`}`),
      `│ 生成数     : ${plan.items.length} タスク`,
      `│ 見積もり計 : ${Number.isNaN(est) ? "不明（料金表に無い処理を含む）" : `${est} クレジット`}`,
      `│ 現在の残高 : ${bal.error ? `取得できず（${bal.error}）` : `${bal.balance}${bal.frozen ? `（保留中 ${bal.frozen}）` : ""}`}`,
      `│ 今回の上限 : ${this.max} クレジット（使用済み ${this.spentThisRun}）`,
      "└──────────────────────────────────────────────",
    ];
    console.log(lines.join("\n"));

    if (!this.provider.paid) return true;
    if (Number.isNaN(est)) { console.error("✗ 見積もりできない処理が含まれるので止めます（pricing を確認してから）"); return false; }
    if (this.spentThisRun + est > this.max) { console.error(`✗ 上限 ${this.max} を超えるので止めます（--max-credits で変えられます）`); return false; }
    if (!bal.error && typeof bal.balance === "number" && bal.balance < est) { console.error("✗ 残高が見積もりより少ないので止めます"); return false; }
    if (this.dryRun) { console.log("（--dry-run なので実行しません）"); return false; }
    if (this.assumeYes) return true;
    if (!this.interactive) { console.error("✗ 対話できない環境です。確認済みなら --yes を付けてください"); return false; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question("実行しますか？ [y/N] ")).trim().toLowerCase();
    rl.close();
    return a === "y" || a === "yes";
  }

  charge(credits) { this.spentThisRun += credits || 0; }
}

/** 失敗した有料処理のログ（原因を見てから人が再実行する） */
export async function logFailure(characterId, step, err, extra = {}) {
  await mkdir(LOG_DIR, { recursive: true });
  const rec = { at: new Date().toISOString(), characterId, step, error: String(err?.stack || err), ...extra };
  const p = join(LOG_DIR, `${characterId}.failures.jsonl`);
  await appendFile(p, JSON.stringify(rec) + "\n");
  return p;
}
