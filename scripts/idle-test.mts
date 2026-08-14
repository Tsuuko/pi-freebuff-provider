/** アイドル自動解放の検証: ターン1 → (15s idle でDELETE) → ターン2 が透過的に再入場するか。 */
import { streamFreebuff } from "../index.ts";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.FREEBUFF_IDLE_RELEASE_MS = "15000";

const token = JSON.parse(
  readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
).freebuff.access;

const model = {
  id: "deepseek/deepseek-v4-flash",
  provider: "freebuff",
  api: "freebuff-api",
  name: "DeepSeek V4 Flash",
  baseUrl: "https://www.codebuff.com/api/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 32_768,
} as unknown as Model<Api>;

const makeContext = (text: string): Context =>
  ({
    systemPrompt: "You are a test harness.",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  }) as unknown as Context;

const runTurn = (label: string, text: string) =>
  new Promise<string>((resolve, reject) => {
    let out = "";
    const s = streamFreebuff(model, makeContext(text), { apiKey: token });
    void (async () => {
      try {
        for await (const e of s as AsyncIterable<{ type: string; delta?: string }>) {
          if (e.type === "text_delta" && e.delta) out += e.delta;
        }
        resolve(out);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    setTimeout(() => reject(new Error(`${label} timed out`)), 90_000).unref?.();
  });

console.log("[t=0] turn1 start");
const r1 = await runTurn("turn1", "Reply with exactly: one");
console.log("[turn1]", JSON.stringify(r1));

console.log("[t+20s] waiting for idle release (15s timer)...");
await new Promise((r) => setTimeout(r, 20_000));

console.log("[t+20s] turn2 start (should transparently re-POST)");
const r2 = await runTurn("turn2", "Reply with exactly: two");
console.log("[turn2]", JSON.stringify(r2));
console.log("PASS");
process.exit(0);
