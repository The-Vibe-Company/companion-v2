#!/usr/bin/env node

import { spawn } from "node:child_process";

// Reproduce Node's documented gap between `exit` and `close`: the direct child exits after it
// receives one RPC, while a short-lived descendant keeps the inherited stdout pipe open.
process.stdin.once("data", () => {
  const pipeHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
    stdio: ["ignore", process.stdout, "ignore"],
  });
  pipeHolder.unref();
  process.exit(0);
});
