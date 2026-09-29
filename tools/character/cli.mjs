#!/usr/bin/env node
// キャラクター3D化パイプラインの入口。1回の実行で扱うのは1キャラだけ。
//
//   npm run character:build  -- <id> [--provider mock|tripo] [--max-credits N] [--yes] [--dry-run]
//       prepare → generate → （Approve 待ちで止まる）→ rig → animate → optimize → register
//   npm run character:review -- <id>          ブラウザで元絵と3Dを並べて Approve / Reject
//   npm run character -- <command> <id> ...   段階ごとに流す（init / prepare / generate / approve / reject / rig / animate / optimize / register / status）
//
// 既定のプロバイダは mock（無料）。有料の Tripo を使うのは --provider tripo を付けたときだけ。
import { parseArgs } from "node:util";
import { loadEnv, createProvider } from "./providers/index.mjs";
import { CreditGuard, DEFAULT_MAX_CREDITS } from "./lib/guard.mjs";
import { charPaths } from "./lib/paths.mjs";
import { loadPipeline } from "./lib/state.mjs";
import * as pl from "./pipeline.mjs";

loadEnv();
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string" }, "max-credits": { type: "string" }, yes: { type: "boolean" }, "dry-run": { type: "boolean" },
    new: { type: "boolean" }, force: { type: "boolean" }, note: { type: "string" }, name: { type: "string" }, source: { type: "string" },
    task: { type: "string" }, port: { type: "string" }, slot: { type: "string" }, "allow-recreate": { type: "boolean" },
  },
});
const [cmd, id, ...rest] = positionals;
if (!cmd || (!id && cmd !== "help")) usage();
if (rest.length) { console.error(`1回の実行で扱えるのは1キャラだけです（余分な引数: ${rest.join(" ")}）`); process.exit(2); }
charPaths(id); // ID の形を先に確かめる

const maxCredits = Number(o["max-credits"] ?? process.env.CHARACTER_MAX_CREDITS ?? DEFAULT_MAX_CREDITS);
const ctx = () => {
  const provider = createProvider(o.provider);
  const guard = new CreditGuard({ provider, maxCredits, assumeYes: !!o.yes, dryRun: !!o["dry-run"] });
  return { id, provider, guard, allowRecreate: !!o["allow-recreate"] };
};

try {
  switch (cmd) {
    case "init": await pl.init({ id, name: o.name, source: o.source ?? need("--source <画像>") }); break;
    case "prepare": await pl.prepare({ id }); break;
    case "generate": await pl.generate({ ...ctx(), newCandidate: !!o.new }); break;
    case "review": { const { serveReview } = await import("./review-server.mjs"); await serveReview({ id, port: Number(o.port || 5178) }); break; }
    case "approve": await pl.decide({ id, taskId: o.task, decision: "approved", note: o.note }); break;
    case "reject": await pl.decide({ id, taskId: o.task, decision: "rejected", note: o.note }); break;
    case "rig": await pl.rig({ ...ctx(), force: !!o.force }); break;
    case "animate": await pl.animate(ctx()); break;
    case "optimize": await pl.optimize({ id }); break;
    case "register": await pl.register({ id }); break;
    case "status": await pl.status({ id }); break;
    case "adopt": await pl.adopt({ id, slot: o.slot, taskId: o.task }); break;
    case "build": await build(); break;
    default: usage();
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
}

async function build() {
  const c = ctx();
  const P = charPaths(id);
  let p = await loadPipeline(P);
  if (!p.input) await pl.prepare({ id });
  p = await loadPipeline(P);
  if (p.review?.decision !== "approved") {
    await pl.generate(c);
    p = await loadPipeline(P);
    if (p.review?.decision !== "approved") return;   // HUMAN CHECKPOINT。ここから先は Approve の後
  }
  if (p.tasks.rig?.status !== "success") { await pl.rig(c); p = await loadPipeline(P); if (p.tasks.rig?.status !== "success") return; }
  if (p.tasks.retarget?.status !== "success") { await pl.animate(c); p = await loadPipeline(P); if (p.tasks.retarget?.status !== "success") return; }
  await pl.optimize({ id });
  await pl.register({ id });
  console.log(`\n完了: ${id}（今回の実行で見積もり ${c.guard.spentThisRun} クレジット）`);
}

function need(what) { console.error(`${what} が必要です`); process.exit(2); }
function usage() {
  console.log(`使い方:
  npm run character:build  -- <id> [--provider mock|tripo] [--max-credits N] [--yes] [--dry-run]
  npm run character:review -- <id>
  npm run character -- init <id> --source <画像> [--name 表示名]
  npm run character -- <prepare|generate|approve|reject|rig|animate|optimize|register|status> <id> [--note ...] [--task <taskId>] [--new]
  npm run character -- adopt <id> --slot <model|rig|retarget|...> --task <taskId>   返事を受け取れなかったタスクを引き取る`);
  process.exit(2);
}
