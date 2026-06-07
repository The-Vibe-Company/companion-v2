import { Command } from "commander";
import pc from "picocolors";
import { CliError } from "./lib/errors";
import { err, type GlobalOpts } from "./lib/output";
import * as auth from "./commands/auth";
import * as skills from "./commands/skills";

function addGlobalOpts(cmd: Command): Command {
  return cmd
    .option("--profile <name>", "config profile", "default")
    .option("--json", "machine-readable output", false);
}

function globalsFrom(cmd: Command): GlobalOpts {
  const o = cmd.optsWithGlobals();
  return { profile: (o.profile as string) ?? "default", json: Boolean(o.json) };
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
  .description("Companion — manage SKILL.md packages against a Supabase-backed registry")
  .version("0.0.0");
addGlobalOpts(program);

// --- auth ---
addGlobalOpts(
  program
    .command("login")
    .description("sign in to a Companion registry")
    .option("--url <url>", "Supabase URL (first login)")
    .option("--anon-key <key>", "Supabase anon key (first login)")
    .option("--email <email>", "account email")
    .option("--password <password>", "account password (prompted if omitted)"),
).action((opts, cmd: Command) =>
  runAction(cmd, (g) =>
    auth.login(
      { url: opts.url, anonKey: opts.anonKey, email: opts.email, password: opts.password },
      g,
    ),
  ),
);

addGlobalOpts(program.command("logout").description("clear the stored session")).action(
  (_opts, cmd: Command) => runAction(cmd, (g) => auth.logout(g)),
);

addGlobalOpts(program.command("whoami").description("show the current user, org, and role")).action(
  (_opts, cmd: Command) => runAction(cmd, (g) => auth.whoami(g)),
);

// --- skills ---
const skillsCmd = program.command("skills").description("manage skills");

addGlobalOpts(
  skillsCmd
    .command("list")
    .description("list registry skills you can see")
    .option("--scope <scope>", "filter by scope (private|team|public)")
    .option("--mine", "only skills you own", false),
).action((opts, cmd: Command) =>
  runAction(cmd, (g) => skills.list({ scope: opts.scope, mine: opts.mine }, g)),
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
    .option("--scope <scope>", "visibility scope (private|team|public)")
    .option("--team <slug>", "team slug (required for team scope)")
    .option("--bump <kind>", "bump from the registry's current version (patch|minor|major)")
    .option("--set-version <semver>", "publish an explicit version")
    .option("--message <text>", "version note")
    .option("--dry-run", "show what would be published without uploading", false),
).action((dir: string, opts, cmd: Command) =>
  runAction(cmd, (g) =>
    skills.push(
      dir,
      {
        scope: opts.scope,
        team: opts.team,
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
