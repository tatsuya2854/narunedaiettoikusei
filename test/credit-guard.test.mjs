import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditGuard } from "../tools/character/lib/guard.mjs";
import { TripoApiProvider } from "../tools/character/providers/tripo-api.mjs";
import { loadPricing } from "../tools/character/providers/index.mjs";

const KEY = "tsk_THIS_IS_A_FAKE_KEY_123";
const quiet = () => {};
const paid = (balance = 1000) => ({ name: "fake", paid: true, getBalance: async () => ({ balance, frozen: 0 }) });
const plan = (c) => ({ title: "t", items: [{ label: "x", credits: c }] });

test("上限を超える計画は始めない", async () => {
  const log = console.log; console.log = quiet; const err = console.error; console.error = quiet;
  try {
    const g = new CreditGuard({ provider: paid(), maxCredits: 50, assumeYes: true });
    assert.equal(await g.approve(plan(30)), true); g.charge(30);
    assert.equal(await g.approve(plan(25)), false);   // 30+25 > 50
    assert.equal(await new CreditGuard({ provider: paid(10), maxCredits: 500, assumeYes: true }).approve(plan(30)), false); // 残高不足
    assert.equal(await new CreditGuard({ provider: paid(), maxCredits: 500, assumeYes: true }).approve(plan(null)), false); // 見積もり不明
    assert.equal(await new CreditGuard({ provider: paid(), maxCredits: 500, dryRun: true, assumeYes: true }).approve(plan(10)), false);
    assert.equal(await new CreditGuard({ provider: paid(), maxCredits: 500, interactive: false }).approve(plan(10)), false); // 確認なし
  } finally { console.log = log; console.error = err; }
});

test("有料タスクの作成は失敗しても再送しない・エラーにキーが出ない", async () => {
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push([o?.method, url]); return new Response(JSON.stringify({ code: 1000, message: "server error" }), { status: 500 }); };
  const p = new TripoApiProvider({ apiKey: KEY, pricing: loadPricing(), fetchImpl });
  await assert.rejects(() => p.startImageToModel({ file: { type: "png", file_token: "t" }, modelVersion: "v3.1-20260211" }), (e) => {
    assert.ok(!String(e.message).includes(KEY) && !JSON.stringify(e).includes(KEY));
    return true;
  });
  assert.equal(calls.filter(([m]) => m === "POST").length, 1);
  assert.ok(!JSON.stringify(p).includes(KEY), "インスタンスにキーが見えている");
});

test("リクエストの形は公式ドキュメントどおり", async () => {
  let body;
  const fetchImpl = async (url, o) => { body = JSON.parse(o.body); assert.equal(url, "https://api.tripo3d.ai/v2/openapi/task"); assert.equal(o.headers.Authorization, `Bearer ${KEY}`); return new Response(JSON.stringify({ code: 0, data: { task_id: "t1" } })); };
  const p = new TripoApiProvider({ apiKey: KEY, pricing: loadPricing(), fetchImpl });
  assert.equal(await p.startRig({ modelTaskId: "m1" }), "t1");
  assert.deepEqual(body, { type: "animate_rig", original_model_task_id: "m1", out_format: "glb", rig_type: "biped", spec: "tripo", model_version: "v1.0-20240301" });
  await p.startRetarget({ rigTaskId: "r1", animations: ["preset:idle", "preset:walk"] });
  assert.equal(body.type, "animate_retarget"); assert.deepEqual(body.animations, ["preset:idle", "preset:walk"]);
  assert.throws(() => p.startRetarget({ rigTaskId: "r1", animations: ["a", "b", "c", "d", "e", "f"] }));
});

test("見積もり（料金表どおり）", () => {
  const p = new TripoApiProvider({ apiKey: KEY, pricing: loadPricing(), fetchImpl: fetch });
  assert.equal(p.estimate("image_to_model", { modelVersion: "v3.1-20260211", texture: true, textureQuality: "standard" }), 30);
  assert.equal(p.estimate("image_to_model", { modelVersion: "v3.1-20260211", texture: true, textureQuality: "detailed" }), 40);
  assert.equal(p.estimate("animate_rig"), 25);
  assert.equal(p.estimate("animate_retarget", { animations: [1, 2, 3, 4] }), 40);
  assert.equal(p.estimate("animate_prerigcheck"), 0);
  assert.equal(p.estimate("mystery"), null);
});

test("キーの形が違えば使わない", () => {
  assert.throws(() => new TripoApiProvider({ apiKey: "tcli_abc", pricing: loadPricing() }));
  assert.throws(() => new TripoApiProvider({ apiKey: "", pricing: loadPricing() }));
});
