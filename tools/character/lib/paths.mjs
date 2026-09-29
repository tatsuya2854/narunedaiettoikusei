// キャラクター素材の置き場所（種類ごとのフォルダ → キャラID）
//   assets/characters/source/<id>/      元画像（Source of Truth。上書き禁止）
//   assets/characters/multiview/<id>/   多視点画像（使う場合）
//   assets/characters/models/<id>/      生成された3Dモデル候補（リグ前・生）      ※git管理外
//   assets/characters/animations/<id>/  リグ済み・アニメ付きの生モデル            ※git管理外
//   assets/characters/optimized/<id>/   Web用に最適化した配信モデル（ゲームが読む）
//   assets/characters/<id>/character.json  キャラ設定（ゲームが読む）
//   assets/characters/<id>/pipeline.json   パイプラインの進み具合・タスクID・消費クレジット
//   assets/characters/index.json          ゲームに登録済みのキャラ一覧
import { resolve, join } from "node:path";

export const ROOT = resolve(new URL("../../..", import.meta.url).pathname);
export const CHAR_DIR = join(ROOT, "assets/characters");
export const LOG_DIR = join(ROOT, "logs/character");

export function charPaths(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(id)) throw new Error(`キャラIDは英小文字・数字・_-のみ: ${id}`);
  return {
    id,
    source: join(CHAR_DIR, "source", id),
    multiview: join(CHAR_DIR, "multiview", id),
    models: join(CHAR_DIR, "models", id),
    animations: join(CHAR_DIR, "animations", id),
    optimized: join(CHAR_DIR, "optimized", id),
    dir: join(CHAR_DIR, id),
    config: join(CHAR_DIR, id, "character.json"),
    pipeline: join(CHAR_DIR, id, "pipeline.json"),
  };
}
