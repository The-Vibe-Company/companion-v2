# Slack app setup

Companion's Slack plugin uses a deployment-owned Slack app, Slack's Bot User OAuth flow, and a
product-owned MCP bridge inside the Companion Box. The Slack bot token remains encrypted in the
control plane and is redeemed into the loopback gateway only; it is never written to Box disk or
passed to Pi. This release sends messages to known channel, group, or direct-message conversation
IDs and can reply to a thread.

Receiving Slack messages is intentionally a separate change. Do not configure an Events API request
URL yet: `/v1/hooks/slack/events` does not ship in this release. The follow-up will add signed request
verification, `url_verification`, event-id dedupe, a channel allowlist, tenant routing, and ordinary
Companion trigger turns.

## Create the app

1. In Slack's app management console, create an app from
   [`deploy/slack/manifest.send.yaml`](../../deploy/slack/manifest.send.yaml).
2. Replace `https://companion.example` with the deployment's public `COMPANION_WEB_URL`. The exact
   redirect is `${COMPANION_WEB_URL}/v1/companion-plugins/oauth/callback` and must use HTTPS in
   production.
3. Keep Socket Mode disabled. This deployment uses public HTTPS callbacks, not a persistent
   WebSocket held by API, worker, runtime, or Box.
4. Under OAuth & Permissions, verify the Bot Token Scope is `chat:write`. Enable token rotation when
   Slack offers it for the app.
5. Enable app distribution when more than one Slack workspace will install the app. Complete
   Slack's required app listing and redirect-domain checks before production rollout.
6. Copy the app's Client ID and Client Secret into API-only environment variables:

   ```dotenv
   COMPANION_MCP_SLACK_CLIENT_ID=...
   COMPANION_MCP_SLACK_CLIENT_SECRET=...
   ```

   Redeploy API after changing either value. Never put them on web, worker, runtime, release, Pi,
   or Box.

## Connect and use an account

In Companion, open **Plugins**, choose **Slack**, enter a short account label such as `work`, and
complete Slack's install flow. Multiple members can connect independently labeled accounts. An
Owner or Editor then attaches the desired account to a Companion through the existing plugin
selection UI.

The bot can send only where the installed Slack account and bot membership permit it. Invite the bot
to private channels and group conversations before asking a Companion to post there. Give the
Companion the exact Slack conversation ID (`C…`, `G…`, or `D…`); provide a parent message timestamp
to create a thread reply.

The OAuth endpoints, Bot User scope format, token exchange, and `chat.postMessage` behavior follow
Slack's official documentation:

- [OAuth v2](https://docs.slack.dev/authentication/installing-with-oauth/)
- [`oauth.v2.access`](https://docs.slack.dev/reference/methods/oauth.v2.access/)
- [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/)
