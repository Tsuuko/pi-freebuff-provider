# pi-freebuff-provider

[pi coding agent](https://github.com/earendil-works/pi-mono) 用の [Freebuff](https://freebuff.com) プロバイダ拡張。
Freebuff 公式 CLI (Codebuff の FREE モードフォーク) のプロトコルを模倣し、無料モデルを pi から直接使えるようにする。

## セットアップ

```bash
pnpm install
```

## 使い方

```bash
# 拡張を読み込んで起動
pi -e /path/to/pi-freebuff-provider
```

1. TUI で `/login freebuff` → ブラウザが開く → freebuff.com にログイン
   (CLI ベースで済ませるなら `node --experimental-strip-types scripts/login.mts`)
2. モデル選択:
3. 使う途中で `/freebuff` → 残量 (full ティアなら `unlimited sessions (full tier)`)・セッション状態・リセット時刻・email を表示 (GET なので課金なし)
4. `/freebuff close` → セッションを明示終了 (未経済分を返金)。「もう使わない」時に。1時間以内に戻るなら閉じず再接続が得
5. ステータスバー: freebuff モデル選択中のみ内蔵フッターをラップし、stats行 (`↑178 ↓205 …`) の `(auto)` 直後に `buff 4.4/6 · flash 37m` を挿入 (残量/上限 · モデル短縮名と残り時間。full ティアなら `buff ∞ · …`。usage集計や右寄せは内蔵実装のまま利用、幅が足りないときは独立行にフォールバック)。他プロバイダ選択時は内蔵フッターに自動復元。行3 (拡張ステータス) はこの拡張では使わない

```
freebuff/deepseek/deepseek-v4-pro    DeepSeek V4 Pro (full ティアのみ)
freebuff/deepseek/deepseek-v4-flash  DeepSeek V4 Flash ★おすすめ (両ティア可)
freebuff/openai/gpt-5.6-luna         GPT-5.6 Luna (full ティアのみ)
freebuff/minimax/minimax-m3          MiniMax M3 (full ティアのみ)
freebuff/mimo/mimo-v2.5              MiMo 2.5 (両ティア可)
```

## 模倣しているプロトコル

| ステップ   | リクエスト                                                                   | 備考                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ログイン   | `POST https://freebuff.com/api/auth/cli/code` `{fingerprintId}`              | device-code 型。`loginUrl` をブラウザで開く                                                                                                                |
| ポーリング | `GET /api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=…`     | 5秒毎。`{user: {authToken}}` を取得                                                                                                                        |
| セッション | `POST https://www.codebuff.com/api/v1/freebuff/session` + `x-freebuff-model` | **前払い方式** (実測): POSTで+1.0即時課金 → DELETE/期限切れ時に実経過時間を切り上げ0.1単位で精算し返金。切替時はDELETE→POST。1セッション最大1時間・1モデル |
| run 開始   | `POST /api/v1/agent-runs` `{action:'START', agentId:'base2-free-…'}`         | モデルごとの free-mode ルート agentId                                                                                                                      |
| 推論       | `POST /api/v1/chat/completions`                                              | OpenAI 互換 SSE + 下記の独自要素                                                                                                                           |

推論リクエストの独自要素:

- ヘッダ: `Authorization: Bearer <authToken>`, `user-agent: ai-sdk/openai-compatible/…/codebuff`
- body: `codebuff_metadata: {run_id, client_id, cost_mode: 'free', freebuff_instance_id}`, `provider: {allow_fallbacks: true}`
- 先頭 system メッセージは `"You are Buffy, the strategic coding assistant."` で始まる必要がある (freebuff のルートプロンプト検証)。pi のシステムプロンプトはその後に連結される
- ツールセットに freebuff 公式ツール名 (`end_turn`) を 1 つ含める (公式クライアント判定)。pi のツールはそのまま
- `429 free_mode_capacity_deferred` は `retry-after` 待ちで自動リトライ

エンドポイントは環境変数で上書き可: `FREEBUFF_LOGIN_URL`, `FREEBUFF_API_URL`。

### プロキシ (オプション)

`~/.pi/agent/extensions/freebuff-provider.json` に設定すると、freebuffとの通信すべて (ログイン・セッション・run・推論 `/me`) がそのプロキシ経由になる。US等のプロキシで **full ティア** (全モデル・無制限) として接続する用途:

```json
{ "proxy": "http://127.0.0.1:8080" }
```

- ファイルが無い/`proxy`が空/URLが無効な場合は直結で動く
- 設定は pi 起動時に読み込まれる (変更したら再起動 or `/reload`)

## 制約

- **limited 層 (日本など)** で使えるのは DeepSeek V4 Flash と MiMo 2.5 のみ。他のモデルはエラーになる。**full 層 (対応地域/プロキシ)** は全モデル + 無制限 (`/freebuff` は `unlimited sessions (full tier)`, フッターは `∞`)
- **ティア切替の自動復帰**: full (USなど) で作ったセッションを limited (日本など) から使うと `409 session_model_mismatch` になるが、拡張はこれを検出して現在の経路で自動再入場・リトライする (逆方向で limited が使えない full 専用モデルの場合は `model_unavailable` エラーになるのでモデル切替が必要)
- 課金 (limited 層) は「1日6.0ユニット」の**時間バジェット** (太平洋日リセット = 日本時間16:00)。POSTで+1.0前借り、DELETE/期限切れで実経過分 (0.1単位切り上げ) が確定し残りは返金される。実測: 2分利用→0.1消費。短時間利用×DELETEなら何度でも入場可。full 層はユニット課金なし
- セッションは 1 モデルに束縛。モデル切替時は現在のセッションを終了 (DELETE) してから新セッションを開始する
- authToken に有効期限はない想定。401 が出たら `/login freebuff` で再ログイン
- liveness beat (GET ポーリング) は送らないため、セッションは `expiresAt` (1時間) で切れる。使わないのに握ったまま放置すると前借り1.0が满期まで溶ける
- **アイドル自動解放**: 最終リクエスト完了から5分 (`FREEBUFF_IDLE_RELEASE_MS` で変更可) 無操作なら自動 DELETE して未経済分を返金。次の送信時に透過的に再入場する。課金刻みが0.1 (=6分) なので5分前後が最適: それより短くても1回あたりの最小課金は変わらず再POSTが増えるだけ。pi終了時 (`/quit`・Ctrl+C×2・`--print` 完了など session_shutdown/beforeExit) にもベストエフォートで DELETE (公式CLIの `releaseFreebuffSlot` 相当)

## 開発

```bash
pnpm run check   # tsgo --noEmit (TypeScript 7)
pnpm run lint    # oxlint (type-aware)
```

実装の一次情報源: `__local/freebuff` (公式 CLI の clone)。
主な参照箇所:

- ログイン: `cli/src/login/login-flow.ts`, `plain-login.ts`
- セッション: `cli/src/utils/freebuff-session-api.ts`, `common/src/types/freebuff-session.ts`
- 推論: `sdk/src/impl/model-provider.ts`, `sdk/src/impl/llm.ts`, `packages/llm-providers/`
- モデル/検証ゲート: `common/src/constants/freebuff-models.ts`, `free-agents.ts`, `foreign-client-signals.ts`
