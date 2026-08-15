/**
 * pi extension: Freebuff provider.
 *
 * Freebuff は Codebuff の FREE モード専用フォークで、無料モデルを配っている。
 * 本拡張は公式 CLI (`__local/freebuff`) のプロトコルを模倣する:
 *
 *   1. /login freebuff      → freebuff.com の device-code ログイン
 *      POST /api/auth/cli/code {fingerprintId} → {loginUrl, fingerprintHash, expiresAt}
 *      GET  /api/auth/cli/status?fingerprintId=…&fingerprintHash=…&expiresAt=… (5s毎にポーリング)
 *      → { user: { id, name, email, authToken, … } }
 *
 *   2. セッション確保 (1時間/1セッション、モデルに束縛)
 *      POST /api/v1/freebuff/session   Authorization: Bearer <authToken>
 *                                     x-freebuff-model: <modelId>
 *      → { status: 'active', instanceId, expiresAt, … }
 *
 *   3. run 開始 (モデルごとの free-mode ルート agentId を登録)
 *      POST /api/v1/agent-runs {action:'START', agentId:'base2-free-…'} → {runId}
 *
 *   4. 推論 (OpenAI 互換 SSE)
 *      POST /api/v1/chat/completions   Authorization: Bearer <authToken>
 *      body に codebuff_metadata {run_id, client_id, cost_mode:'free',
 *      freebuff_instance_id} と provider {allow_fallbacks} を追加。
 *      free-mode ルートは先頭 system メッセージが "You are Buffy, …" で
 *      始まる必要がある (FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS の byte-exact 検証)。
 *      429 + error:'free_mode_capacity_deferred' は retry-after 待ちでリトライ。
 *
 * 使い方:
 *   pi -e /path/to/pi-freebuff-provider
 *   /login freebuff   → ブラウザで freebuff.com にログイン
 *   モデル: freebuff/deepseek/deepseek-v4-flash など
 */

import {
  createAssistantMessageEventStream,
  openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// undici を解決: 拡張自身の node_modules (devDependency 宣言済み) → pi 本体依存階層。
// 本番 (pi起動) では自前依存が無いので pi 側にフォールバックする。
const require2 = createRequire(import.meta.url);
function loadUndici(): {
  ProxyAgent: new (uri: string) => { dispatch: unknown };
  fetch: (input: string | URL | Request, init?: Record<string, unknown>) => Promise<Response>;
} {
  const candidates: string[] = ["undici"];
  try {
    const piRoot = require2.resolve("@earendil-works/pi-coding-agent");
    candidates.push(join(dirname(piRoot), "node_modules", "undici"));
  } catch {
    // exports 制限等で pi の位置が取れない場合は自前依存のみ
  }
  for (const c of candidates) {
    try {
      return require2(c) as ReturnType<typeof loadUndici>;
    } catch {
      // next candidate
    }
  }
  throw new Error("undici not found");
}
const undiciMod = (() => {
  try {
    return loadUndici();
  } catch {
    return undefined;
  }
})();
const ProxyAgent = undiciMod?.ProxyAgent;
const undiciFetch = undiciMod?.fetch;
type ProxyAgentLike = { dispatch: unknown };

// ============================================================================
// 設定 — ~/.pi/agent/extensions/freebuff-provider.json (オプション)
//   { "proxy": "http://127.0.0.1:8080" }
// プロキシは freebuff との通信全て (ログイン・セッション・推論) に適用される。
// ============================================================================

interface FreebuffConfig {
  proxy?: string;
}

function readConfig(): FreebuffConfig {
  try {
    const p = join(homedir(), ".pi", "agent", "extensions", "freebuff-provider.json");
    return JSON.parse(readFileSync(p, "utf8")) as FreebuffConfig;
  } catch {
    return {};
  }
}

const CONFIG = readConfig();

/** プロキシ dispatcher (設定時のみ)。無効な URL なら無視して直結する。 */
let proxyAgent: ProxyAgentLike | undefined;
if (typeof CONFIG.proxy === "string" && CONFIG.proxy && ProxyAgent) {
  try {
    proxyAgent = new ProxyAgent(CONFIG.proxy);
  } catch {
    // 設定エラーでも壊れない: 直結で続行
    proxyAgent = undefined;
  }
}

/** freebuffとの通信に使う fetch。プロキシ設定時は undici + ProxyAgent、
 *  それ以外は素の globalThis.fetch。SSE (readable stream) も Dispatcher
 *  経由でそのまま流る。undici が解決できない場合も直結に落ちる。 */
const proxyFetch: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined =
  proxyAgent && undiciFetch
    ? (input, init) =>
        undiciFetch(input as never, {
          ...(init as Record<string, unknown> | undefined),
          dispatcher: proxyAgent,
        } as Record<string, unknown>) as unknown as Promise<Response>
    : undefined;
const fbFetch: typeof fetch = proxyFetch ?? fetch;

// ============================================================================
// Endpoints (freebuff CLI の埋め込み値と同じ)
// ============================================================================

/** ブラウザログイン用 (freebuff CLI の LOGIN_WEBSITE_URL)。 */
const LOGIN_BASE = process.env.FREEBUFF_LOGIN_URL ?? "https://freebuff.com";
/** API バックエンド (www 必須 — codebuff.com は www へ 307 しヘッダが落ちる)。 */
const API_BASE = (
  process.env.FREEBUFF_API_URL ?? "https://www.codebuff.com"
).replace(/\/$/, "");

/** freebuff CLI が ai-sdk 経由で送る user-agent を模倣。 */
const USER_AGENT = "ai-sdk/openai-compatible/1.0.0/codebuff";

/** free-mode ルートの system prompt 冒頭 (freebuff の検証ゲート)。
 *  pi の実際のシステムプロンプトはこの直後に続く。 */
const BUFFY_OPENING = "You are Buffy, the strategic coding assistant.";

// ============================================================================
// Models — common/src/constants/freebuff-models.ts の FREEBUFF_MODELS と
// free-agents.ts の FREEBUFF_ROOT_AGENT_ID_BY_MODEL から。
// ============================================================================

interface FreebuffModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  /** pi の thinking level → ネイティブ reasoning_effort 値。 */
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
  >;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  /** free-mode ルート agentId (agent-run START で登録するもの)。 */
  agentId: string;
}

// DeepSeek V4 の effort ラダーは low/high/max の3段 (公式テーブル)。
const DEEPSEEK_EFFORTS = {
  off: null,
  minimal: null,
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

const MODELS: FreebuffModelDef[] = [
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_EFFORTS,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    agentId: "base2-free-deepseek",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_EFFORTS,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    agentId: "base2-free-deepseek-flash",
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    agentId: "base2-free-luna",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 524_288,
    maxTokens: 32_768,
    agentId: "base2-free-minimax-m3",
  },
  {
    id: "mimo/mimo-v2.5",
    name: "MiMo 2.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131_072,
    maxTokens: 16_384,
    agentId: "base2-free-mimo",
  },
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

// ============================================================================
// OAuth — cli/src/login/{login-flow,plain-login}.ts と同じ device-code フロー。
// ============================================================================

const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** freebuff CLI の legacy フィンガープリント形式 (calculateLegacyFingerprint)。 */
function fingerprintId(): string {
  const random = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `codebuff-cli-${random}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface LoginCodeResponse {
  loginUrl: string;
  fingerprintHash: string;
  /** エポックms (ISO 文字列ではない) — status エンドポイントへそのまま返す。 */
  expiresAt: number;
}

async function loginFreebuff(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const fingerprint = fingerprintId();

  const codeRes = await fbFetch(`${LOGIN_BASE}/api/auth/cli/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprintId: fingerprint }),
  });
  if (!codeRes.ok) {
    throw new Error(
      `Failed to request login URL: ${codeRes.status} ${await codeRes.text()}`,
    );
  }
  const code = (await codeRes.json()) as LoginCodeResponse;

  callbacks.onAuth({ url: code.loginUrl });
  callbacks.onProgress?.("Waiting for login in browser...");

  const statusUrl =
    `${LOGIN_BASE}/api/auth/cli/status` +
    `?fingerprintId=${encodeURIComponent(fingerprint)}` +
    `&fingerprintHash=${encodeURIComponent(code.fingerprintHash)}` +
    `&expiresAt=${encodeURIComponent(String(code.expiresAt))}`;

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(LOGIN_POLL_INTERVAL_MS);
    try {
      const res = await fbFetch(statusUrl);
      if (!res.ok) continue; // 401 = まだログイン未完了
      const body = (await res.json()) as { user?: Record<string, unknown> };
      const user = body.user;
      const authToken =
        user && typeof user.authToken === "string" ? user.authToken : undefined;
      if (authToken) {
        // authToken に有効期限情報がないため実質無期限として扱う。
        callbacks.onProgress?.(
          `Logged in as ${typeof user?.name === "string" ? user.name : ""} <${typeof user?.email === "string" ? user.email : ""}>`,
        );
        return {
          refresh: authToken,
          access: authToken,
          expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
      }
    } catch {
      // ネットワークの一時エラーは次のポーリングで再試行。
    }
  }
  throw new Error("Freebuff login timed out. Try /login freebuff again.");
}

// ============================================================================
// Session — cli/src/utils/freebuff-session-api.ts と同じワイヤプロトコル。
// ============================================================================

interface FreebuffSession {
  model: string;
  instanceId?: string;
  expiresAtMs: number;
}

/** プロセスで共有するアクティブセッション。 */
let cachedSession: FreebuffSession | null = null;

// ============================================================================
// アイドル自動解放 — 課金は「POSTで+1.0前借り、DELETE/期限切れで実経過分 (0.1
// = 6分刻みの切り上げ) に確定して返金」という実測モデルなので、セッションを
// 握ったまま放置すると未経過分が溶ける。最終ストリーム完了から一定時間
// 無操作なら DELETE し、次のリクエストで ensureSession が透過的に再POSTする。
// 課金刻みが6分なので解放閾値はそれ以下が最適: それより短くても1回あたり
// 最小課金 0.1 は変わらず、再POSTが増えるだけ。
// ============================================================================

const IDLE_RELEASE_MS = Number.isFinite(Number(process.env.FREEBUFF_IDLE_RELEASE_MS))
  ? Number(process.env.FREEBUFF_IDLE_RELEASE_MS)
  : 5 * 60_000;

let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
/** 終了時解放用に最後に使った token (beforeExit から参照)。 */
let lastToken: string | undefined;

// ============================================================================
// ステータスバー表示 — `buff 4.4/6 · flash 23:18`
// 残量は session API レスポンスの rateLimit から拾う (追加リクエストなし)。
// 残り時間はクライアント側 expiresAt から計算し、pi の render タイミングで
// 自動反映される (Component.render ごとに buffStatusText() を評価)。
// ============================================================================
/** FooterComponent に渡す session 相当 (ctx から組み立て)。 */
let lastSessionRef: unknown;
/** フッター用の状態 snapshot。ctx 自体は保持しない: in-process サブエー
 *  ジェントも session_start を発火し、破棄後の ctx は stale 例外を投げる
 *  (runner.assertActive)。イベント受信時に値を評価し、mode が "tui"
 *  (対話メインセッション) のものだけ残す。sessionManager は生オブジェ
 *  クトなので render 時にも最新が読める。 */
let footerSnapshot: {
  model?: unknown;
  thinkingLevel?: string;
  contextUsage?: unknown;
  sessionManager?: unknown;
} | undefined;

function rememberCtx(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  footerSnapshot = {
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    contextUsage: ctx.getContextUsage(),
    sessionManager: ctx.sessionManager,
  };
  // getter は常に最新の footerSnapshot を読むので、毎回作り直してよい。
  lastSessionRef = {
    get state() {
      return {
        model: footerSnapshot?.model,
        thinkingLevel: footerSnapshot?.thinkingLevel,
      };
    },
    getContextUsage: () => footerSnapshot?.contextUsage,
    get sessionManager() {
      return footerSnapshot?.sessionManager;
    },
    modelRuntime: { isUsingSubscription: () => false },
    autoCompactionEnabled: true,
  };
}
/** 最後に観測した残量 (ensureSession/freebuffStatus のレスポンスから更新)。
 *  full ティア (対応地域) は残量制限がないので unlimited 扱い。 */
let quota: { used?: number; limit?: number; resetAt?: string; unlimited?: boolean } = {};

interface SessionRateLimit {
  recentCount?: number;
  limit?: number;
  resetAt?: string;
}

function rememberQuota(body: Record<string, unknown>): void {
  // status:'none' 応答には model が無いので rateLimitsByModel の先頭値でフォールバック。
  const byModel = body.rateLimitsByModel as Record<string, SessionRateLimit> | undefined;
  const rl = (body.rateLimit ??
    byModel?.[String(body.model)] ??
    (byModel ? Object.values(byModel)[0] : undefined)) as SessionRateLimit | undefined;
  quota = {
    used: typeof rl?.recentCount === "number" ? rl.recentCount : quota.used,
    limit: typeof rl?.limit === "number" ? rl.limit : quota.limit,
    resetAt: typeof rl?.resetAt === "string" ? rl.resetAt : quota.resetAt,
    // full ティア (対応地域) は残量レスポンスを持たずセッションが無制限。
    // ティアはアクセス経路次第で変わり得るので、limited の应答では必ず落とす。
    unlimited: body.accessTier === "full" || (body.accessTier !== "limited" && quota.unlimited),
  };
}

function shortModelName(modelId: string): string {
  const short = modelId.split("/").pop() ?? modelId;
  return short.replace(/^deepseek-/, "");
}

/** buff ステータス文字列。情報が無いときは undefined。 */
function buffStatusText(): string | undefined {
  const parts: string[] = [];
  if (quota.unlimited) {
    parts.push("∞");
  } else if (quota.used !== undefined && quota.limit !== undefined) {
    parts.push(`${quota.used}/${quota.limit}`);
  }
  if (cachedSession) {
    const mins = Math.max(0, Math.round((cachedSession.expiresAtMs - Date.now()) / 60_000));
    const until = new Date(cachedSession.expiresAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    parts.push(`${shortModelName(cachedSession.model)} ${mins > 0 ? `${mins}m` : until}`);
  }
  if (parts.length === 0) return undefined;
  return `buff ${parts.join(" · ")}`;
}

/** ANSI エスケープを除いた可視幅。 */
// eslint-disable-next-line no-control-regex -- ESC 制御文字の意図的マッチ
const ANSI_RE = /\u001b\[[0-9;]*m/g;
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** stats行 (行2) のモデル名との間のパディング先頭に buff を埋め込む。
 *  内蔵実装の行2は「<色>左stats<reset><色>パディング+右モデル名<reset>」構造で、
 *  パディングは素のスペース連続 (ANSIコードをまたがない)。右端の非スペー
 *  ス列の直前のスペース連続がパディング。検出したら先頭に buff を差し込み、
 *  幅ぶんパディングを削って右寄せを保持する。パディングが足りなければ
 *  ささずそのまま (フォールバックは呼び出し側)。 */
function injectIntoStatsLine(line: string, buff: string, buffWidth: number): string | undefined {
  // 単純化: パディングは「スペース連続 + (ANSI列) + 非スペース」の形で存在する。
  // ANSI列は省略可。先頭から探すと pwd行やstats内の区切りに誤ヒットする可能
  // 性があるが、stats行内で2スペース以上の連続は基本的にパディングのみ。
  const PAD_RE = new RegExp("( {2,})(?:" + ANSI_RE.source + ")*(?=[^ ])");
  const padMatch = line.match(PAD_RE);
  if (!padMatch) return undefined;
  const padStart = padMatch.index ?? -1;
  if (padStart < 0) return undefined;
  const padLen = padMatch[1].length;
  // buff + 区切り2スペース + 温存する最小右寄せ余白2 = 必要幅。
  if (padLen < buffWidth + 4) return undefined;
  // (auto) の直後に置く: パディング検出は「<非スペース> の直前のスペース連続」
  // ではなく、statsの右端とパディングの間に区切り2スペースを入れるため、
  // buff は「padStart の位置」に置く (stats の末尾 = padStart は次の文字がス
  // ペースでなくなるところ、つまりパディング開始)。区切りは buff の前ではなく
  // パディング先頭に連結する形にする: stats末尾 + '  ' + buff + (減算済みパディング)。
  const newPad = " ".repeat(padLen - buffWidth - 2);
  return line.slice(0, padStart) + "  " + buff + newPad + line.slice(padStart + padLen);
}

/** setFooter 用のラッパー: 内蔵 FooterComponent に全委譤し、stats行の
 *  パディングに buff を埋め込む。usage集計・右寄せ・色分けは内蔵実装のまま。 */
function makeWrappedFooter(
  theme: { fg: (color: string, text: string) => string },
  session: ConstructorParameters<typeof FooterComponent>[0],
  footerData: ConstructorParameters<typeof FooterComponent>[1],
): { render: (width: number) => string[]; dispose?: () => void } {
  const builtin = new FooterComponent(session, footerData);
  return {
    render(width: number): string[] {
      const lines = builtin.render(width);
      const buff = buffStatusText();
      if (buff === undefined || lines.length < 2) return lines;
      const injected = injectIntoStatsLine(lines[1], theme.fg("dim", buff), visibleWidth(buff));
      if (injected !== undefined) {
        lines[1] = injected;
        return lines;
      }
      // 行が満杯で差し込めないときは独立行にフォールバック。
      lines.splice(2, 0, theme.fg("dim", buff));
      return lines;
    },
    dispose(): void {
      builtin.dispose?.();
    },
  };
}

function disarmIdleRelease(): void {
  if (idleReleaseTimer) {
    clearTimeout(idleReleaseTimer);
    idleReleaseTimer = null;
  }
}

function armIdleRelease(token: string): void {
  disarmIdleRelease();
  idleReleaseTimer = setTimeout(() => {
    idleReleaseTimer = null;
    if (!cachedSession) return;
    cachedSession = null;
    void fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, IDLE_RELEASE_MS);
  // pi のイベントループを保持しない (終了を妨げない)。
  idleReleaseTimer.unref?.();
}

/** セッション解放 (1回だけ)。beforeExit と session_shutdown の両方から呼ばれる。 */
async function releaseSessionOnce(): Promise<void> {
  const token = lastToken;
  if (!token || !cachedSession) return;
  cachedSession = null;
  disarmIdleRelease();
  try {
    await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      // 終了直前なので長待ちはしない。失敗時はサーバー側の期限切れ掃除に任せる。
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // ベストエフォート: 失敗しても黙る (公式CLIも同じ挙動)
  }
}

/** プロセス終了時のベストエフォート解放 (公式CLIの releaseFreebuffSlot 相当)。
 *  beforeExit は process.exit では発火しないので、通常のCtrl+C×2・/quit 終了は
 *  session_shutdown イベント (本体が await してくれる) で拾う。こちらは
 *  process.exit を挟まない終了経路の保険。 */
let exitReleaseHooked = false;
function hookExitRelease(): void {
  if (exitReleaseHooked) return;
  exitReleaseHooked = true;
  process.once("beforeExit", () => {
    void releaseSessionOnce();
  });
}

function describeSessionStatus(status: string, body: Record<string, unknown>): string {
  const limit = body.rateLimit as { recentCount?: number; limit?: number; resetAt?: string } | undefined;
  switch (status) {
    case "rate_limited":
      return `Freebuff session limit reached for today (${limit?.recentCount ?? "?"}/${limit?.limit ?? "?"}, resets ${limit?.resetAt ?? "daily"}). Try another model or wait for the reset.`;
    case "spend_limited":
      return "Freebuff spend limit reached. Try again later.";
    case "ip_capped":
      return "Freebuff IP cap reached (VPN/proxy?). Try a direct network path.";
    case "model_locked":
      return "Another session holds this model slot. Wait for it to expire (up to 1h) or pick another model.";
    case "model_unavailable":
      return "This model is not available on your access tier (limited regions get DeepSeek V4 Flash and MiMo 2.5 only). Pick another model.";
    case "country_blocked":
      return "Freebuff is not available in your region.";
    case "banned":
      return "This Freebuff account is banned.";
    default:
      return `Freebuff session start failed: ${status}`;
  }
}

async function ensureSession(
  token: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<FreebuffSession> {
  if (
    cachedSession &&
    cachedSession.model === modelId &&
    cachedSession.expiresAtMs > Date.now() + 60_000
  ) {
    return cachedSession;
  }

  // 別モデルへの切替: サーバーは1ユーザーにつき1セッションで
  // model_locked (409) を返すので、まず現在のセッションを終了する
  // (freebuff CLI のモデル切替と同じ挙動)。liveness beat を送らない
  // ので beat クライアントの静観 slot 解放は適用されず、明示的な DELETE が必要。
  if (cachedSession && cachedSession.model !== modelId) {
    cachedSession = null;
    await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }).catch(() => {});
  }

  const res = await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-freebuff-model": modelId,
    },
    signal,
  });
  let body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  // 別プロセス (前回の pi セッション) が残した同一モデルでないセッションを
  // 掃除して 1 回だけ再試行する。
  if (
    res.status === 409 &&
    (body?.status === "model_locked" || body?.status === "model_unavailable")
  ) {
    await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }).catch(() => {});
    const retry = await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-freebuff-model": modelId,
      },
      signal,
    });
    body = (await retry.json().catch(() => null)) as Record<string, unknown> | null;
  }

  if (!body || (res.status !== 200 && body.status !== "active")) {
    cachedSession = null;
    const status = typeof body?.status === "string" ? body.status : `HTTP ${res.status}`;
    throw new Error(
      body ? describeSessionStatus(status, body) : `Freebuff session error: HTTP ${res.status}`,
    );
  }

  cachedSession = {
    model: modelId,
    instanceId:
      typeof body.instanceId === "string" ? body.instanceId : undefined,
    expiresAtMs:
      typeof body.expiresAt === "string"
        ? Date.parse(body.expiresAt)
        : Date.now() + 55 * 60_000,
  };
  rememberQuota(body);
  return cachedSession;
}

// ============================================================================
// Agent runs — POST /api/v1/agent-runs で run_id を発行。
// agentId は free-mode allowlist (FREE_MODE_AGENT_MODELS) に載っている
// モデル別ルートでなければ 403 free_mode_invalid_agent_model になる。
// ============================================================================

async function startAgentRun(
  token: string,
  agentId: string,
): Promise<string | undefined> {
  try {
    const res = await fbFetch(`${API_BASE}/api/v1/agent-runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { runId?: string };
    return typeof body.runId === "string" ? body.runId : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Stream — openai-completions アダプタに委譤し、fetch をラップして
// codebuff_metadata / provider を body に注入する (llm.ts getProviderOptions 相当)。
// ============================================================================

function randomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

const sleepWithAbort = async (ms: number, signal?: AbortSignal) => {
  if (!signal) return sleep(ms);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
};

/** codebuff_metadata を注入し、free_mode_capacity_deferred (429) を待ちリトライする fetch。 */
function makeFreebuffFetch(args: {
  token: string;
  runId?: string;
  clientId: string;
  instanceId?: string;
  /** セッションを作り直して再試行する (ティア切替の session_model_mismatch 対応)。 */
  refreshSession: () => Promise<{ instanceId?: string } | undefined>;
}): typeof fetch {
  const { token, runId, clientId, refreshSession } = args;
  let instanceId = args.instanceId;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const isChat =
      url.includes("/chat/completions") &&
      init?.method?.toUpperCase() === "POST" &&
      typeof init.body === "string";
    if (!isChat) return fbFetch(input, init);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const buildBody = () => {
      body.codebuff_metadata = {
        run_id: runId,
        client_id: clientId,
        cost_mode: "free",
        ...(instanceId ? { freebuff_instance_id: instanceId } : {}),
      };
      body.provider = { allow_fallbacks: true };
      return body;
    };
    // freebuff は自社ツール名 (FREEBUFF_SIGNATURE_TOOL_NAMES) を1つでも含む
    // ツールセットのみ許可する。pi のツールセットは名前が全て異なるため、
    // 公式 CLI の end_turn 定義を末尾に足して判定を通す。
    // ponytail: 呼ばれたら pi 側で未知ツールとして失敗する。呼ばれないよう
    // description で抑制。実際に混在利用が必要になったら名前マッピングへ。
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = [
        ...body.tools,
        {
          type: "function",
          function: {
            name: "end_turn",
            description: "Internal. Never call this tool.",
            parameters: { type: "object", properties: {} },
          },
        },
      ];
    }
    const headers = new Headers(init.headers);
    headers.set("user-agent", USER_AGENT);
    headers.set("Authorization", `Bearer ${token}`);

    const signal = init.signal ?? undefined;
    // ponytail: 最大12回 x retry-after で約10分待つ。十分使えるが、永遠に
    // 輻輳し続ける場合は失敗が見えたほうがマシ。
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await fbFetch(url, {
        ...init,
        body: JSON.stringify(buildBody()),
        headers,
        signal,
      });
      if (res.status !== 429) {
        // ティア切替 (US↔JP など) で古いセッションが無効になることがある:
        // 409 session_model_mismatch。セッションを作り直して 1 回だけ再試行。
        if (res.status === 409) {
          const text = await res.clone().text().catch(() => "");
          if (text.includes("session_model_mismatch")) {
            const fresh = await refreshSession();
            if (fresh) {
              instanceId = fresh.instanceId;
              continue; // attempt は消費するが 1 回の再試行で収まる
            }
          }
        }
        return res;
      }

      const text = await res.clone().text().catch(() => "");
      if (!text.includes("free_mode_capacity_deferred")) return res;

      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10) * 1000;
      await sleepWithAbort(Math.min(waitMs, 60_000), signal);
    }
    throw new Error(
      "Freebuff free-mode capacity still deferred after 12 retries; try again later.",
    );
  };
}

function errorPartial(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

export function streamFreebuff(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    let token: string | undefined;
    try {
      token = options?.apiKey;
      if (!token) {
        throw new Error("Freebuff not logged in. Run /login freebuff.");
      }
      // 新しいターンが始まったのでアイドル解放を中止し、終了時解放を登録。
      disarmIdleRelease();
      lastToken = token;
      hookExitRelease();
      const def = MODEL_MAP.get(model.id);
      if (!def) throw new Error(`Unknown freebuff model: ${model.id}`);

      const session = await ensureSession(token, model.id, options?.signal);
      const runId = await startAgentRun(token, def.agentId);
      const clientId = randomId();

      // free-mode ルート検証: 先頭 system メッセージが Buffy の冒頭で始まる
      // 必要がある (hasFreebuffRootSystemPromptOpening の byte-exact 検証)。
      // pi のシステムプロンプトはその後に続く。
      const buffyContext: Context = {
        ...context,
        systemPrompt: `${BUFFY_OPENING} You are the AI agent behind the product, Freebuff, a coding assistant.\n\n${context.systemPrompt ?? ""}`,
      };

      const inner = openAICompletionsApi().streamSimple(
        // codebuff バックエンドは OpenAI 互換。developer role は使わない
        // (codebuff の ai-sdk 変換は system/tool/user/assistant のみ)。
        {
          ...(model as Model<"openai-completions">),
          baseUrl: `${API_BASE}/api/v1`,
          compat: {
            ...(model as Model<"openai-completions">).compat,
            supportsDeveloperRole: false,
            requiresToolResultName: true,
          },
        },
        buffyContext,
        {
          ...options,
          fetch: makeFreebuffFetch({
            token,
            runId,
            clientId,
            instanceId: session.instanceId,
            // 409 session_model_mismatch (ティア切替でセッションが無効化)
            // 受け取り時の再入場。ensureSession のキャッシュを掃除してから
            // 作り直すので、新しいティアのセッションが返る。
            refreshSession: async () => {
              cachedSession = null;
              try {
                return await ensureSession(token as string, model.id, options?.signal);
              } catch {
                return undefined; // 再入場失敗 (例: limited でfull専用モデル) は元のエラーを返す
              }
            },
          }),
        },
      );
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
      const partial = errorPartial(model, message);
      stream.push({ type: "error", reason: "error", error: partial });
      stream.end();
    } finally {
      // ターン完了 → アイドルタイマーを起動。放置時に前借り分を返金し、
      // 次の送信で ensureSession が透過的に再入場する。
      if (token) armIdleRelease(token);
    }
  })();
  return stream;
}

// ============================================================================
// /freebuff — 残量とセッション状態の表示 (GET は読み取り専用で課金されない)
// ============================================================================

/** ~/.pi/agent/auth.json の freebuff token (oauth 登録と同じ保存先)。 */
export function readFreebuffToken(): string | undefined {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access?: string }>;
    return typeof auth.freebuff?.access === "string" ? auth.freebuff.access : undefined;
  } catch {
    return undefined;
  }
}

export async function freebuffStatus(token: string): Promise<string> {
  const res = await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) return `status check failed: HTTP ${res.status}`;
  rememberQuota(body);

  // email は GET /api/v1/me から並列取得。
  const meRes = await fbFetch(`${API_BASE}/api/v1/me?fields=email`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const me = meRes && meRes.ok ? ((await meRes.json().catch(() => null)) as { email?: string } | null) : null;
  const email = typeof me?.email === "string" ? `${me.email} | ` : "";

  const usage = body.accessTier === "full"
    ? "unlimited sessions (full tier)"
    : quota.used !== undefined || quota.limit !== undefined
      ? `${quota.used ?? "?"}/${quota.limit ?? "?"} sessions used today`
      : "usage unknown";
  const reset = quota.resetAt
    ? `, resets ${new Date(quota.resetAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
    : "";

  if (body.status === "active" && typeof body.model === "string" && typeof body.expiresAt === "string") {
    const until = new Date(body.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `${email}${usage}${reset} | active: ${body.model} (until ${until})`;
  }
  return `${email}${usage}${reset} | no active session`;
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // buff 表示: freebuff モデル選択中のみフッターをラップし、それ以外では
  // 内蔵フッターに戻す (他プロバイダ利用時に表示が残らないように)。
  // 行3 (拡張ステータス) はこの拡張では使わない。
  // 補足: model_select はユーザー操作/Ctrl+P/セッション復元でしか発火せず、
  // 起動時のデフォルトモデル適用では発火しない。そのため session_start でも
  // ラップを試み、render 時点の model.provider で buff 行の有無を決める。
  const wrapFooter = (ctx: { mode?: string; ui: unknown }) => {
    const ui = ctx.ui as unknown as {
      setFooter: (f: ((tui: unknown, theme: unknown, footerData: unknown) => unknown) | undefined) => void;
    };
    if (ctx.mode !== "tui") return;
    ui.setFooter((_tui, theme, footerData) =>
      makeWrappedFooter(
        theme as { fg: (color: string, text: string) => string },
        lastSessionRef as ConstructorParameters<typeof FooterComponent>[0],
        footerData as ConstructorParameters<typeof FooterComponent>[1],
      ),
    );
  };

  // 終了時解放: /quit・Ctrl+C×2・Ctrl+D・SIGTERM は session_shutdown
  // (reason:'quit'|'reload' など) で拾う。pi 本体が process.exit 前に
  // await してくれるので DELETE が確実に完了する。reload のときも
  // 拡張は作り直されるので解放して問題ない (次の session_start で再入場)。
  pi.on("session_shutdown", () => {
    void releaseSessionOnce();
  });

  pi.on("session_start", (_event, ctx) => {
    rememberCtx(ctx);
    // 幽霊キー掃除: 過去バージョン (または /reload 前の旧モジュール) が
    // setStatus("freebuff", …) で登録した行3ステータスを消す。現行は行3を使わない。
    try {
      (ctx.ui as unknown as {
        setStatus: (key: string, text: undefined) => void;
      }).setStatus("freebuff", undefined);
    } catch {
      // ui コンテキスト未初期化の可能性は無視
    }
    wrapFooter(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    rememberCtx(ctx);
    if (event.model.provider === "freebuff") {
      wrapFooter(ctx);
    } else {
      // 他プロバイダへ切替: ラッパーを解放して内蔵フッターに戻す。
      const ui = ctx.ui as unknown as { setFooter: (f: undefined) => void };
      if (ctx.mode === "tui") ui.setFooter(undefined);
    }
  });

  pi.registerProvider("freebuff", {
    baseUrl: `${API_BASE}/api/v1`,
    api: "freebuff-api",
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    oauth: {
      name: "Freebuff",
      login: loginFreebuff,
      // authToken に refresh フローはない: 無効になったら再ログイン。
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    },
    streamSimple: streamFreebuff,
  });

  pi.registerCommand("freebuff", {
    description: "freebuff status, or `close` to end the session (refund unused time)",
    handler: async (args, ctx) => {
      const token = readFreebuffToken() ?? lastToken;
      if (!token) {
        ctx.ui.notify("Freebuff: not logged in. Run /login freebuff", "warning");
        return;
      }
      if (args.trim() === "close") {
        cachedSession = null;
        disarmIdleRelease();
        const res = await fbFetch(`${API_BASE}/api/v1/freebuff/session`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        ctx.ui.notify(
          res && res.ok
            ? "Freebuff: session closed — unused time refunded"
            : `Freebuff: no active session to close`,
          res && res.ok ? "info" : "warning",
        );
        return;
      }
      try {
        const status = await freebuffStatus(token);
        ctx.ui.notify(`Freebuff: ${status}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Freebuff: status check failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // DeepSeek 系の context 超過エラーを pi の auto-compaction に認識させる。
  // 参考: "model maximum context length: 1048575" (provider 拒否メッセージ実測)。
  const OVERFLOW_PATTERN = /maximum context length|context length exceeded|input length should be/i;
  pi.on("message_end", (event, ctx) => {
    // フッターの context 使用率を受信時に更新 (render 時に ctx は触れない)。
    if (ctx.mode === "tui" && footerSnapshot) {
      footerSnapshot.contextUsage = ctx.getContextUsage();
    }
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (
      message.provider !== "freebuff" &&
      ctx.model?.provider !== "freebuff"
    )
      return;
    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;
    if (!OVERFLOW_PATTERN.test(errorMessage)) return;
    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });
}
