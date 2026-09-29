// GLB を 正面・横・後ろ から撮って、元絵と並べた1枚の画像にする（確認・記録用。無料）
// 使い方: node tools/character/render-views.mjs <model.glb> <out.png> [--rotate -90] [--source <元絵>]
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { ROOT } from "./lib/paths.mjs";

const { values: o, positionals: [model, out] } = parseArgs({ allowPositionals: true, options: { rotate: { type: "string" }, source: { type: "string" } } });
const rot = Number(o.rotate || 0);
const T = { ".html": "text/html", ".js": "text/javascript", ".glb": "model/gltf-binary", ".png": "image/png" };
const page = `<!doctype html><html><body style="margin:0;background:#fff">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from "three"; import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"; import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); r.setSize(600, 600); r.outputColorSpace = THREE.SRGBColorSpace; r.setClearColor(0xffffff); document.body.append(r.domElement);
const s = new THREE.Scene(); s.add(new THREE.HemisphereLight(0xffffff, 0xd8cabd, 3.0)); const d = new THREE.DirectionalLight(0xffffff, 0.8); d.position.set(0.5, 2, 3); s.add(d);
const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/${relative(ROOT, resolve(model))}");
const w = new THREE.Group(); w.add(g.scene); w.rotation.y = ${(rot * Math.PI) / 180}; s.add(w);
const b = new THREE.Box3().setFromObject(w), c = b.getCenter(new THREE.Vector3()), R = b.getSize(new THREE.Vector3()).length() / 2;
const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
window.shot = (dir) => { cam.position.copy(c).add(new THREE.Vector3(...dir).multiplyScalar(R * 3.4)); cam.lookAt(c); r.render(s, cam); return r.domElement.toDataURL("image/png"); };
window.ready = true;
</script></body></html>`;
const server = createServer(async (q, res) => {
  const p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
  try { const f = join(ROOT, p); if (!f.startsWith(ROOT)) throw 0; res.writeHead(200, { "content-type": T[extname(f)] || "application/octet-stream" }); res.end(await readFile(f)); } catch { res.writeHead(404); res.end(); }
}).listen(0);
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const p = await b.newPage({ viewport: { width: 600, height: 600 } });
  await p.goto(`http://localhost:${server.address().port}/`);
  await p.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const tiles = [];
  if (o.source) tiles.push(await sharp(o.source).flatten({ background: "#fff" }).toBuffer());
  for (const dir of [[0, 0, 1], [1, 0, 0], [0.7, 0, 0.7], [-1, 0, 0], [0, 0, -1]]) {
    const url = await p.evaluate((d) => window.shot(d), dir);
    tiles.push(Buffer.from(url.split(",")[1], "base64"));
  }
  const imgs = await Promise.all(tiles.map((t) => sharp(t).resize(360, 360, { fit: "contain", background: "#fff" }).toBuffer()));
  await sharp({ create: { width: 360 * imgs.length, height: 360, channels: 3, background: "#fff" } })
    .composite(imgs.map((d, i) => ({ input: d, left: i * 360, top: 0 }))).png().toFile(out);
  console.log(`wrote ${out}`);
} finally { await b.close(); server.close(); }
