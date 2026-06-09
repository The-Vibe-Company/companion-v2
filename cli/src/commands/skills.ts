import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import pc from "picocolors";
import {
  visibilityFilterSchema,
  type LockedSkill,
  type SkillListRow,
  type SkillVersionRow,
  type SkillVisibility,
  type SkillVisibilityInput,
  type VisibilityFilter,
} from "@companion/contracts";
import {
  bumpSemver,
  packDir,
  skillChecksum,
  toTar,
  unpackTo,
  validateSkillDir,
} from "@companion/skills";
import { getClient, getOrgId } from "../lib/client";
import { CliError } from "../lib/errors";
import {
  classify,
  getRegistryInfo,
  localChecksum,
  resolveTarget,
  type RegistryInfo,
} from "../lib/registry";
import {
  findLockfileDir,
  loadLockfile,
  saveLockfile,
  upsertLockedSkill,
} from "../lib/lockfile";
import {
  colorState,
  emitJson,
  out,
  printTable,
  printValidation,
  type GlobalOpts,
} from "../lib/output";

const nowIso = () => new Date().toISOString();

export function splitTeams(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseVisibilityFilter(value: string | undefined): VisibilityFilter | undefined {
  if (!value) return undefined;
  const parsed = visibilityFilterSchema.safeParse(value);
  if (!parsed.success) throw new CliError("visibility must be one of: private, team, everyone", 2);
  return parsed.data;
}

export function lockfileVisibility(input: SkillVisibility | SkillVisibilityInput): SkillVisibilityInput {
  return {
    everyone: input.everyone,
    teams: input.teams.map((team) => (typeof team === "string" ? team : team.slug)),
  };
}

export function resolvePushVisibility(reg: RegistryInfo, opts: Pick<PushOpts, "everyone" | "private" | "team">): SkillVisibilityInput {
  const teams = splitTeams(opts.team);
  if (opts.private && (opts.everyone || teams.length > 0)) {
    throw new CliError("--private cannot be combined with --everyone or --team", 2);
  }
  if (opts.private) return { everyone: false, teams: [] };
  const hasVisibilityFlags = opts.everyone === true || teams.length > 0;
  if (hasVisibilityFlags) return { everyone: Boolean(opts.everyone), teams };
  if (reg.row) return lockfileVisibility(reg.row.visibility);
  return { everyone: false, teams: [] };
}

function visibilityLabel(input: { everyone: boolean; teams: Array<{ slug: string; name?: string }> | string[] }): string {
  const teams = input.teams.map((team) => (typeof team === "string" ? team : team.name ?? team.slug));
  const teamLabel = teams.length === 0 ? "" : teams.length === 1 ? teams[0]! : `${teams.length} teams`;
  if (input.everyone && teamLabel) return `Everyone + ${teamLabel}`;
  if (input.everyone) return "Everyone";
  if (teamLabel) return teamLabel;
  return "Private";
}

export function verifyDownloadedArchive(name: string, version: string, archive: Buffer, expectedChecksum: string): string {
  const checksum = skillChecksum(toTar(archive));
  if (checksum !== expectedChecksum) {
    throw new CliError(`download checksum mismatch for ${name}@${version}: expected ${expectedChecksum}, got ${checksum}`, 8);
  }
  return checksum;
}

export async function assertCanReplaceExistingInstall(
  dest: string,
  existing: LockedSkill | undefined,
  force: boolean,
): Promise<void> {
  if (!existsSync(join(dest, "SKILL.md")) || force) return;
  const current = await localChecksum(dest);
  if (!existing) {
    throw new CliError(`refusing to overwrite existing ${dest}; rerun with --force`, 6);
  }
  if (current !== existing.checksum) {
    throw new CliError(`local changes detected in ${dest}; rerun with --force to overwrite`, 6);
  }
}

export async function list(
  opts: { visibility?: string; mine?: boolean },
  g: GlobalOpts,
): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const qs = new URLSearchParams();
  const visibility = parseVisibilityFilter(opts.visibility);
  if (visibility) qs.set("visibility", visibility);
  if (opts.mine) qs.set("mine", "true");
  const rows = await client.request<SkillListRow[]>(`/v1/skills${qs.size ? `?${qs.toString()}` : ""}`);
  if (g.json) {
    emitJson(rows);
    return;
  }
  printTable(
    ["skill", "visibility", "version", "owner", "stars", "state"],
    rows.map((r) => [
      r.slug,
      visibilityLabel(r.visibility),
      r.current_version ?? "-",
      `@${r.owner_handle ?? r.owner_name}`,
      String(r.star_count ?? 0),
      r.validation,
    ]),
  );
}

export async function info(name: string, g: GlobalOpts): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const r = await client.request<SkillListRow>(`/v1/skills/${name}`);
  if (g.json) {
    emitJson(r);
    return;
  }
  out(`${pc.bold(r.slug)}  ${pc.dim(r.current_version ?? "-")}`);
  out(r.description);
  out(`visibility ${visibilityLabel(r.visibility)}`);
  out(`owner      ${r.owner_name} (@${r.owner_handle ?? ""})`);
  out(`teams      ${r.visibility.teams.map((team) => team.slug).join(", ") || "-"}`);
  out(`license    ${r.license ?? "-"}`);
  out(`checksum   ${r.checksum ?? "-"}`);
  out(`validation ${r.validation}`);
  out(`stars      ${r.star_count ?? 0}`);
}

export async function versions(name: string, g: GlobalOpts): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const reg = await getRegistryInfo(client, name);
  if (!reg.exists) throw new CliError(`skill not found: ${name}`, 4);
  const rows = await client.request<SkillVersionRow[]>(`/v1/skills/${name}/versions`);
  if (g.json) {
    emitJson(rows);
    return;
  }
  printTable(
    ["version", "note", "checksum", "date"],
    rows.map((r) => [
      r.version + (r.version === reg.currentVersion ? pc.green(" *") : ""),
      r.note ?? "",
      r.checksum.slice(0, 18),
      r.created_at.slice(0, 10),
    ]),
  );
}

export async function validate(dir: string, g: GlobalOpts): Promise<void> {
  const res = await validateSkillDir(resolve(dir));
  if (g.json) emitJson(res);
  else {
    printValidation(res, false);
    out(res.ok ? pc.green("valid") : pc.red("invalid"));
  }
  if (!res.ok) throw new CliError("package failed validation", 5);
}

export interface PushOpts {
  everyone?: boolean;
  private?: boolean;
  team?: string[];
  bump?: "patch" | "minor" | "major";
  setVersion?: string;
  message?: string;
  dryRun?: boolean;
}

export async function push(dir: string, opts: PushOpts, g: GlobalOpts): Promise<void> {
  const abs = resolve(dir);
  const result = await validateSkillDir(abs);
  if (!g.json) printValidation(result, false);
  if (!result.ok || !result.frontmatter) throw new CliError("package failed validation", 5);
  const fm = result.frontmatter;

  const client = await getClient(g.profile, g.org);
  const reg = await getRegistryInfo(client, fm.name);

  let version = fm.version;
  if (reg.exists && reg.currentVersion) {
    if (opts.bump) version = bumpSemver(reg.currentVersion, opts.bump);
    else if (opts.setVersion) version = opts.setVersion;
  } else if (opts.setVersion) {
    version = opts.setVersion;
  }

  const visibility = resolvePushVisibility(reg, opts);

  const packed = await packDir(abs);
  if (opts.dryRun) {
    if (g.json)
      emitJson({ dryRun: true, name: fm.name, version, visibility, checksum: packed.checksum, size: packed.sizeBytes, files: packed.files });
    else
      out(
        `would publish ${pc.bold(`${fm.name}@${version}`)}  visibility=${visibilityLabel(visibility)}  ${packed.checksum}  ${packed.sizeBytes} bytes  ${packed.files.length} files`,
      );
    return;
  }

  const fd = new FormData();
  fd.append("file", new Blob([packed.archive], { type: "application/gzip" }), `${fm.name}-${version}.tar.gz`);
  fd.append("action", "publish");
  fd.append("everyone", String(visibility.everyone));
  fd.append("version", version);
  for (const team of visibility.teams) fd.append("team", team);
  if (opts.message) fd.append("message", opts.message);

  const published = await client.request<{ checksum: string }>("/v1/skills", { method: "POST", body: fd });
  const orgId = await getOrgId(client);
  const lockDir = findLockfileDir(abs) ?? process.cwd();
  const lock = await loadLockfile(lockDir);
  if (!lock.registry.url) lock.registry = { url: client.url, orgId };
  upsertLockedSkill(lock, {
    name: fm.name,
    visibility,
    pinned: null,
    resolved: version,
    checksum: published.checksum,
    size: packed.sizeBytes,
    source: "published",
    installPath: relative(lockDir, abs) || ".",
    frontmatter: { version, license: fm.license, tools: fm.tools },
    addedAt: lock.skills[fm.name]?.addedAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  await saveLockfile(lockDir, lock);

  if (g.json) emitJson({ ok: true, name: fm.name, version, checksum: published.checksum });
  else out(pc.green(`published ${fm.name}@${version}`));
}

function parseSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf("@");
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  return { name: spec, version: null };
}

export async function pull(spec: string, opts: { dir?: string; dest?: string; force?: boolean }, g: GlobalOpts): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const { name, version } = parseSpec(spec);
  const qs = version ? `?version=${encodeURIComponent(version)}` : "";
  const dl = await client.request<{
    version: string;
    checksum: string;
    url: string;
    sizeBytes: number;
    visibility: SkillVisibility;
  }>(`/v1/skills/${name}/download${qs}`);
  const res = await fetch(dl.url);
  if (!res.ok) throw new CliError(`download failed: ${res.statusText}`, 8);
  const archive = Buffer.from(await res.arrayBuffer());
  verifyDownloadedArchive(name, dl.version, archive, dl.checksum);

  const explicitDest = opts.dest ? resolve(opts.dest) : null;
  const root = explicitDest ? dirname(explicitDest) : resolve(opts.dir ?? "skills");
  const dest = explicitDest ?? join(root, name);
  const lockDir = explicitDest
    ? findLockfileDir(dest) ?? dirname(dest)
    : opts.dir
      ? findLockfileDir(root) ?? dirname(root)
      : findLockfileDir(process.cwd()) ?? process.cwd();
  const lock = await loadLockfile(lockDir);
  const existing = lock.skills[name];

  await assertCanReplaceExistingInstall(dest, existing, Boolean(opts.force));

  await mkdir(root, { recursive: true });
  if (dest !== lockDir) await rm(dest, { recursive: true, force: true });
  await unpackTo(archive, dest);

  const orgId = await getOrgId(client);
  if (!lock.registry.url) lock.registry = { url: client.url, orgId };
  upsertLockedSkill(lock, {
    name,
    visibility: lockfileVisibility(dl.visibility),
    pinned: version,
    resolved: dl.version,
    checksum: dl.checksum,
    size: dl.sizeBytes,
    source: "registry",
    installPath: relative(lockDir, dest),
    addedAt: lock.skills[name]?.addedAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  await saveLockfile(lockDir, lock);

  if (g.json) emitJson({ ok: true, name, version: dl.version, path: dest });
  else out(pc.green(`installed ${name}@${dl.version} -> ${dest}`));
}

async function driftRows(client: Awaited<ReturnType<typeof getClient>>, lockDir: string) {
  const lock = await loadLockfile(lockDir);
  const rows: Array<{
    locked: LockedSkill;
    local: string | null;
    reg: RegistryInfo;
    target: string | null;
    state: string;
  }> = [];
  for (const locked of Object.values(lock.skills)) {
    const abs = resolve(lockDir, locked.installPath);
    const [local, reg] = await Promise.all([localChecksum(abs), getRegistryInfo(client, locked.name)]);
    const target = resolveTarget(locked.pinned, reg);
    rows.push({ locked, local, reg, target, state: classify(locked, local, reg, target) });
  }
  return { lock, rows };
}

export async function status(opts: { exitCode?: boolean }, g: GlobalOpts): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const lockDir = findLockfileDir(process.cwd()) ?? process.cwd();
  const { rows } = await driftRows(client, lockDir);
  if (g.json) {
    emitJson(rows.map((r) => ({ name: r.locked.name, state: r.state, resolved: r.locked.resolved, target: r.target })));
  } else {
    printTable(
      ["skill", "state", "resolved", "target", "path"],
      rows.map((r) => [r.locked.name, colorState(r.state), r.locked.resolved, r.target ?? "-", r.locked.installPath]),
    );
  }
  if (opts.exitCode && rows.some((r) => !["up-to-date", "pinned"].includes(r.state))) {
    throw new CliError("tracked skills are not up to date", 9);
  }
}

export async function sync(opts: { dryRun?: boolean; force?: boolean }, g: GlobalOpts): Promise<void> {
  const client = await getClient(g.profile, g.org);
  const lockDir = findLockfileDir(process.cwd()) ?? process.cwd();
  const { lock, rows } = await driftRows(client, lockDir);
  const changed: string[] = [];
  for (const row of rows) {
    if (!row.target || row.target === row.locked.resolved) continue;
    if (!opts.force && !["outdated", "missing"].includes(row.state)) continue;
    if (opts.dryRun) {
      changed.push(`${row.locked.name}@${row.target}`);
      continue;
    }
    await pull(`${row.locked.name}@${row.target}`, { dest: join(lockDir, row.locked.installPath), force: opts.force }, g);
    const refreshed = await loadLockfile(lockDir);
    const updated = refreshed.skills[row.locked.name];
    if (updated) {
      lock.skills[row.locked.name] = updated;
      updated.resolved = row.target;
      updated.updatedAt = nowIso();
    }
    changed.push(`${row.locked.name}@${row.target}`);
  }
  if (!opts.dryRun) await saveLockfile(lockDir, lock);
  if (g.json) emitJson({ ok: true, changed });
  else out(changed.length ? `synced ${changed.join(", ")}` : "nothing to sync");
}
