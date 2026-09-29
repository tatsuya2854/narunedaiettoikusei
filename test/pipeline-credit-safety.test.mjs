// 有料タスク作成の返事を受け取れなかったとき、再実行で作り直さない（二重課金しない）ことの確認
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as pl from "../tools/character/pipeline.mjs";
import { CreditGuard } from "../tools/character/lib/guard.mjs";
import { charPaths, ROOT } from "../tools/character/lib/paths.mjs";
import { loadPipeline } from "../tools/character/lib/state.mjs";
import { loadPricing } from "../tools/character/providers/index.mjs";
import { MockTripoProvider } from "../tools/character/providers/mock.mjs";

const ID = "zz-test-credit";
const P = charPaths(ID);
after(async () => { for (const d of [P.dir, P.source, P.models, P.animations, P.optimized, P.multiview]) await rm(d, { recursive: true, force: true }); });

test("通信断で返事が無い → 次回は作り直さず止まる / --allow-recreate で初めて作る", async () => {
  const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
  try {
    await pl.init({ id: ID, source: join(ROOT, "assets/characters/source/naru/front.png") });
    await pl.prepare({ id: ID });
    let posts = 0;
    const flaky = new MockTripoProvider({ pricing: loadPricing() });
    flaky.paid = true;                                    // 有料と同じ扱いで確認させる
    flaky.startImageToModel = async () => { posts++; throw new TypeError("fetch failed"); };   // HTTP の返事なし
    const guard = new CreditGuard({ provider: flaky, maxCredits: 100, assumeYes: true });
    await assert.rejects(() => pl.generate({ id: ID, guard, provider: flaky }));
    assert.equal((await loadPipeline(P)).tasks.model.status, "creating");
    await assert.rejects(() => pl.generate({ id: ID, guard, provider: flaky }), /adopt/);
    assert.equal(posts, 1, "返事の無かった作成を勝手に送り直した");

    const ok = new MockTripoProvider({ pricing: loadPricing() });
    await pl.generate({ id: ID, guard: new CreditGuard({ provider: ok, assumeYes: true }), provider: ok, allowRecreate: true });
    const p = await loadPipeline(P);
    assert.equal(p.tasks.model.status, "success");
    assert.equal(p.candidates.length, 1);

    // Approve 前はリグに進めない
    await assert.rejects(() => pl.rig({ id: ID, guard: new CreditGuard({ provider: ok, assumeYes: true }), provider: ok }), /Approve/);
  } finally { console.log = log; console.error = err; }
});

test("HTTPで断られた作成は『作られていない』ので、確認のうえ作り直せる", async () => {
  const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
  try {
    await rm(P.pipeline, { force: true }); await pl.prepare({ id: ID });
    const prov = new MockTripoProvider({ pricing: loadPricing() });
    prov.startImageToModel = async () => { const e = new Error("HTTP 403 code=2010"); e.status = 403; throw e; };
    await assert.rejects(() => pl.generate({ id: ID, guard: new CreditGuard({ provider: prov, assumeYes: true }), provider: prov }));
    assert.equal((await loadPipeline(P)).tasks.model.status, "create_failed");
  } finally { console.log = log; console.error = err; }
});
