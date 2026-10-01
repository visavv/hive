/**
 * Demo turns for the mock agent (MOCK_DEMO=1): scripted but realistic work, used
 * only to take README screenshots (test/showcase.ts). Nothing here calls a model.
 */
import * as acp from "@agentclientprotocol/sdk";

type Ctx = acp.AgentContext;
type Call = (name: string, args: Record<string, unknown>) => Promise<string>;
type Ask = (title: string, kind: string, content?: unknown[]) => Promise<boolean>;

let seq = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CLIENT_OLD = `export async function request(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, init);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}`;
const CLIENT_NEW = `export async function request(path: string, init?: RequestInit) {
  await limiter.take(); // 10 req/s, burst 20
  const res = await withRetry(() => fetch(BASE + path, init), { retries: 3, on: [429, 503] });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}`;

export async function demoTurn(cx: Ctx, sessionId: string, text: string, call: Call, ask: Ask, me: string): Promise<{ tokens: number }> {
  const up = (update: Record<string, unknown>) => cx.notify(acp.methods.client.session.update, { sessionId, update } as any);
  const say = async (t: string) => {
    for (const part of t.match(/[\s\S]{1,80}/g) ?? []) {
      await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
      await wait(8);
    }
  };
  const think = (t: string) => up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: t } });
  const tool = async (title: string, kind: string, content: unknown[] = [], locations: unknown[] = []) => {
    const id = `d${++seq}`;
    await up({ sessionUpdate: "tool_call", toolCallId: id, title, kind, status: "in_progress", locations });
    await wait(60);
    await up({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content });
  };
  const out = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
  const usage = (used: number) => up({ sessionUpdate: "usage_update", used, size: 200_000, cost: { amount: used / 400_000, currency: "USD" } });

  // the briefing rides on the first prompt ("<briefing>\n\n---\n\n<prompt>"); act on the prompt part
  const who = text.match(/You are agent "([^"]+)"/)?.[1] ?? me;
  const sep = text.lastIndexOf("\n\n---\n\n");
  if (sep >= 0 && /You are agent "/.test(text)) text = text.slice(sep + 7);
  if (/^Plan:/m.test(text)) {
    await call("hive_status", { status: "working", note: "planning rate limiting" });
    await think("The client has one fetch wrapper; every call goes through request(). Rate limiting belongs there, plus retry on 429.");
    await tool("Read src/api/client.ts", "read", [], [{ path: "src/api/client.ts" }]);
    await tool("Read src/api/endpoints.ts", "read", [], [{ path: "src/api/endpoints.ts" }]);
    await tool("Search \"request(\" in src", "search", out("src/api/endpoints.ts: 14 matches\nsrc/sync/worker.ts: 3 matches"));
    await up({
      sessionUpdate: "plan",
      entries: [
        { content: "Token-bucket limiter (10 req/s, burst 20) in src/api/limiter.ts", priority: "high", status: "completed" },
        { content: "Wrap request() with the limiter and retry on 429/503", priority: "high", status: "in_progress" },
        { content: "Honour Retry-After headers", priority: "medium", status: "pending" },
        { content: "Unit tests: burst, steady rate, retry, give-up", priority: "medium", status: "pending" },
        { content: "Docs: rate limits in README", priority: "low", status: "pending" },
      ],
    });
    await call("hive_bb_set", { key: "plan/rate-limit", value: "1 limiter ✓ · 2 wrap request() · 3 Retry-After · 4 tests · 5 docs" });
    await call("hive_send", { to: "coder", subject: "task 2: wrap request()", body: "Use limiter.take() before fetch and withRetry() on 429/503 (3 tries, backoff). Acceptance: existing tests pass, new tests for retry." });
    await say(
      "## Plan: rate limiting for the API client\n\nAll **17 call sites** go through `request()` in `src/api/client.ts`, so one change covers everything.\n\n1. ~~Limiter~~ done: token bucket, 10 req/s, burst 20\n2. **Now:** wrap `request()` with the limiter and retry on `429` / `503`\n3. Honour `Retry-After`\n4. Tests for burst, steady rate, retry and give-up\n\nI sent task 2 to **coder**. Reviewer and tester pick up its commits automatically.",
    );
    await call("hive_status", { status: "idle", note: "waiting on coder: task 2" });
    await usage(38_400);
    return { tokens: 4210 };
  }

  if (/\bimplement\b/i.test(text)) {
    await call("hive_status", { status: "working", note: "task 2: wrap request()" });
    await think("Retry must not retry non-idempotent POSTs blindly; only 429/503, which the server guarantees were not applied.");
    await tool("Read src/api/client.ts", "read", [], [{ path: "src/api/client.ts" }]);
    await tool("Read src/api/limiter.ts", "read", [], [{ path: "src/api/limiter.ts" }]);
    await tool("Edit src/api/client.ts", "edit", [{ type: "diff", path: "src/api/client.ts", oldText: CLIENT_OLD, newText: CLIENT_NEW }], [{ path: "src/api/client.ts" }]);
    await tool("npm test -- api", "execute", out("✓ limiter: burst of 20 passes (3 ms)\n✓ limiter: 21st waits ~100 ms (104 ms)\n✓ request: retries 429 twice then succeeds (12 ms)\n✓ request: gives up after 3 tries (9 ms)\n\nTests: 4 passed, 4 total"));
    await say("Wrapped `request()`: limiter first, then `withRetry()` on **429/503** only (3 tries, exponential backoff with jitter). The 4 new tests pass.\n\nNext I'm adding `Retry-After` support in a new helper.");
    await usage(61_000);
    const ok = await ask("Write src/api/retry.ts", "edit", [
      { type: "diff", path: "src/api/retry.ts", oldText: null, newText: "export function retryAfterMs(h: string | null): number | undefined {\n  if (!h) return undefined;\n  const s = Number(h);\n  return Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(h) - Date.now());\n}" },
    ]);
    await say(ok ? "\n\nWrote `src/api/retry.ts` and committed: `feat(api): rate limit + retry`." : "\n\nOK, leaving retry.ts for now.");
    await call("hive_status", { status: "idle", note: ok ? "committed task 2" : "task 2 waiting" });
    return { tokens: 6830 };
  }

  if (/\breview\b/i.test(text)) {
    await call("hive_status", { status: "working", note: "reviewing hive/coder" });
    await tool("git diff main...hive/coder --stat", "execute", out(" src/api/client.ts  |  6 ++++--\n src/api/limiter.ts | 41 +++++++++++++++++++++++++\n src/api/retry.ts   | 12 ++++++++\n test/api.test.ts   | 58 ++++++++++++++++++++++++++++++++++++\n 4 files changed, 115 insertions(+), 2 deletions(-)"));
    await tool("Read src/api/limiter.ts", "read", [], [{ path: "src/api/limiter.ts" }]);
    await tool("Read test/api.test.ts", "read", [], [{ path: "test/api.test.ts" }]);
    await say(
      "### Review of `hive/coder` (4 files, +115 −2)\n\n| | Finding | Where |\n|---|---|---|\n| **High** | `take()` busy-waits with `setTimeout(0)`; under load it burns CPU | `limiter.ts:27` |\n| Medium | `Retry-After` in HTTP-date form isn't covered by a test | `retry.ts:4` |\n| Low | Magic numbers; export `RATE` and `BURST` | `limiter.ts:3` |\n\nSuggested fix for the first one:\n\n```ts\nconst delay = Math.ceil((1 - this.tokens) / this.rate * 1000);\nawait new Promise((r) => setTimeout(r, delay));\n```\n\nSent to **coder**. Not blocking the merge after that fix.",
    );
    await call("hive_send", { to: "coder", subject: "review: 1 high, 1 medium", body: "limiter.ts:27 busy-waits; sleep for the computed delay instead. retry.ts:4 HTTP-date Retry-After untested." });
    await call("hive_status", { status: "idle", note: "1 high finding sent to coder" });
    await usage(24_900);
    return { tokens: 3120 };
  }

  if (/\btest\b/i.test(text)) {
    await call("hive_status", { status: "working", note: "running the suite on hive/coder" });
    await tool("git checkout --detach hive/coder", "execute", out("HEAD is now at 4e1c9a2 feat(api): rate limit + retry"));
    await tool("npm run typecheck", "execute", out("tsc --noEmit\n(no errors)"));
    await say("Type-check is clean. Running the full suite (412 tests)…\n");
    await usage(17_300);
    await tool("npm test", "execute", out("✓ api (4)\n✓ sync (37)\n✓ auth (52)\n… 318 more\n"));
    await wait(120_000); // stays "working" for the screenshot
    return { tokens: 1900 };
  }

  // briefings and anything else: a short, plain acknowledgement
  await say(`Ready. I'm **${who}**; I'll keep my status note current and report back through hive.`);
  await usage(9_000 + (who.length * 1317) % 6000);
  return { tokens: 420 };
}
