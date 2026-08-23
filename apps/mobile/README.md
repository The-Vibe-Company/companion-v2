# Companion mobile

This is the standalone Expo client for the chat-only native Companions v1 surface. It intentionally
does not join the repository pnpm workspace: HeroUI Native and Uniwind require the hoisted linker
declared in this directory's `.npmrc`, and the app keeps its own lockfile.

Copy `.env.example` to `.env.local`, set `EXPO_PUBLIC_API_URL` to an API address reachable from the
device, then run:

```bash
pnpm install
pnpm start
```

## Optional Conductor workflow

The main Companion stack remains Conductor's default run command. On a local Mac, Conductor also
shows separate, non-default `mobile-ios`, `mobile-android`, and `mobile-metro` commands. They keep
the standalone mobile dependency graph isolated and install it lazily the first time one is chosen;
cloud workspaces do not show these native commands.

From the repository root, the same commands are:

```bash
pnpm mobile:setup       # optional eager install of apps/mobile dependencies
pnpm mobile:ios         # iOS build and Metro on a local Mac
pnpm mobile:android     # Android build and Metro
pnpm mobile:metro       # Metro only for an already installed client
pnpm mobile:ports       # print this workspace's API and Metro ports
```

Conductor reserves ten ports per workspace. The main stack keeps its existing allocation: the API
is `CONDUCTOR_PORT + 1`, and the isolated mobile launcher uses the remaining `+9` port for Metro.
The launchers default `EXPO_PUBLIC_API_URL` to that workspace API without writing an environment
file. An explicit shell value or `.env.local` can still override it for physical-device testing.
Metro uses LAN mode; set `REACT_NATIVE_PACKAGER_HOSTNAME=<LAN_IP>` alongside the externally reachable
API URL when a physical device must load the bundle from the Mac.

### Optional iOS MCP setup

On macOS, run `pnpm mobile:mcp:setup` when you want agent-driven Xcode builds, simulator inspection,
and logs. This explicit, idempotent command installs XcodeBuildMCP and registers its stdio server
with Codex and Claude Code when those clients are present. It leaves an existing divergent MCP
configuration untouched and asks you to resolve it manually. Refresh MCP status in Conductor and
start a new agent session after setup.

XcodeBuildMCP is intentionally not installed by Conductor setup and is not required to start the
repository or use the Expo CLI fallback.

For an Android emulator, keep the loopback API origin and reverse that port to the host:

```bash
adb reverse tcp:3001 tcp:3001
```

Set `EXPO_PUBLIC_API_URL=http://127.0.0.1:3001`. This lets the emulator reach the host while the
request `Origin` remains a Better Auth-trusted loopback origin, and it works with the default API
bind. A physical device needs an explicitly externally bound API (for example,
`COMPANION_API_HOST=0.0.0.0`) and a firewall rule. Set `COMPANION_API_URL`, `BETTER_AUTH_URL`, and
`EXPO_PUBLIC_API_URL` to the same `http://<LAN_IP>:3001` origin so the API is reachable and Better
Auth trusts the mobile `Origin`; the stock Conductor launcher binds the API to `127.0.0.1`, so use a
separately configured API launch for this path. The app uses the existing Better Auth cookie
session, stores it in chunked SecureStore values, and sends the server-resolved `x-companion-org`
header on every workspace request. Email signup, provider connection, Plugins, Skills, routines,
triggers, attachments, and sharing remain web workflows in this version.

### Google sign-in

Google sign-in uses the system browser through Better Auth's Expo integration. It reuses the
server's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; no iOS or Android Google client id is
required. Register the same server callback used by the web app in Google Cloud:

```text
${BETTER_AUTH_URL}/auth/callback/google
```

The production app returns through `dev.companion.mobile://`; local development builds use
`dev.companion.mobile.dev://` so both variants can be installed together. Adding or changing these
native modules or schemes requires rebuilding the development client rather than restarting Metro
alone. A new Google user can join a domain-matched organization or create a named workspace in the
native app. Invitations, branding, and domain auto-join remain web configuration.

Static verification is available without a simulator:

```bash
pnpm typecheck
pnpm lint
pnpm exec expo export --platform all
npx -y expo-doctor@latest
```

## EAS and TestFlight

All EAS commands must go through the production wrapper from the repository root:

```bash
pnpm mobile:eas build:list --platform ios
pnpm mobile:eas workflow:run .eas/workflows/testflight.yml
```

The wrapper forces `APP_VARIANT=production` and uses the exact EAS CLI version pinned in the mobile
lockfile; running EAS directly would evaluate the default development variant and its `.dev`
application identifier. See
[`docs/DEPLOYER-MOBILE-TESTFLIGHT.md`](../../docs/DEPLOYER-MOBILE-TESTFLIGHT.md) for initial setup,
credentials, delivery, and rollback.
