# このリポジトリのルール（Claude / Codex 共通。AGENTS.md も同じ内容を指す）

なるねぇといっしょ：スマホ向けの育成ゲーム。静的サイト（`index.html` 1枚＋画像）で、GitHub Pages に `main` を push すると公開される。ビルド不要。

## 絶対に守ること

1. **元キャラクターのデザインを変えない**。顔・目・口・髪型（ポニーテール）・体型・頭身・服・色・耳付き帽子・雰囲気。正面の元絵 `assets/characters/source/<id>/front.*` が正（Source of Truth）。元画像は上書きしない
2. **Tripo のクレジットを無駄遣いしない**
   - 有料処理の前に「処理・見積もりクレジット・残高・生成数」を表示して人の確認を取る（`tools/character/lib/guard.mjs`）
   - 1回の実行で1キャラだけ。1回あたりの上限（既定150）を超えない
   - **有料APIの自動リトライ・無限ループは禁止**。失敗したら `logs/character/*.failures.jsonl` を見て原因を確かめてから人が再実行する
   - 既定のプロバイダは `mock`（無料）。有料の `tripo` は `--provider tripo` を明示したときだけ
   - 料金は `tools/character/tripo-pricing.json` が唯一の正。推測で書かない。変わったら公式ドキュメントを確認して直す
3. **3Dモデルの採用前に HUMAN CHECKPOINT**。生成 → `npm run character:review` で人が Approve → その後だけリグ・アニメ（有料）を流す
4. **Tripo API キーはコミットしない・フロントに置かない**。`.env`（git管理外）だけ。`.env.example` を参照
5. **ASTRA は使わない**。Codex の既定モデルが `gpt-6-astra` になっているので、Codex を呼ぶときは必ず `-m gpt-5.6-sol` などを明示する
6. **重要なコードは Codex にもレビューさせる**（Three.js・モデル読み込み・API連携・セキュリティ・パフォーマンス）。Claude 実装 → Codex レビュー → Claude 修正 → テスト
7. **iPhone（Safari）最優先**。PC で動いただけで完成にしない。ロード量・FPS・メモリ・発熱を見る。重い端末では2Dに戻る仕組みを壊さない
8. **Git**：意味のある単位で `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:` でコミットして push。force push・重要ブランチ削除・履歴の書き換えはしない。大きな変更の前は戻せる状態（コミットIDを控える）を作る
9. **テストが通ってから deploy**（`npm test` と `npm run test:e2e`）

## 構成

| 場所 | 中身 |
|---|---|
| `index.html` | ゲーム本体（手で編集するソース。2Dメッシュリグもここ） |
| `3d/` | 3Dキャラ（ためし）。`?r=3d` のときだけ読む。`state-machine.js` がアニメの状態機械、`vendor/three-char.js` は `npm run vendor:three` で作る |
| `assets/characters/` | キャラ素材と設定。`<id>/character.json` が設定、`index.json` がゲームに登録済みの一覧 |
| `tools/character/` | Tripo 3D化パイプライン（Node CLI）。`providers/` に Mock と Tripo API |
| `docs/3d-character.md` | 3D化の手順・2Dとの比較・判断の記録 |

## よく使うコマンド

```sh
npm test                                   # 状態機械などの単体テスト
npm run test:e2e                           # 実ブラウザ（iPhone相当）で 2D / 3D を確認
npm run character:build -- naru            # mock で一連を流す（無料）
npm run character:build -- naru --provider tripo   # 本物（有料・確認あり）
npm run character:review -- naru           # 元絵と3Dを並べて Approve / Reject
npm run character -- status naru
```
