#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function iosVersion(runtime) {
  const match = /^iOS (\d+(?:\.\d+)*)$/.exec(runtime?.trim() ?? "");
  return match ? match[1].split(".").map(Number) : null;
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectLatestIOSSimulator(payload) {
  const nativeDevices = payload?.devices;
  const simulators = nativeDevices != null && !Array.isArray(nativeDevices)
    ? Object.entries(nativeDevices).flatMap(([runtime, devices]) => {
        const runtimeMatch = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtime);
        if (!runtimeMatch || !Array.isArray(devices)) return [];
        return devices.map((device) => ({
          ...device,
          simulatorId: device?.udid,
          runtime: `iOS ${runtimeMatch[1].replaceAll("-", ".")}`,
        }));
      })
    : payload?.data?.simulators;
  if (!Array.isArray(simulators)) throw new Error("Invalid simulator list response");

  const candidates = simulators
    .map((simulator) => ({ simulator, version: iosVersion(simulator?.runtime) }))
    .filter(({ simulator, version }) => simulator?.isAvailable !== false && version !== null)
    .sort((left, right) => compareVersions(right.version, left.version));
  const selected = candidates[0]?.simulator;
  const simulatorId = selected?.simulatorId?.trim?.();
  if (!selected || !simulatorId) {
    throw new Error("No available iOS simulator");
  }
  return { ...selected, simulatorId };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: select-ios-simulator.mjs <simulators.json>");
  const payload = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(`${selectLatestIOSSimulator(payload).simulatorId}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[select-ios-simulator] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
