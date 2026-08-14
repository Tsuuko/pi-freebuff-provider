/**
 * スタンドアロンログイン: freebuff.com の device-code フローで authToken を取得し
 * ~/.pi/agent/auth.json に "freebuff" エントリを書き込む (index.ts の oauth.login と同じ手順)。
 *
 * 使い方: node --experimental-strip-types scripts/login.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOGIN_BASE = process.env.FREEBUFF_LOGIN_URL ?? "https://freebuff.com";
const AUTH_JSON = join(homedir(), ".pi", "agent", "auth.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fingerprintId = `codebuff-cli-${Math.random().toString(36).slice(2, 10)}`;

const res = await fetch(`${LOGIN_BASE}/api/auth/cli/code`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fingerprintId }),
});
if (!res.ok) throw new Error(`login code failed: ${res.status}`);
const { loginUrl, fingerprintHash, expiresAt } = await res.json();

console.log("\n=== このURLをブラウザで開いてログインしてください ===\n");
console.log(loginUrl);
console.log("\n(ポーリング中... 5分でタイムアウト)\n");

const statusUrl = `${LOGIN_BASE}/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fingerprintHash)}&expiresAt=${encodeURIComponent(String(expiresAt))}`;

const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  await sleep(5000);
  const r = await fetch(statusUrl).catch(() => null);
  if (!r || !r.ok) continue;
  const body = await r.json();
  if (body?.user?.authToken) {
    const auth = JSON.parse(readFileSync(AUTH_JSON, "utf8"));
    auth.freebuff = {
      refresh: body.user.authToken,
      access: body.user.authToken,
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
      type: "oauth",
    };
    writeFileSync(AUTH_JSON, JSON.stringify(auth, null, 2));
    console.log(`✓ Logged in as ${body.user.name} <${body.user.email}> — saved to ${AUTH_JSON}`);
    process.exit(0);
  }
}
console.error("Login timed out.");
process.exit(1);
