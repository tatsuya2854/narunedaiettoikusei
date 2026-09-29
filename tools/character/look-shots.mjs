// ゲーム画面（3D・iPhone相当）で、表情・着せ替え・アクセを並べて撮る確認用ツール。
//   node tools/character/look-shots.mjs out.png face base squint wow sad
//   node tools/character/look-shots.mjs out.png wear mint:none pink:ribbon
//   node tools/character/look-shots.mjs out.png side cheer:shades:0 cheer:shades:60   （服:アクセ:回す角度）
import { chromium, devices } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";
const root = resolve(new URL("../..", import.meta.url).pathname), out = process.argv[2];
const T = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".glb": "model/gltf-binary", ".svg": "image/svg+xml" };
const server = createServer(async (q, r) => { try { const p = join(root, decodeURIComponent(new URL(q.url, "http://x").pathname).replace(/\/$/, "/index.html")); if (!p.startsWith(root + "/") || /\/\./.test(p.slice(root.length))) throw 0; r.writeHead(200, { "content-type": T[extname(p)] || "application/octet-stream" }); r.end(await readFile(p)); } catch { r.writeHead(404); r.end(); } }).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await (await b.newContext({ ...devices["iPhone 13"] })).newPage();
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.goto(`http://127.0.0.1:${server.address().port}/index.html?r=3d`);
await p.waitForFunction(() => window.__naru?.r3()?.active);
await p.evaluate(() => { const n = window.__naru; n.set({ stage: 2, hatched: true, careDays: 5, mood: 70, energy: 80 }); n.unlockAll(); });
await p.waitForTimeout(3500);
const shot = async () => { const box = await p.$eval("#body", (e) => { const r = e.getBoundingClientRect(); return { x: r.x - r.width * 0.2, y: r.y - r.height * 0.1, width: r.width * 1.4, height: r.height * 1.15 }; }); return p.screenshot({ clip: box }); };
const tiles = [];
const [mode, ...items] = process.argv.slice(3);
for (const it of items) {
  if (mode === "face") await p.evaluate((f) => { window.__naru.face(f, 60000); }, it);
  if (mode === "side") await p.evaluate((o) => { const [a, c, deg] = o.split(":"); window.__naru.wear(a || null, c || null); window.__naru.r3().turn(Number(deg)); }, it);
  if (mode === "wear") await p.evaluate((o) => { const [a, c] = o.split(":"); window.__naru.wear(a || null, c || null); }, it);
  await p.waitForTimeout(900);
  tiles.push(await shot());
}
const imgs = await Promise.all(tiles.map((t) => sharp(t).resize(300, 330, { fit: "contain", background: "#fff" }).toBuffer()));
await sharp({ create: { width: 300 * imgs.length, height: 330, channels: 3, background: "#fff" } }).composite(imgs.map((d, i) => ({ input: d, left: i * 300, top: 0 }))).png().toFile(out);
await b.close(); server.close();
