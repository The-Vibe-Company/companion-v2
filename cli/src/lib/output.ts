import pc from "picocolors";
import type { ValidationResult } from "@companion/contracts";

export interface GlobalOpts {
  profile: string;
  org?: string;
  json: boolean;
}

export function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function err(line: string): void {
  process.stderr.write(line + "\n");
}

export function emitJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** Render a check list (push / validate). */
export function printValidation(result: ValidationResult, json: boolean): void {
  if (json) return;
  for (const c of result.checks) {
    const mark = c.status === "pass" ? pc.green("ok") : pc.red("fail");
    const detail = c.detail ? pc.dim(`  ${c.detail}`) : "";
    out(`  ${mark}  ${c.label}${detail}`);
  }
}

/** A compact aligned table for human output. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  out(pc.dim(fmt(headers)));
  for (const r of rows) out(fmt(r));
}

export function colorState(state: string): string {
  switch (state) {
    case "up-to-date":
      return pc.green(state);
    case "outdated":
      return pc.yellow(state);
    case "modified":
    case "conflict":
      return pc.red(state);
    case "pinned":
      return pc.cyan(state);
    default:
      return pc.dim(state);
  }
}
