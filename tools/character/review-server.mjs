// HUMAN CHECKPOINT。元絵と3Dモデル候補を並べて、人が Approve / Reject する。
// 自分のPCの中だけで開く（127.0.0.1 のみで待ち受け）。Approve されたモデルにだけ rig / animate が流れる。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { exec } from "node:child_process";
import { ROOT, charPaths } from "./lib/paths.mjs";
import { loadPipeline, readJson } from "./lib/state.mjs";
import { decide } from "./pipeline.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".glb": "model/gltf-binary", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".json": "application/json" };
// 配ってよいのはこの中だけ
const ALLOW = ["assets/characters/", "node_modules/three/", "tools/character/review.html"];

export async function serveReview({ id, port = 5178 }) {
  const P = charPaths(id);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, await readFile(join(ROOT, "tools/character/review.html")), ".html");
      if (req.method === "GET" && url.pathname === "/api/state") {
        const p = await loadPipeline(P), cfg = await readJson(P.config, {});
        return send(res, 200, JSON.stringify({ id, name: cfg.name, sourceImage: cfg.sourceImage, input: p.input, candidates: p.candidates, review: p.review, stage: p.stage, optimized: p.optimized?.file, animated: p.animatedFile }), ".json");
      }
      if (req.method === "POST" && url.pathname === "/api/decide") {
        if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) return send(res, 403, "forbidden");
        const body = JSON.parse(await readBody(req));
        const c = await decide({ id, taskId: body.taskId, decision: body.decision, note: String(body.note || "").slice(0, 500) });
        return send(res, 200, JSON.stringify({ ok: true, candidate: c }), ".json");
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
      if (!ALLOW.some((a) => rel.startsWith(a)) || rel.includes("..")) return send(res, 404, "not found");
      return send(res, 200, await readFile(join(ROOT, rel)), extname(rel));
    } catch (e) { send(res, e.code === "ENOENT" ? 404 : 500, String(e.message)); }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${port}/`;
  console.log(`確認画面: ${url}\n（元絵と比べて、顔・目・口・髪・体型・頭身・服・色が保たれているか見てください。終わったら Ctrl+C）`);
  if (process.platform === "darwin" && !process.env.NO_OPEN) exec(`open ${url}`);
  return server;
}

function send(res, code, body, ext = ".txt") { res.writeHead(code, { "content-type": TYPES[ext] || "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(body); }
function readBody(req) { return new Promise((ok, ng) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 1e5) req.destroy(); }); req.on("end", () => ok(s)); req.on("error", ng); }); }
