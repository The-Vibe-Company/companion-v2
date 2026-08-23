# Mobile contributor guidance

This directory is a standalone Expo project for iOS and Android. It stays outside the root pnpm
workspace and owns its `.npmrc`, lockfile, dependencies, generated native projects, and validation
commands. Do not move mobile dependencies or native tooling into the root workspace.

- Keep one React Native implementation for iOS and Android. Platform-specific code is an exception,
  not the default.
- Do not add Expo Web or a browser fallback. The existing web application remains under `apps/web`.
- Run package commands with `pnpm --dir apps/mobile --ignore-workspace ...`, or use the namespaced
  root commands documented in `apps/mobile/README.md`.
- Conductor's root stack remains the default. Native mobile launchers are local-only, use Metro at
  `CONDUCTOR_PORT + 9`, and talk to the API at `CONDUCTOR_PORT + 1`.
- XcodeBuildMCP is optional bootstrap tooling. When it is installed and connected, prefer it for
  agent-driven iOS build, launch, simulator inspection, and logs. The Expo CLI remains the fallback,
  and neither root setup nor non-mobile work may require XcodeBuildMCP.
- Never commit `ios/`, `android/`, `.expo/`, `.env.local`, or MCP-generated state.
