// TripoProvider インターフェース。
// 高レベルの操作だけを持つ（createTask の生JSONはプロバイダの中に閉じ込める）。
// 有料の操作は「タスクを作る」と「結果を待つ」を分けてある。作ったら即 taskId を保存 → 待つ、の順にするため。
//
//   name, paid                         : 表示用 / 有料かどうか
//   getBalance()                       → { balance, frozen }
//   estimate(op, opts)                 → クレジット（料金表に無ければ null）
//   uploadImage(path)                  → file（タスク入力に渡す値）
//   startGenerateMultiview({ file })   → taskId           [有料]
//   startImageToModel({ file, ... })   → taskId           [有料]
//   startMultiviewToModel({ files | originalTaskId, ... }) → taskId [有料]
//   startPrerigCheck({ modelTaskId })  → taskId           [無料]
//   startRig({ modelTaskId, ... })     → taskId           [有料]
//   startRetarget({ rigTaskId, animations: string[] }) → taskId [有料・1タスク最大5本]
//   waitTask(taskId, { timeoutMs })    → { status, output, consumedCredits }   [無料・待つだけ]
//   downloadOutput(taskId, key, dest)  → dest            [無料。URLが切れていたらタスクを引き直す]
export const RETARGET_MAX_PER_TASK = 5;

export class ProviderError extends Error {
  constructor(msg, { code, status, taskId, body } = {}) { super(msg); this.code = code; this.status = status; this.taskId = taskId; this.body = body; }
}
