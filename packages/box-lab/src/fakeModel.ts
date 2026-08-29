export const BOX_LAB_FAKE_MODEL_ID = "box-lab-deterministic";
export const BOX_LAB_FAKE_PROVIDER_ID = "box-lab";
export const BOX_LAB_FAKE_MODEL_PORT = 18_099;

export function boxLabModelsJson(): string {
  const model = {
    id: BOX_LAB_FAKE_MODEL_ID,
    name: "Box Lab deterministic model",
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${BOX_LAB_FAKE_MODEL_PORT}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_024,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
  };
  return `${JSON.stringify({
    providers: {
      [BOX_LAB_FAKE_PROVIDER_ID]: {
        baseUrl: model.baseUrl,
        api: model.api,
        models: [model],
      },
    },
  }, null, 2)}\n`;
}

/** This source runs inside the disposable Box. It never receives a real provider credential. */
export function fakeModelServerSource(port = BOX_LAB_FAKE_MODEL_PORT): string {
  return `import { createServer } from "node:http";

const port = ${port};
const responseText = "box-lab-deterministic-ok";

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    json(response, 404, { error: { message: "not found", type: "invalid_request_error" } });
    return;
  }
  const chunks = [];
  try {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  } catch {
    response.destroy();
    return;
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { json(response, 400, { error: { message: "invalid json", type: "invalid_request_error" } }); return; }
  const id = "chatcmpl-box-lab";
  const created = 1;
  if (body.stream !== true) {
    json(response, 200, {
      id, object: "chat.completion", created, model: "${BOX_LAB_FAKE_MODEL_ID}",
      choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (choice) => response.write("data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created, model: "${BOX_LAB_FAKE_MODEL_ID}", choices: [choice],
  }) + "\\n\\n");
  send({ index: 0, delta: { role: "assistant" }, finish_reason: null });
  send({ index: 0, delta: { content: responseText }, finish_reason: null });
  send({ index: 0, delta: {}, finish_reason: "stop" });
  response.write("data: [DONE]\\n\\n");
  response.end();
}).listen(port, "127.0.0.1");
`;
}

export function fakeModelSystemdUnit(): string {
  return `[Unit]
Description=Companion Box Lab deterministic model
After=network.target

[Service]
Type=simple
Environment=PATH=/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env node /home/user/.box-lab/fake-model.mjs
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
`;
}
