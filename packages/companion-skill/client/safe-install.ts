import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  companionDependencySlugs,
  companionEnvironmentToRequirements,
  companionManifestSchema,
  skillFrontmatterSchema,
  type SkillRequirement,
} from "@companion/contracts";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { parse as parseYaml } from "yaml";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COUNT = 4_096;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const WIN32_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

export type PublicInstallTool = "claude-code" | "codex" | "opencode";
export type PublicInstallScope = "global" | "project";

export interface PublicInstallPrerequisites {
  dependencies: string[];
  required_env: string[];
  optional_env: string[];
  required_secrets: string[];
  optional_secrets: string[];
}

export interface InspectedPublicSkillZip {
  files: ReadonlyMap<string, Uint8Array>;
  prerequisites: PublicInstallPrerequisites;
}

interface CentralEntry {
  name: string;
  directory: boolean;
  uncompressedSize: number;
}

interface SeenPortablePath {
  display: string;
  kind: "directory" | "file";
}

function windowsPathSegmentViolation(segment: string): string | null {
  if ([...segment].some((character) => character.codePointAt(0)! <= 31) || /[<>:"|?*]/.test(segment)) {
    return "contains a Windows-reserved character";
  }
  if (/[ .]$/.test(segment)) return "ends with a dot or space";
  const basename = (segment.split(".", 1)[0] ?? "").replace(/[ .]+$/, "");
  if (WIN32_RESERVED_BASENAME.test(basename)) return "uses a Windows-reserved device name";
  return null;
}

function registerPortablePath(
  seen: Map<string, SeenPortablePath>,
  name: string,
  directory: boolean,
): void {
  const segments = name.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const display = segments.slice(0, index + 1).join("/");
    const key = display.normalize("NFC").toLocaleLowerCase("en-US");
    const kind = index === segments.length - 1 && !directory ? "file" : "directory";
    const previous = seen.get(key);
    if (
      previous
      && (
        previous.display !== display
        || previous.kind !== kind
        || (index === segments.length - 1 && kind === "file")
      )
    ) {
      throw new Error(`duplicate or Windows-colliding ZIP path: ${name}`);
    }
    if (!previous) seen.set(key, { display, kind });
  }
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("invalid ZIP: end-of-central-directory record is missing");
}

function decodeEntryName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    throw new Error("ZIP entry names must be ASCII or explicitly UTF-8 encoded");
  }
  try {
    return new TextDecoder(utf8 ? "utf-8" : "ascii", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP contains an invalid entry name encoding");
  }
}

function validateEntryName(name: string): { name: string; directory: boolean } {
  if (!name || name.includes("\0") || name.includes("\\")) {
    throw new Error(`unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`absolute ZIP entry path is not allowed: ${name}`);
  }
  const directory = name.endsWith("/");
  const path = directory ? name.slice(0, -1) : name;
  const segments = path.split("/");
  if (!path || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`ZIP path traversal is not allowed: ${name}`);
  }
  for (const segment of segments) {
    const violation = windowsPathSegmentViolation(segment);
    if (violation) throw new Error(`Windows-unsafe ZIP entry path (${violation}): ${name}`);
  }
  return { name: path, directory };
}

function inspectCentralDirectory(bytes: Uint8Array): CentralEntry[] {
  const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (archive.length < 22) throw new Error("invalid ZIP: archive is too small");
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("multi-disk ZIP archives are not supported");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported for skill packages");
  }
  if (entryCount > MAX_ENTRY_COUNT) throw new Error("ZIP exceeds the entry-count limit");
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw new Error("invalid ZIP central-directory bounds");
  }

  const entries: CentralEntry[] = [];
  const seenPortablePaths = new Map<string, SeenPortablePath>();
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("invalid ZIP central-directory entry");
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length) throw new Error("truncated ZIP central-directory entry");
    if ((flags & 0x1) !== 0) throw new Error("encrypted ZIP entries are not supported");
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method: ${method}`);

    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength);
    const decodedName = decodeEntryName(rawName, (flags & 0x800) !== 0);
    const validated = validateEntryName(decodedName);
    registerPortablePath(seenPortablePaths, validated.name, validated.directory);

    const creatorSystem = versionMadeBy >>> 8;
    if (creatorSystem === 3) {
      const unixMode = externalAttributes >>> 16;
      const fileType = unixMode & 0o170000;
      if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
        throw new Error(`ZIP links and special files are not allowed: ${validated.name}`);
      }
      if (validated.directory && fileType === 0o100000) {
        throw new Error(`ZIP directory has a regular-file mode: ${validated.name}`);
      }
      if (!validated.directory && fileType === 0o040000) {
        throw new Error(`ZIP file has a directory mode: ${validated.name}`);
      }
    }

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`invalid local ZIP header for ${validated.name}`);
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd + localExtraLength > archive.length) throw new Error("truncated local ZIP header");
    if (localFlags !== flags || localMethod !== method || !archive.subarray(localNameStart, localNameEnd).equals(rawName)) {
      throw new Error(`local and central ZIP headers disagree for ${validated.name}`);
    }

    if (!validated.directory) {
      if (uncompressedSize > MAX_FILE_BYTES) throw new Error(`ZIP entry exceeds the size limit: ${validated.name}`);
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_ARCHIVE_BYTES) throw new Error("ZIP exceeds the expanded-size limit");
    }
    entries.push({ name: validated.name, directory: validated.directory, uncompressedSize });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error("invalid ZIP central-directory size");
  return entries;
}

const SKILL_FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n[\s\S]*)?$/;

function decodeUtf8(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not valid UTF-8`);
  }
}

function requirementsFromSkillMd(bytes: Uint8Array): SkillRequirement[] {
  const skillMd = decodeUtf8(bytes, "SKILL.md");
  const frontmatter = SKILL_FRONTMATTER_RE.exec(skillMd)?.[1];
  if (frontmatter === undefined) throw new Error("SKILL.md is missing a YAML frontmatter block");

  let document: unknown;
  try {
    document = parseYaml(frontmatter, { merge: false });
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is not valid YAML: ${(error as Error).message}`);
  }
  const parsed = skillFrontmatterSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "frontmatter"}: ${issue.message}`)
      .join("; ");
    throw new Error(`SKILL.md frontmatter validation failed: ${detail}`);
  }
  return parsed.data.requirements;
}

function splitRequirements(requirements: readonly SkillRequirement[]): Omit<PublicInstallPrerequisites, "dependencies"> {
  const select = (type: SkillRequirement["type"], required: boolean) => requirements
    .filter((requirement) => requirement.type === type && requirement.required === required)
    .map((requirement) => requirement.key)
    .sort((a, b) => a.localeCompare(b));
  return {
    required_env: select("env", true),
    optional_env: select("env", false),
    required_secrets: select("secret", true),
    optional_secrets: select("secret", false),
  };
}

function prerequisitesFrom(files: ReadonlyMap<string, Uint8Array>): PublicInstallPrerequisites {
  const manifestBytes = files.get("companion.json");
  if (!manifestBytes) {
    const skillMd = files.get("SKILL.md");
    if (!skillMd) throw new Error("public skill ZIP must contain SKILL.md at its root");
    return { dependencies: [], ...splitRequirements(requirementsFromSkillMd(skillMd)) };
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(decodeUtf8(manifestBytes, "companion.json"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`companion.json is not valid JSON: ${error.message}`);
    throw error;
  }
  const parsed = companionManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new Error(`companion.json validation failed: ${detail}`);
  }
  return {
    dependencies: companionDependencySlugs(parsed.data),
    ...splitRequirements(companionEnvironmentToRequirements(parsed.data.environment)),
  };
}

/** Validate and expand a public ZIP entirely in memory before any filesystem write. */
export function inspectPublicSkillZip(bytes: Uint8Array): InspectedPublicSkillZip {
  const centralEntries = inspectCentralDirectory(bytes);
  const regularEntries = centralEntries.filter((entry) => !entry.directory);
  const expanded = unzipSync(bytes, {
    filter(file: UnzipFileInfo) {
      return !file.name.endsWith("/");
    },
  });
  const files = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const entry of regularEntries) {
    const contents = expanded[entry.name];
    if (!contents || contents.byteLength !== entry.uncompressedSize) {
      throw new Error(`ZIP entry size mismatch: ${entry.name}`);
    }
    actualTotal += contents.byteLength;
    if (contents.byteLength > MAX_FILE_BYTES || actualTotal > MAX_ARCHIVE_BYTES) {
      throw new Error("ZIP exceeds the expanded-size limit");
    }
    files.set(entry.name, contents);
  }
  if (files.size !== regularEntries.length || Object.keys(expanded).length !== regularEntries.length) {
    throw new Error("ZIP extraction did not match its validated directory");
  }
  if (!files.has("SKILL.md")) throw new Error("public skill ZIP must contain SKILL.md at its root");
  return { files, prerequisites: prerequisitesFrom(files) };
}

function libraryParts(tool: PublicInstallTool): string[] {
  if (tool === "claude-code") return [".claude", "skills"];
  if (tool === "codex") return [".codex", "skills"];
  return [".agents", "skills"];
}

function installBase(input: { scope: PublicInstallScope; projectRoot?: string }): string {
  const base = input.scope === "global"
    ? resolve(homedir())
    : input.projectRoot
      ? resolve(input.projectRoot)
      : null;
  if (!base) throw new Error("projectRoot is required for a project-scoped public install");
  return base;
}

export function resolvePublicSkillDestination(input: {
  slug: string;
  tool: PublicInstallTool;
  scope: PublicInstallScope;
  projectRoot?: string;
}): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) throw new Error("invalid public skill slug");
  return resolve(installBase(input), ...libraryParts(input.tool), input.slug);
}

function isPhysicallyContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

interface SecureInstallLocation {
  physicalBase: string;
  library: string;
  destination: string;
}

/**
 * Resolve the install library through real paths and reject links in every package-controlled
 * ancestor. This prevents `.codex`, `.claude`, `.agents`, or their `skills` child from redirecting
 * staging and replacement outside the selected home/project root.
 */
function secureInstallLocation(input: {
  slug: string;
  tool: PublicInstallTool;
  scope: PublicInstallScope;
  projectRoot?: string;
}): SecureInstallLocation {
  const base = installBase(input);
  const baseStat = lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error(`refusing a non-directory or symbolic-link install root: ${base}`);
  }
  const physicalBase = realpathSync(base);
  let logicalAncestor = base;
  let physicalAncestor = physicalBase;

  for (const part of libraryParts(input.tool)) {
    logicalAncestor = join(logicalAncestor, part);
    if (!existsSync(logicalAncestor)) {
      try {
        mkdirSync(logicalAncestor, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = lstatSync(logicalAncestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing a non-directory or symbolic-link destination ancestor: ${logicalAncestor}`);
    }
    physicalAncestor = realpathSync(logicalAncestor);
    if (!isPhysicallyContained(physicalBase, physicalAncestor)) {
      throw new Error(`destination ancestor escaped the selected install root: ${logicalAncestor}`);
    }
  }

  const destination = resolve(physicalAncestor, input.slug);
  if (!isPhysicallyContained(physicalBase, destination)) {
    throw new Error(`public skill destination escaped the selected install root: ${destination}`);
  }
  return { physicalBase, library: physicalAncestor, destination };
}

function syncPath(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeStagedFiles(stage: string, files: ReadonlyMap<string, Uint8Array>): void {
  for (const [relativePath, contents] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = resolve(stage, relativePath);
    if (!destination.startsWith(`${stage}${sep}`)) throw new Error(`ZIP entry escaped staging: ${relativePath}`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, contents, { mode: 0o644, flag: "wx" });
    chmodSync(destination, 0o644);
    syncPath(destination);
  }
  syncPath(stage);
}

/** Install one validated root package with a same-filesystem atomic swap and rollback. */
export function installPublicSkillZip(input: {
  bytes: Uint8Array;
  slug: string;
  tool: PublicInstallTool;
  scope: PublicInstallScope;
  projectRoot?: string;
  confirmInstall: boolean;
  confirmReplace?: boolean;
}): { destination: string; replaced: boolean; prerequisites: PublicInstallPrerequisites } {
  if (input.confirmInstall !== true) throw new Error("public install requires explicit destination confirmation");
  const inspected = inspectPublicSkillZip(input.bytes);
  const secured = secureInstallLocation(input);
  const { destination, library } = secured;
  const replaced = existsSync(destination);
  let replacedIdentity: { dev: number; ino: number } | null = null;
  if (replaced) {
    const current = lstatSync(destination);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new Error(`refusing to replace a non-directory or symbolic-link destination: ${destination}`);
    }
    const physicalDestination = realpathSync(destination);
    if (!isPhysicallyContained(secured.physicalBase, physicalDestination)) {
      throw new Error(`existing destination escaped the selected install root: ${destination}`);
    }
    replacedIdentity = { dev: current.dev, ino: current.ino };
    if (input.confirmReplace !== true) throw new Error(`replacement confirmation required for ${destination}`);
  }

  const stage = join(library, `.companion-install-${input.slug}-${randomUUID()}`);
  const backup = join(library, `.companion-backup-${input.slug}-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  let previousMoved = false;
  let installed = false;
  try {
    writeStagedFiles(stage, inspected.files);
    const beforeSwap = secureInstallLocation(input);
    if (beforeSwap.physicalBase !== secured.physicalBase || beforeSwap.library !== library || beforeSwap.destination !== destination) {
      throw new Error("public skill destination changed while preparing the install");
    }
    const existsBeforeSwap = existsSync(destination);
    if (existsBeforeSwap !== replaced) throw new Error("public skill destination changed while preparing the install");
    if (replaced) {
      const current = lstatSync(destination);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !replacedIdentity
        || current.dev !== replacedIdentity.dev
        || current.ino !== replacedIdentity.ino
      ) {
        throw new Error("public skill destination changed while preparing the install");
      }
      renameSync(destination, backup);
      previousMoved = true;
    }
    const beforeCommit = secureInstallLocation(input);
    if (beforeCommit.library !== library || beforeCommit.destination !== destination || existsSync(destination)) {
      throw new Error("public skill destination changed before the atomic swap");
    }
    renameSync(stage, destination);
    installed = true;
    syncPath(library);
  } catch (error) {
    if (installed && existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    if (previousMoved && existsSync(backup)) renameSync(backup, destination);
    throw error;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
  if (previousMoved && existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  syncPath(library);
  return { destination, replaced, prerequisites: inspected.prerequisites };
}

/** Test/support helper: inspect a ZIP file without exposing any network credential. */
export function inspectPublicSkillZipFile(path: string): InspectedPublicSkillZip {
  return inspectPublicSkillZip(readFileSync(path));
}
