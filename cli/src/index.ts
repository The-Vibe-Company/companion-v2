import { Command } from "commander";
import pc from "picocolors";
import { CliError } from "./lib/errors";
import { err, type GlobalOpts } from "./lib/output";
import * as auth from "./commands/auth";
import * as agent from "./commands/agent";

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
  .description("Companion - authenticate and manage the local Companion agent")
  .version("0.0.0");
addGlobalOpts(program);

// --- auth ---
function addAuthCommands(target: Command): void {
  addGlobalOpts(
    target
      .command("login")
      .description("sign in to a Companion workspace")
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
addAuthCommands(addGlobalOpts(program.command("auth").description("authenticate against a Companion workspace")));

// --- local agent ---
const agentCmd = addGlobalOpts(program.command("agent").description("install and control the local Companion agent"));

addGlobalOpts(agentCmd.command("install").description("register this machine and install the background agent").option("--no-service", "write credentials but do not install launchd", false)).action(
  (opts, cmd: Command) => runAction(cmd, (g) => agent.install({ noService: opts.noService }, g)),
);

addGlobalOpts(agentCmd.command("start").description("start the background agent service")).action((_opts, cmd: Command) =>
  runAction(cmd, (g) => agent.start(g)),
);

addGlobalOpts(agentCmd.command("stop").description("stop the background agent service")).action((_opts, cmd: Command) =>
  runAction(cmd, (g) => agent.stop(g)),
);

addGlobalOpts(agentCmd.command("status").description("show local agent installation and heartbeat status")).action((_opts, cmd: Command) =>
  runAction(cmd, (g) => agent.status(g)),
);

addGlobalOpts(agentCmd.command("run").description("run the agent in the foreground").option("--once", "send one heartbeat and exit", false)).action(
  (opts, cmd: Command) => runAction(cmd, (g) => agent.run({ once: opts.once }, g)),
);

addGlobalOpts(agentCmd.command("uninstall").description("stop and remove the local agent")).action((_opts, cmd: Command) =>
  runAction(cmd, (g) => agent.uninstall(g)),
);

program
  .command("skills", { hidden: true })
  .alias("skill")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(() => {
    throw new CliError("companion skills commands were removed; use the bundled Companion skill or the web UI to manage skills", 2);
  });

program.parseAsync(process.argv).catch((e) => {
  err(pc.red(`error: ${(e as Error).message}`));
  process.exitCode = 1;
});
