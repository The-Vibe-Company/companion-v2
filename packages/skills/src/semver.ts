import { SEMVER_RE } from "@companion/contracts";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string;
}

export function parseSemver(input: string): Semver | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
    build: m[5] ?? "",
  };
}

export function isValidSemver(input: string): boolean {
  return SEMVER_RE.test(input.trim());
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease ranks higher than any prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** -1 if a < b, 0 if equal (ignoring build metadata), 1 if a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`invalid semver: ${!pa ? a : b}`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function gtSemver(a: string, b: string): boolean {
  return compareSemver(a, b) > 0;
}

export type BumpKind = "major" | "minor" | "patch";

export function bumpSemver(version: string, kind: BumpKind): string {
  const p = parseSemver(version);
  if (!p) throw new Error(`invalid semver: ${version}`);
  switch (kind) {
    case "major":
      return `${p.major + 1}.0.0`;
    case "minor":
      return `${p.major}.${p.minor + 1}.0`;
    case "patch":
      return `${p.major}.${p.minor}.${p.patch + 1}`;
  }
}

/** Highest version in `candidates` that satisfies a simple pin (exact | ^x.y.z | ~x.y.z | null). */
export function resolvePin(pinned: string | null, candidates: string[]): string | null {
  const valid = candidates.filter(isValidSemver).sort((a, b) => compareSemver(a, b));
  if (valid.length === 0) return null;
  if (pinned === null || pinned === "" || pinned === "*") return valid[valid.length - 1] ?? null;
  if (isValidSemver(pinned)) return valid.includes(pinned) ? pinned : null; // exact pin
  const range = parseRange(pinned);
  if (!range) return null;
  const inRange = valid.filter((v) => satisfiesRange(v, range));
  return inRange.length ? (inRange[inRange.length - 1] ?? null) : null;
}

interface Range {
  op: "^" | "~";
  base: Semver;
}

function parseRange(input: string): Range | null {
  const op = input[0];
  if (op !== "^" && op !== "~") return null;
  const base = parseSemver(input.slice(1));
  if (!base) return null;
  return { op, base };
}

function satisfiesRange(version: string, range: Range): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  if (compareSemver(version, formatBase(range.base)) < 0) return false;
  if (range.op === "^") {
    if (range.base.major > 0) return v.major === range.base.major;
    if (range.base.minor > 0) return v.major === 0 && v.minor === range.base.minor;
    return v.major === 0 && v.minor === 0 && v.patch === range.base.patch;
  }
  // ~: allow patch-level changes within the same major.minor
  return v.major === range.base.major && v.minor === range.base.minor;
}

function formatBase(s: Semver): string {
  return `${s.major}.${s.minor}.${s.patch}`;
}
