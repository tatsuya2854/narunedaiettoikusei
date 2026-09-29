// プロバイダの切り替え。--provider か CHARACTER_PROVIDER（mock | tripo）。
// 指定が無いときは「キーがあれば tripo、無ければ mock」…ではなく、必ず mock。
// 有料APIを使うのは、明示的に tripo を選んだときだけ（うっかり課金しないため）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/paths.mjs";
import { MockTripoProvider } from "./mock.mjs";
import { TripoApiProvider } from "./tripo-api.mjs";

export function loadEnv(file = join(ROOT, ".env")) {
  let text = ""; try { text = readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function loadPricing() { return JSON.parse(readFileSync(join(ROOT, "tools/character/tripo-pricing.json"), "utf8")); }

export function createProvider(name = process.env.CHARACTER_PROVIDER || "mock") {
  const pricing = loadPricing();
  if (name === "mock") return new MockTripoProvider({ pricing });
  if (name === "tripo") return new TripoApiProvider({ apiKey: process.env.TRIPO_API_KEY, pricing });
  throw new Error(`不明なプロバイダ: ${name}（mock か tripo）`);
}
