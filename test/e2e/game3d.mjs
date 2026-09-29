// 実ブラウザ（Chromium・iPhone相当の画面）での確認。npm run test:e2e
//   ・2D（既定）がエラーなく描ける
//   ・「動きを減らす」設定でもキャラが描かれる（以前は消えていた）
//   ・?r=3d で3Dキャラが読み込まれ、ゲームの出来事でアニメが切り替わる
import { chromium, devices } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(new URL("../..", import.meta.url).pathname);
const out = process.env.SHOT_DIR || null;
const T = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".glb": "model/gltf-binary", ".svg": "image/svg+xml" };
const server = createServer(async (q, r) => {
  try { const p = join(root, decodeURIComponent(new URL(q.url, "http://x").pathname).replace(/\/$/, "/index.html")); if (!p.startsWith(root + "/") || /\/\./.test(p.slice(root.length))) throw 0;   // .env などは配らない
    r.writeHead(200, { "content-type": T[extname(p)] || "application/octet-stream" }); r.end(await readFile(p)); } catch { r.writeHead(404); r.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
// BASE_URL を渡すと本番（GitHub Pages）を確かめる
const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const iphone = devices["iPhone 13"];
let failed = 0;
async function check(name, fn) { try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.log(`not ok - ${name}\n  ${e.message}`); } }

async function open(url, opt = {}) {
  const ctx = await browser.newContext({ ...iphone, ...opt });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__naru);
  await page.evaluate(() => window.__naru.set({ stage: 2, hatched: true, careDays: 5, energy: 80, mood: 60 }));
  return { ctx, page, errors };
}
// キャラの枠の中に、透明でない画素がどれだけあるか
async function inkRatio(page, sel) {
  const box = await page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const png = await page.screenshot({ clip: box });
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const bg = await page.screenshot({ clip: { ...box, x: 0, y: box.y, width: 4, height: 4 } });
  let diff = 0; const n = info.width * info.height;
  // 背景（部屋の壁）と違う色の画素を数える
  const b0 = [data[0], data[1], data[2]];
  for (let i = 0; i < n; i++) { const o = i * info.channels; if (Math.abs(data[o] - b0[0]) + Math.abs(data[o + 1] - b0[1]) + Math.abs(data[o + 2] - b0[2]) > 60) diff++; }
  return diff / n;
}

await check("2D（既定）: エラーなく描ける", async () => {
  const { ctx, page, errors } = await open(base + "?r=2d");
  await page.waitForTimeout(2500);
  const r = await inkRatio(page, "#body");
  if (out) await page.screenshot({ path: `${out}/2d.png` });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("r3d")), false);
  assert.ok(r > 0.08, `キャラが描かれていない（${r.toFixed(3)}）`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("2D + 動きを減らす設定: キャラが消えない", async () => {
  const { ctx, page, errors } = await open(base + "?r=2d", { reducedMotion: "reduce" });
  await page.waitForTimeout(2000);
  const r = await inkRatio(page, "#body");
  if (out) await page.screenshot({ path: `${out}/2d-reduced.png` });
  assert.ok(r > 0.08, `キャラが描かれていない（${r.toFixed(3)}）`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("3D: 読み込み・状態の切り替え・2Dを隠す", async () => {
  const { ctx, page, errors } = await open(base + "?r=3d");
  await page.waitForFunction(() => window.__naru.r3() && window.__naru.r3().active, null, { timeout: 15000 });
  const info = await page.evaluate(() => ({ ...window.__naru.r3().info, loadMs: window.__naru.r3().loadMs }));
  console.log("  3D:", JSON.stringify(info));
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains("r3d")));
  await page.waitForTimeout(800);
  if (out) await page.screenshot({ path: `${out}/3d-idle.png` });
  assert.ok((await inkRatio(page, "#body")) > 0.05, "3Dキャラが描かれていない");
  // 出来事 → 状態
  await page.evaluate(() => window.__naru.act("jump"));
  await page.waitForTimeout(250);
  assert.equal((await page.evaluate(() => window.__naru.r3().state())).current, "JUMP");
  if (out) await page.screenshot({ path: `${out}/3d-jump.png` });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__naru.act("run"));
  await page.waitForTimeout(250);
  assert.equal((await page.evaluate(() => window.__naru.r3().state())).clip, "walk");
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__naru.meal("normal"));
  await page.waitForTimeout(250);
  const eat = await page.evaluate(() => window.__naru.r3().state());
  const clips = (await page.evaluate(() => window.__naru.r3().info.clips));
  assert.equal(eat.current, "EAT"); assert.equal(eat.clip, clips.includes("eat") ? "eat" : "happy");
  if (out) await page.screenshot({ path: `${out}/3d-eat.png` });
  await page.waitForTimeout(3500);
  // 寝る（たいりょくが少ないとき）・ダンス
  if (clips.includes("sleep")) {
    await page.evaluate(() => { window.__naru.set({ energy: 10 }); window.__naru.act("nap"); });
    await page.waitForTimeout(400);
    // 直前の食事で進化の演出（喜ぶ）が遅れて重なることがあるので、ベースが「寝る」になったかを見る
    assert.equal((await page.evaluate(() => window.__naru.r3().state())).base, "SLEEP");
    await page.waitForFunction(() => window.__naru.r3().state().clip === "sleep", null, { timeout: 8000 });
    await page.waitForTimeout(1200);   // クロスフェードが終わってから撮る
    if (out) await page.screenshot({ path: `${out}/3d-sleep.png` });
    await page.evaluate(() => window.__naru.set({ energy: 80 }));
  }
  if (clips.includes("dance")) {
    await page.evaluate(() => window.__naru.dance());
    await page.waitForTimeout(800);
    assert.equal((await page.evaluate(() => window.__naru.r3().state())).clip, "dance");
    if (out) await page.screenshot({ path: `${out}/3d-dance.png` });
    await page.evaluate(() => window.__naru.endDance(true));
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("3D: 表情・着せ替え・アクセ", async () => {
  const { ctx, page, errors } = await open(base + "?r=3d");
  await page.waitForFunction(() => window.__naru.r3() && window.__naru.r3().active, null, { timeout: 15000 });
  const info = await page.evaluate(() => window.__naru.r3().info);
  if (!info.face) { console.log("  （顔シートの無いモデルなので表情はスキップ）"); await ctx.close(); return; }
  await page.evaluate(() => { window.__naru.unlockAll(); window.__naru.face("wow", 5000); });
  await page.waitForTimeout(600);
  // 着せ替え・アクセは全部つけ外しして、エラーが出ないこと・頭に付くこと
  for (const [o, a] of [["mint", "ribbon"], ["pink", "flower"], ["navy", "band"], ["lavender", "shades"], ["black", "phones"], ["gold", "crown"], ["cheer", "none"]]) {
    await page.evaluate(([o, a]) => window.__naru.wear(o, a), [o, a]);
    await page.waitForTimeout(250);
    const has = await page.evaluate((a) => !!window.__naru.r3().socket("head").children.find((c) => c.name === "acc:" + a), a);
    assert.equal(has, a !== "none", `アクセ ${a}`);
  }
  if (out) await page.screenshot({ path: `${out}/3d-look.png` });
  assert.deepEqual(errors, []);
  await ctx.close();
});

await check("3D: モデルが読めないときは2Dに戻る", async () => {
  const ctx = await browser.newContext({ ...iphone });
  await ctx.route("**/*.glb", (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(base + "?r=3d");
  await page.waitForFunction(() => window.__naru);
  await page.evaluate(() => window.__naru.set({ stage: 2, hatched: true, careDays: 5 }));
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("r3d")), false);
  assert.equal(await page.evaluate(() => window.__naru.r3()), null);
  assert.ok((await inkRatio(page, "#body")) > 0.08, "2Dに戻った後にキャラが描かれていない");
  await ctx.close();
});

await check("3Dは覚えない: ?r=3d の後、パラメータ無しで開くと2D", async () => {
  const ctx = await browser.newContext({ ...iphone });
  const page = await ctx.newPage();
  await page.goto(base + "?r=3d");
  await page.waitForFunction(() => window.__naru && window.__naru.r3() && window.__naru.r3().active, null, { timeout: 15000 });
  await page.goto(base);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("r3d")), false);
  assert.equal(await page.$$eval("canvas.rig3d", (c) => c.length), 0);
  await ctx.close();
});

await check("3D + 動きを減らす設定: ワンショットの後に待機へ戻る", async () => {
  const { ctx, page, errors } = await open(base + "?r=3d", { reducedMotion: "reduce" });
  await page.waitForFunction(() => window.__naru.r3() && window.__naru.r3().active, null, { timeout: 15000 });
  await page.evaluate(() => window.__naru.act("cheer"));
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(() => window.__naru.r3().state())).current, "HAPPY");
  await page.waitForTimeout(4500);
  assert.equal((await page.evaluate(() => window.__naru.r3().state())).current, "IDLE");
  assert.deepEqual(errors, []);
  await ctx.close();
});

await browser.close(); server.close();
if (failed) { console.log(`# fail ${failed}`); process.exit(1); } else console.log("# all ok");
