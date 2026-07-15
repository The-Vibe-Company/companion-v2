/**
 * Fast, layer-by-layer diagnosis of ONE live agent sandbox — every step has a hard timeout, so it
 * can never hang. Use this to iterate instead of the full smoke.
 *
 *   DOMAIN=https://sb-xxx.vercel.run PASSWORD=… pnpm --filter @companion/sandbox probe
 *
 * Options via env:
 *   PROBE_PROMPT="…"      also send a prompt and stream RAW events (default: read-only probe)
 *   PROBE_WINDOW_MS=30000 how long to watch the event stream after the prompt
 *
 * Steps: (1) GET /doc (auth) → server up?  (2) GET /event raw fetch (auth) → stream reachable?
 * (3) session list/create  (4) [optional] promptAsync + raw event dump.
 */
import { OPENCODE_SERVER_USERNAME } from "@companion/core";
import { createChatClient, sendPromptAsync } from "../src/opencodeChat";

const DOMAIN = process.env.DOMAIN?.trim();
const PASSWORD = process.env.PASSWORD?.trim();
const PROMPT = process.env.PROBE_PROMPT?.trim();
const WINDOW_MS = Number(process.env.PROBE_WINDOW_MS ?? 30_000);

if (!DOMAIN || !PASSWORD) {
  console.error("Usage: DOMAIN=https://sb-xxx.vercel.run PASSWORD=… pnpm --filter @companion/sandbox probe");
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${PASSWORD}`).toString("base64")}`;

function step(name: string): (outcome: string) => void {
  process.stdout.write(`→ ${name}… `);
  return (outcome: string) => console.log(outcome);
}

async function timed<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // 1 — server answers with auth?
  const doneDoc = step("GET /doc (basic auth, 10s cap)");
  try {
    const res = await timed(10_000, (signal) => fetch(`${DOMAIN}/doc`, { headers: { authorization: AUTH }, signal }));
    doneDoc(`${res.status}${res.status === 410 ? " — SANDBOX STOPPED (needs wake)" : res.ok ? " ok" : ""}`);
    if (res.status === 410) process.exit(2);
  } catch (error) {
    doneDoc(`FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }

  // 2 — the raw event stream opens and sends its first bytes?
  const doneEvt = step("GET /event first bytes (raw fetch, 10s cap)");
  try {
    await timed(10_000, async (signal) => {
      const res = await fetch(`${DOMAIN}/event`, {
        headers: { authorization: AUTH, accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      const reader = res.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      return first;
    });
    doneEvt("ok (stream is authorized and live)");
  } catch (error) {
    doneEvt(`FAILED: ${error instanceof Error ? error.message : error} ← the chat would be silent`);
    process.exit(3);
  }

  // 3 — SDK path: sessions. Pass the deadline signal INTO the SDK call so a hung request aborts.
  const client = createChatClient({ domain: DOMAIN!, password: PASSWORD! });
  const doneList = step("SDK session.list (10s cap)");
  const sessions = await timed(10_000, async (signal) => (await client.session.list({ signal })).data ?? []);
  doneList(`${sessions.length} session(s)`);

  if (!PROMPT) {
    console.log("\nRead-only probe PASSED. Set PROBE_PROMPT=… to test a full prompt round-trip.");
    return;
  }

  // 4 — full round-trip with a raw event dump.
  const session = await timed(10_000, async (signal) => {
    const res = await client.session.create({ body: { title: "probe" }, signal });
    if (!res.data) throw new Error("no session created");
    return { id: res.data.id };
  });
  console.log(`→ session ${session.id} created; prompting + dumping RAW events for ${WINDOW_MS}ms…`);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), WINDOW_MS);
  const dump = (async () => {
    const res = await fetch(`${DOMAIN}/event`, {
      headers: { authorization: AUTH, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.body) throw new Error("no event body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sawIdle = false;
    // Buffer whole SSE frames (separated by a blank line) so a `data:` line split across network
    // chunk boundaries is never mis-parsed.
    let buffer = "";
    try {
      outer: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
            .join("\n");
          if (data) {
            try {
              const evt = JSON.parse(data) as { type?: string };
              console.log(`  [event] ${JSON.stringify(evt).slice(0, 220)}`);
              if (evt.type === "session.idle") {
                sawIdle = true;
                break outer;
              }
            } catch {
              console.log(`  [raw] ${data.slice(0, 160)}`);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
    return sawIdle;
  })();
  await timed(Math.min(WINDOW_MS, 30_000), (signal) =>
    sendPromptAsync(client, session.id, PROMPT, { signal }),
  );
  const sawIdle = await dump.catch((error) => {
    console.error(`  event dump failed: ${error instanceof Error ? error.message : error}`);
    return false;
  });
  clearTimeout(deadline);
  controller.abort();
  console.log(sawIdle ? "\nPrompt round-trip PASSED (session went idle)." : "\nWindow elapsed WITHOUT session.idle — inspect the raw events above.");
  process.exit(sawIdle ? 0 : 4);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
