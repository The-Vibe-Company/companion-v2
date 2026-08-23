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
header on every workspace request. Account signup, provider connection, Plugins, Skills, routines,
triggers, attachments, and sharing remain web workflows in this version.

Static verification is available without a simulator:

```bash
pnpm typecheck
pnpm lint
pnpm exec expo export --platform ios
pnpm exec expo-doctor
```
