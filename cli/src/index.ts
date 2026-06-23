import { Command } from "commander";
import pc from "picocolors";
import { CliError } from "./lib/errors";
import { err, type GlobalOpts } from "./lib/output";
import * as auth from "./commands/auth";
import * as skills from "./commands/skills";

/** Accumulate a repeatable string option (e.g. `--label a --label b` → `["a", "b"]`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addGlobalOpts(cmd: Command): Command {
  return cmd
    .option("--profile <name>", "config profile", "default")
    .option("--org <org-id>", "organization id for tenant-scoped requests")
    .option("--json", "machine-readable output", false);
}

function globalsFrom(cmd: Command): GlobalOpts {
  const o = cmd.optsWithGlobals();
  return { profile: (o.profile as string) ?? "default", org: o.org as string | undefined, json: Boolean(o.json) };
}

async function runAction(cmd: Command, thunk: (g: GlobalOpts) => Promise<void>): Promise<void> {
  const g = globalsFrom(cmd);
  try {
    await thunk(g);
  } catch (e) {
    const ce = e instanceof CliError ? e : new CliError((e as Error)?.message ?? String(e), 1);
    if (g.json) process.stdout.write(`${JSON.stringify({ ok: false, error: ce.message })}\n`);
    else err(pc.red(`error: ${ce.message}`));
    process.exitCode = ce.code;
  }
}

const program = new Command();
program
  .name("companion")
  .description("Companion - manage SKILL.md packages against a Companion API registry")
  .version("0.0.0");
addGlobalOpts(program);

// --- auth ---
function addAuthCommands(target: Command): void {
  addGlobalOpts(
    target
      .command("login")
      .description("sign in to a Companion registry")
      .option("--url <url>", "Companion API URL (first login)")
      .option("--email <email>", "account email")
      .option("--password <password>", "account password (prompted if omitted)")
      .option("--signup", "create the account before signing in", false),
  ).action((opts, cmd: Command) =>
    runAction(cmd, (g) =>
      auth.login(
        { url: opts.url, email: opts.email, password: opts.password, signup: opts.signup },
        g,
      ),
    ),
  );

  addGlobalOpts(target.command("logout").description("clear the stored session")).action(
    (_opts, cmd: Command) => runAction(cmd, (g) => auth.logout(g)),
  );

  addGlobalOpts(target.command("whoami").description("show the current user, org, and role")).action(
    (_opts, cmd: Command) => runAction(cmd, (g) => auth.whoami(g)),
  );
}

// Top-level `companion login/logout/whoami` plus a grouped `companion auth …` (matches dashboard copy).
addAuthCommands(program);
addAuthCommands(addGlobalOpts(program.command("auth").description("authenticate against a Companion registry")));

// --- skills ---  (also reachable as the singular `companion skill …` per the dashboard copy)
const skillsCmd = program.command("skills").alias("skill").description("manage skills");

addGlobalOpts(
  skillsCmd
    .command("list")
    .description("list registry skills (every skill in the org is visible to every member)")
    .option("--label <path>", "only skills filed under this folder path or a descendant"),
).action((opts, cmd: Command) =>
  runAction(cmd, (g) => skills.list({ label: opts.label }, g)),
);

addGlobalOpts(
  skillsCmd.command("info <name>").description("show a skill's metadata"),
).action((name: string, _opts, cmd: Command) => runAction(cmd, (g) => skills.info(name, g)));

addGlobalOpts(
  skillsCmd.command("versions <name>").description("show a skill's immutable version history"),
).action((name: string, _opts, cmd: Command) => runAction(cmd, (g) => skills.versions(name, g)));

addGlobalOpts(
  skillsCmd.command("validate <dir>").description("validate a local SKILL.md package (offline)"),
).action((dir: string, _opts, cmd: Command) => runAction(cmd, (g) => skills.validate(dir, g)));

addGlobalOpts(
  skillsCmd
    .command("push <dir>")
    .description("validate, package, and publish a new version")
    .option(
      "--label <path>",
      "file the skill under an org-wide shared folder path (repeatable; applied when first published)",
      collect,
      [] as string[],
    )
    .option("--bump <kind>", "bump from the registry's current version (patch|minor|major)")
    .option("--set-version <semver>", "publish an explicit version")
    .option("--message <text>", "version note")
    .option("--dry-run", "show what would be published without uploading", false),
).action((dir: string, opts, cmd: Command) =>
  runAction(cmd, (g) =>
    skills.push(
      dir,
      {
        label: opts.label,
        bump: opts.bump,
        setVersion: opts.setVersion,
        message: opts.message,
        dryRun: opts.dryRun,
      },
      g,
    ),
  ),
);

addGlobalOpts(
  skillsCmd
    .command("pull <spec>")
    .alias("install")
    .description("download a skill (name[@version]) into a working dir")
    .option("--dir <path>", "install dir (default ./skills)")
    .option("--force", "overwrite a locally-modified copy", false),
).action((spec: string, opts, cmd: Command) =>
  runAction(cmd, (g) => skills.pull(spec, { dir: opts.dir, force: opts.force }, g)),
);

addGlobalOpts(
  skillsCmd
    .command("status")
    .description("diff tracked skills against the registry and working tree")
    .option("--exit-code", "exit 9 if any skill is outdated/modified/conflict", false),
).action((opts, cmd: Command) =>
  runAction(cmd, (g) => skills.status({ exitCode: opts.exitCode }, g)),
);

addGlobalOpts(
  skillsCmd
    .command("sync")
    .description("fast-forward outdated, unpinned, unmodified skills")
    .option("--dry-run", "show the plan without writing", false)
    .option("--force", "overwrite modified copies", false),
).action((opts, cmd: Command) =>
  runAction(cmd, (g) => skills.sync({ dryRun: opts.dryRun, force: opts.force }, g)),
);

program.parseAsync(process.argv).catch((e) => {
  err(pc.red(`error: ${(e as Error).message}`));
  process.exitCode = 1;
});
