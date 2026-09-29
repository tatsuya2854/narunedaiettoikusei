// ゲームの描画（2Dメッシュリグ）をそのまま使って、正面・静止ポーズの全身画像を書き出す。
// 元の1254px原画が手元にないため、アトラスの大きいパーツから合成した絵を 3D化の入力（Source of Truth）にする。
// 使い方: node tools/character/export-source.mjs <出力png> [scale]
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(new URL("../..", import.meta.url).pathname);
const out = process.argv[2];
const scale = Number(process.argv[3] || 4);
if (!out) { console.error("usage: export-source.mjs <out.png> [scale]"); process.exit(1); }

const types = { ".html": "text/html", ".webp": "image/webp", ".png": "image/png", ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    if (!p.startsWith(root)) throw 0;
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 800 }, deviceScaleFactor: scale });
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForFunction(() => window.__naru && window.__naru.gl && window.__naru.gl());
  await page.evaluate(() => {
    const n = window.__naru;
    n.set({ stage: 2, hatched: true, careDays: 5, puni: 50, beauty: 50, outfit: "default", acc: "none" });
  });
  // 起動時の「ようこそ」反応が終わるのを待ってから、全関節0（＝原画そのままの立ち姿）にする
  await page.waitForTimeout(4500);
  await page.evaluate(() => window.__naru.joint({}));
  await page.waitForTimeout(1200);
  // 部屋・UI を消して、キャラの canvas だけを透明背景で撮る
  await page.addStyleTag({ content: `html,body,.stage,main{background:transparent!important}
    body *:not(#avatarWrap):not(#avatarWrap *){visibility:hidden!important}
    #avatarWrap, #avatarWrap *{visibility:visible!important} .shadow,[class*=shadow]{display:none!important}` });
  await page.waitForTimeout(300);
  // 浮遊アニメで要素が止まらないので、座標で切り抜いて撮る
  const box = await page.$eval("#rigGL", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const buf = await page.screenshot({ clip: box, omitBackground: true });
  const t = await sharp(buf).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  // 周囲に余白を足して正方形に（画像→3Dは中央・余白ありが安定）
  const side = Math.round(Math.max(t.info.width, t.info.height) * 1.12);
  await sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: t.data, left: Math.round((side - t.info.width) / 2), top: Math.round((side - t.info.height) / 2) }])
    .png().toFile(out);
  console.log(`wrote ${out} (${side}x${side}, character ${t.info.width}x${t.info.height})`);
} finally { await browser.close(); server.close(); }
