import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import pc from "picocolors";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LockedSkill, Scope } from "@companion/contracts";
import {
  bumpSemver,
  extractFrontmatter,
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
  emptyLockfile,
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

// --------------------------------------------------------------------------
// Read commands
// --------------------------------------------------------------------------

export async function list(
  opts: { scope?: string; mine?: boolean },
  g: GlobalOpts,
): Promise<void> {
  const { supabase, userId } = await getClient(g.profile);
  let q = supabase
    .from("skill_list_v")
    .select("slug, scope, current_version, owner_name, owner_handle, team_slug, validation, star_count")
    .order("updated_at", { ascending: false });
  if (opts.scope) q = q.eq("scope", opts.scope);
  if (opts.mine) q = q.eq("owner_id", userId);
  const { data, error } = await q;
  if (error) throw new CliError(error.message, 8);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (g.json) {
    emitJson(rows);
    return;
  }
  printTable(
    ["skill", "scope", "version", "owner", "stars", "state"],
    rows.map((r) => [
      String(r.slug),
      r.scope === "team" ? `team:${String(r.team_slug ?? "")}` : String(r.scope),
      String(r.current_version ?? "—"),
      `@${String(r.owner_handle ?? r.owner_name ?? "")}`,
      String(r.star_count ?? 0),
      String(r.validation),
    ]),
  );
}

export async function info(name: string, g: GlobalOpts): Promise<void> {
  const { supabase } = await getClient(g.profile);
  const { data } = await supabase.from("skill_list_v").select("*").eq("slug", name).maybeSingle();
  if (!data) throw new CliError(`skill not found: ${name}`, 4);
  if (g.json) {
    emitJson(data);
    return;
  }
  const r = data as Record<string, unknown>;
  out(`${pc.bold(String(r.slug))}  ${pc.dim(String(r.current_version ?? "—"))}`);
  out(String(r.description ?? ""));
  out(`scope      ${r.scope}`);
  out(`owner      ${r.owner_name} (@${r.owner_handle})`);
  out(`team       ${r.team_name ?? "—"}`);
  out(`license    ${r.license ?? "—"}`);
  out(`checksum   ${r.checksum ?? "—"}`);
  out(`validation ${r.validation}`);
  out(`stars      ${r.star_count ?? 0}`);
}

export async function versions(name: string, g: GlobalOpts): Promise<void> {
  const { supabase } = await getClient(g.profile);
  const reg = await getRegistryInfo(supabase, name);
  if (!reg.exists || !reg.id) throw new CliError(`skill not found: ${name}`, 4);
  const { data } = await supabase
    .from("skill_versions")
    .select("version, note, checksum, size_bytes, created_at")
    .eq("skill_id", reg.id)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as Record<string, unknown>[];
  if (g.json) {
    emitJson(rows);
    return;
  }
  printTable(
    ["version", "note", "checksum", "date"],
    rows.map((r) => [
      String(r.version) + (r.version === reg.currentVersion ? pc.green(" *") : ""),
      String(r.note ?? ""),
      String(r.checksum ?? "").slice(0, 18),
      String(r.created_at ?? "").slice(0, 10),
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

// --------------------------------------------------------------------------
// Publish
// --------------------------------------------------------------------------

export interface PushOpts {
  scope?: string;
  team?: string;
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

  const { supabase, url } = await getClient(g.profile);
  const reg = await getRegistryInfo(supabase, fm.name);

  let version = fm.version;
  if (reg.exists && reg.currentVersion) {
    if (opts.bump) version = bumpSemver(reg.currentVersion, opts.bump);
    else if (opts.setVersion) version = opts.setVersion;
  } else if (opts.setVersion) {
    version = opts.setVersion;
  }

  const scope = (opts.scope ?? fm.scope ?? "private") as Scope;
  const team = scope === "team" ? (opts.team ?? null) : null;
  if (scope === "team" && !team) throw new CliError("team scope requires --team <slug>", 2);

  const packed = await packDir(abs);
  const orgId = await getOrgId(supabase);
  const storagePath = `${orgId}/${fm.name}/${version}.tar.gz`;
  const rawFm = extractFrontmatter(await readFile(join(abs, "SKILL.md"), "utf8")).raw ?? "";

  if (opts.dryRun) {
    if (g.json)
      emitJson({ dryRun: true, name: fm.name, version, scope, checksum: packed.checksum, size: packed.sizeBytes, files: packed.files });
    else
      out(
        `would publish ${pc.bold(`${fm.name}@${version}`)}  scope=${scope}  ${packed.checksum}  ${packed.sizeBytes} bytes  ${packed.files.length} files`,
      );
    return;
  }

  const up = await supabase.storage
    .from("skill-archives")
    .upload(storagePath, packed.archive, { contentType: "application/gzip", upsert: false });
  if (up.error && !/exists|duplicate/i.test(up.error.message)) {
    throw new CliError(`upload failed: ${up.error.message}`, 8);
  }

  const { error } = await supabase.rpc("publish_skill_version", {
    p_slug: fm.name,
    p_scope: scope,
    p_team_slug: team,
    p_version: version,
    p_description: fm.description,
    p_checksum: packed.checksum,
    p_storage_path: storagePath,
    p_size: packed.sizeBytes,
    p_frontmatter: rawFm,
    p_tools: fm.tools,
    p_license: fm.license ?? null,
    p_note: opts.message ?? "",
  });
  if (error) throw new CliError(error.message, /already exists/.test(error.message) ? 6 : 8);

  const lockDir = findLockfileDir(abs) ?? process.cwd();
  const lock = await loadLockfile(lockDir);
  if (!lock.registry.url) lock.registry = { url, orgId };
  upsertLockedSkill(lock, {
    name: fm.name,
    scope,
    team: team ?? null,
    pinned: null,
    resolved: version,
    checksum: packed.checksum,
    size: packed.sizeBytes,
    source: "published",
    installPath: relative(lockDir, abs) || ".",
    frontmatter: { version, license: fm.license, tools: fm.tools },
    addedAt: lock.skills[fm.name]?.addedAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  await saveLockfile(lockDir, lock);

  if (g.json) emitJson({ ok: true, name: fm.name, version, checksum: packed.checksum });
  else out(`${pc.green("published")} ${fm.name}@${version}  ${packed.checksum}`);
}

// --------------------------------------------------------------------------
// Pull / sync
// --------------------------------------------------------------------------

/** Clean-replace an install dir so files removed in the new version don't linger. */
async function installVersion(buffer: Buffer, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await unpackTo(buffer, target);
}

async function downloadVersion(
  supabase: SupabaseClient,
  skillId: string,
  version: string,
): Promise<{ buffer: Buffer; checksum: string }> {
  const { data: ver } = await supabase
    .from("skill_versions")
    .select("storage_path, checksum")
    .eq("skill_id", skillId)
    .eq("version", version)
    .maybeSingle();
  if (!ver) throw new CliError(`version not found: ${version}`, 4);
  const path = (ver as { storage_path: string }).storage_path;
  const expected = (ver as { checksum: string }).checksum;
  const dl = await supabase.storage.from("skill-archives").download(path);
  if (dl.error || !dl.data) throw new CliError(`download failed: ${dl.error?.message ?? "no data"}`, 8);
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  const checksum = skillChecksum(toTar(buffer));
  if (checksum !== expected) throw new CliError(`checksum mismatch for ${version}`, 6);
  return { buffer, checksum };
}

export async function pull(
  spec: string,
  opts: { dir?: string; force?: boolean },
  g: GlobalOpts,
): Promise<void> {
  const [name, pinned] = spec.split("@");
  if (!name) throw new CliError("usage: companion skills pull <name>[@version]", 2);
  const { supabase, url } = await getClient(g.profile);

  const { data: skill } = await supabase
    .from("skill_list_v")
    .select("id, current_version, scope, team_name")
    .eq("slug", name)
    .maybeSingle();
  if (!skill) throw new CliError(`skill not found: ${name}`, 4);
  const s = skill as { id: string; current_version: string | null; scope: Scope; team_name: string | null };
  const version = pinned ?? s.current_version;
  if (!version) throw new CliError(`no version available for ${name}`, 4);

  const baseDir = opts.dir ? resolve(opts.dir) : join(process.cwd(), "skills");
  const target = join(baseDir, name);
  const lockDir = findLockfileDir(baseDir) ?? process.cwd();
  const lock = (await loadLockfile(lockDir)) ?? emptyLockfile(url);

  if (existsSync(join(target, "SKILL.md")) && !opts.force) {
    const baseline = lock.skills[name]?.checksum;
    const local = await localChecksum(target);
    if (baseline && local && local !== baseline) {
      throw new CliError(`${name} has local changes; refusing to overwrite (use --force)`, 6);
    }
    if (!baseline) {
      throw new CliError(`${name} already exists at ${relative(process.cwd(), target)} (use --force)`, 6);
    }
  }

  const { buffer, checksum } = await downloadVersion(supabase, s.id, version);
  await installVersion(buffer, target);

  if (!lock.registry.url) lock.registry = { url, orgId: lock.registry.orgId };
  upsertLockedSkill(lock, {
    name,
    scope: s.scope,
    team: s.team_name ?? null,
    pinned: pinned ?? null,
    resolved: version,
    checksum,
    size: buffer.length,
    source: "registry",
    installPath: relative(lockDir, target) || name,
    addedAt: lock.skills[name]?.addedAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  await saveLockfile(lockDir, lock);

  if (g.json) emitJson({ ok: true, name, version, checksum });
  else out(`${pc.green("pulled")} ${name}@${version} -> ${relative(process.cwd(), target)}`);
}

interface StatusRow {
  name: string;
  state: string;
  resolved: string;
  target: string | null;
  locked: LockedSkill;
  reg: RegistryInfo;
}

async function computeStatus(supabase: SupabaseClient, lockDir: string, locked: LockedSkill): Promise<StatusRow> {
  const absInstall = resolve(lockDir, locked.installPath);
  const local = await localChecksum(absInstall);
  const reg = await getRegistryInfo(supabase, locked.name);
  const target = resolveTarget(locked.pinned, reg);
  const state = classify(locked, local, reg, target);
  return { name: locked.name, state, resolved: locked.resolved, target, locked, reg };
}

export async function status(opts: { exitCode?: boolean }, g: GlobalOpts): Promise<void> {
  const lockDir = findLockfileDir() ?? process.cwd();
  const lock = await loadLockfile(lockDir);
  const entries = Object.values(lock.skills);
  if (!entries.length) {
    if (g.json) emitJson({ skills: [] });
    else out("no tracked skills. Use `companion skills pull` or `push` first.");
    return;
  }
  const { supabase } = await getClient(g.profile);
  const rows = await Promise.all(entries.map((e) => computeStatus(supabase, lockDir, e)));

  if (g.json) {
    emitJson({ skills: rows.map((r) => ({ name: r.name, state: r.state, resolved: r.resolved, target: r.target })) });
  } else {
    printTable(
      ["skill", "state", "resolved", "target"],
      rows.map((r) => [r.name, colorState(r.state), r.resolved, r.target ?? "—"]),
    );
    const tally: Record<string, number> = {};
    for (const r of rows) tally[r.state] = (tally[r.state] ?? 0) + 1;
    out("");
    out(
      `Total ${rows.length} · ` +
        Object.entries(tally)
          .map(([k, v]) => `${k} ${v}`)
          .join(" · "),
    );
  }
  if (opts.exitCode && rows.some((r) => ["outdated", "conflict", "modified"].includes(r.state))) {
    process.exitCode = 9;
  }
}

export async function sync(
  opts: { dryRun?: boolean; force?: boolean },
  g: GlobalOpts,
): Promise<void> {
  const lockDir = findLockfileDir() ?? process.cwd();
  const lock = await loadLockfile(lockDir);
  const entries = Object.values(lock.skills);
  if (!entries.length) {
    out("no tracked skills.");
    return;
  }
  const { supabase } = await getClient(g.profile);
  const rows = await Promise.all(entries.map((e) => computeStatus(supabase, lockDir, e)));
  const changes: string[] = [];

  for (const r of rows) {
    const target = r.target;
    const regId = r.reg.id;
    const updatable = !!(target && regId);
    const isModified = r.state === "modified" || r.state === "conflict";

    if (r.state === "outdated" && updatable) {
      if (opts.dryRun) {
        changes.push(`${r.name} ${r.resolved} -> ${target} (would update)`);
        continue;
      }
      const { buffer, checksum } = await downloadVersion(supabase, regId as string, target as string);
      await installVersion(buffer, resolve(lockDir, r.locked.installPath));
      upsertLockedSkill(lock, { ...r.locked, resolved: target as string, checksum, size: buffer.length, updatedAt: nowIso() });
      changes.push(`${r.name} ${r.resolved} -> ${target}`);
    } else if (isModified && opts.force && updatable) {
      // --force discards local changes and restores the registry version.
      if (opts.dryRun) {
        changes.push(`${r.name} ${r.state} -> ${target} (would force-overwrite)`);
        continue;
      }
      const { buffer, checksum } = await downloadVersion(supabase, regId as string, target as string);
      await installVersion(buffer, resolve(lockDir, r.locked.installPath));
      upsertLockedSkill(lock, { ...r.locked, resolved: target as string, checksum, size: buffer.length, updatedAt: nowIso() });
      changes.push(`${r.name} ${pc.yellow(r.state)} -> ${target} (forced)`);
    } else if (isModified) {
      changes.push(`${r.name} ${pc.yellow(r.state)}, skipped (use --force to overwrite)`);
    } else if (r.state === "pinned") {
      changes.push(`${r.name} pinned ${r.resolved}${r.reg.currentVersion && r.reg.currentVersion !== r.resolved ? ` (${r.reg.currentVersion} available)` : ""}`);
    }
  }

  if (!opts.dryRun) await saveLockfile(lockDir, lock);

  if (g.json) emitJson({ dryRun: !!opts.dryRun, changes });
  else if (changes.length) changes.forEach((c) => out(c));
  else out("everything up to date");
}
