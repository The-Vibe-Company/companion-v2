#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export function boxCenterFromAgentBrowserPayload(payload) {
  const box = payload?.data?.box ?? payload?.data ?? payload;
  const x = Number(box?.x);
  const y = Number(box?.y);
  const width = Number(box?.width);
  const height = Number(box?.height);
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new Error("agent-browser returned an invalid bounding box");
  }
  return [Math.round(x + width / 2), Math.round(y + height / 2)];
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const [x, y] = boxCenterFromAgentBrowserPayload(JSON.parse(input));
  process.stdout.write(`${x} ${y}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[agent-browser-box-center] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
