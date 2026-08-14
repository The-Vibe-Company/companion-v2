---
version: beta
name: Companion
description: Operator-grade light design system for Companion v2, a self-hostable Skills Hub for organizations and coding agents.
colors:
  primary: "oklch(0.27 0.021 265)"
  canvas: "oklch(0.975 0.004 265)"
  surface: "oklch(0.995 0.0015 265)"
  surface-raised: "oklch(0.955 0.006 265)"
  surface-sunken: "oklch(0.965 0.005 265)"
  line: "oklch(0.915 0.006 265)"
  line-strong: "oklch(0.855 0.008 265)"
  fg: "oklch(0.27 0.021 265)"
  muted: "oklch(0.475 0.018 265)"
  faint: "oklch(0.62 0.014 265)"
  accent: "oklch(0.81 0.166 88)"
  accent-hover: "oklch(0.75 0.166 88)"
  accent-muted: "oklch(0.75 0.166 88)"
  accent-fg: "oklch(0.27 0.04 88)"
  accent-ring: "oklch(0.66 0.166 88 / 0.55)"
  accent-tint: "oklch(0.955 0.05 88)"
  accent-line: "oklch(0.66 0.166 88 / 0.30)"
  accent-edge: "oklch(0.66 0.166 88)"
  accent-cloud: "oklch(0.585 0.142 242)"
  accent-cloud-hover: "oklch(0.52 0.142 242)"
  accent-cloud-fg: "oklch(0.99 0.012 242)"
  accent-cloud-tint: "oklch(0.585 0.142 242 / 0.1)"
  accent-cloud-line: "oklch(0.585 0.142 242 / 0.28)"
  ok: "oklch(0.55 0.13 156)"
  warn: "oklch(0.60 0.12 75)"
  danger: "oklch(0.55 0.20 25)"
  unknown: "oklch(0.62 0.012 265)"
  ok-tint: "oklch(0.55 0.13 156 / 0.12)"
  ok-line: "oklch(0.55 0.13 156 / 0.30)"
  warn-tint: "oklch(0.60 0.12 75 / 0.14)"
  warn-line: "oklch(0.60 0.12 75 / 0.32)"
  danger-tint: "oklch(0.55 0.20 25 / 0.10)"
  danger-line: "oklch(0.55 0.20 25 / 0.32)"
  scrim: "oklch(0.27 0.02 265 / 0.40)"
  brand-blue: "oklch(0.56 0.13 250)"
  brand-teal: "oklch(0.54 0.10 168)"
  brand-violet: "oklch(0.55 0.13 300)"
  brand-amber: "oklch(0.60 0.10 66)"
  brand-terracotta: "oklch(0.55 0.13 24)"
  brand-slate: "oklch(0.50 0.035 265)"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontFeature: "'tnum' 1"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  badge:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0em"
    fontFeature: "'tnum' 1"
  scale-xs: "0.75rem"
  scale-sm: "0.8125rem"
  scale-base: "0.875rem"
  scale-md: "1rem"
  scale-lg: "1.125rem"
  scale-xl: "1.375rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
shadows:
  xs: "0 1px 2px oklch(0.27 0.02 265 / 0.04)"
  sm: "0 1px 2px oklch(0.27 0.02 265 / 0.05), 0 1px 1px oklch(0.27 0.02 265 / 0.04)"
  md: "0 2px 6px oklch(0.27 0.02 265 / 0.06), 0 1px 2px oklch(0.27 0.02 265 / 0.05)"
  lg: "0 8px 28px oklch(0.27 0.02 265 / 0.12), 0 2px 6px oklch(0.27 0.02 265 / 0.06)"
motion:
  duration-fast: "120ms"
  duration-base: "180ms"
  duration-slow: "240ms"
  ease-out-quint: "cubic-bezier(0.22, 1, 0.36, 1)"
layout:
  sidebar-width: "244px"
  topbar-height: "56px"
  content-max: "1120px"
  drawer-width: "460px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "oklch(0.99 0.01 25)"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  badge-status:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.muted}"
    typography: "{typography.badge}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "16px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  row-selected:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  drawer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "24px"
    width: "460px"
  focus-ring:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
---

# Companion DESIGN.md

## Overview

Companion v2 is an operator-grade, self-hostable Skills Hub for organizations and coding agents. The visual job is to make skill scope, ownership, validation, versions, dependencies, labels, secrets, databases, and publication state legible at a glance.

The interface is product software, not marketing. It should feel calm, dense, precise, trustworthy, and engineering-grade. Reference quality is Linear, Stripe, and Raycast: familiar controls, compact hierarchy, real data shown plainly, and no decorative drama. Healthy state should be quiet. Broken state should be unmistakable without alarm theater.

This document describes the Companion theme as implemented in `apps/web`. Light is the default; a full dark
theme and user-selectable accent presets are available (see Colors). CSS custom properties live in
`apps/web/src/styles/tokens.css`; the `cds-*` component layer is in `cds.css`; feature-specific layout and
styling extend those tokens in `auth.css`, `skills.css`, `onboarding.css`, `org.css`, `settings.css`, and
`upload.css`.

## Colors

Companion uses restrained tinted neutrals and a **signal yellow** accent by default. Every neutral is slightly
tinted toward the cool Companion hue (~265 in OKLCH). Never use pure `#000` or pure `#fff` for product UI
surfaces or text.

The page sits on `canvas`, with panels, cards, sidebars, topbars, drawers, and form controls using `surface`.
Hovered rows and active navigation use `surface-raised`; inset code blocks and quiet wells use `surface-sunken`.
Structure comes from `line` and `line-strong`, not heavy shadows.

`accent` is the primary chromatic action color. Use it for primary actions, links, selected row treatment, and
focus indication. Do not use accent as decoration, chart filler, page glow, or gradient material. Hovered primary
buttons use `accent-hover`; selected rows use `accent-tint` plus an inset accent edge (`accent-edge` or
`accent-line`). `accent-muted` is available for subdued accent treatments.

Three accent presets are user-selectable in Account › Preferences via a `data-accent` attribute on `<html>`
(persisted per-device in `localStorage`, applied before first paint by a no-FOUC inline script). Signal yellow
is the default with no attribute. `data-accent="cloud"` swaps in the canonical cloud-blue tokens
(`oklch(0.585 0.142 242)` family). `data-accent="evergreen"` swaps in a calm green (`oklch(0.58 0.115 162)`
family) and `data-accent="coral"` a warm red-orange (`oklch(0.66 0.165 30)` family); each redefines the full
`accent*` set so primary actions, focus rings, and selected-row tints stay coherent.

A dark theme is available app-wide via `data-theme="dark"` on `<html>` (also chosen in Preferences — light,
dark, or follow-system — and applied before first paint to avoid a flash). It sets `color-scheme: dark` and
overrides the neutral ramp (`canvas`, `surface`, `surface-raised`, `surface-sunken`, `line`, `line-strong`,
`fg`, `muted`, `faint`), the `scrim`, and the `shadow-md`/`shadow-lg` elevations for a dark ground. Accent hues
are unchanged in dark mode; only `accent-tint` is lifted per accent (`data-theme="dark"` × `data-accent`) so
selected rows read against the darker surface. A one-frame `no-anim` class is toggled during a theme or accent
swap so background colors don't interpolate across the variable change.

During onboarding, org and team brand colors are chosen from a fixed six-color palette (`brand-blue`, `brand-teal`,
`brand-violet`, `brand-amber`, `brand-terracotta`, `brand-slate`). These are cosmetic only and stored per org/team;
they do not replace the product accent tokens.

Status colors are calm and slightly desaturated:

- `ok` means Healthy.
- `warn` means Degraded or Missing.
- `danger` means Down, destructive, or unrecoverable error.
- `unknown` means Unknown, pending, absent, or not yet observed.

Color never carries status alone. A dot, badge, or rail must always be paired with text such as `Healthy`, `Degraded`, `Down`, `Unknown`, `Present`, or `Missing`.

## Typography

Use system fonts only. No web fonts, no Google Fonts, no downloaded brand fonts. Companion must work offline and on private networks.

Use `body` (`scale-base`, 0.875rem) for most UI text, `heading` (`scale-lg`, 1.125rem) for page titles and card titles,
`label` (`scale-sm`, 0.8125rem) for metadata and form labels, `badge` (`scale-xs`, 0.75rem) for compact chips, and
`mono` for machine values. The full type scale also includes `scale-md` (1rem) and `scale-xl` (1.375rem) for auth titles
and onboarding headings. Typography hierarchy comes from size and weight, not from color saturation.

Machine values are load-bearing and must remain literal in monospace:

- skill ids and slugs such as `incident-summary`
- versions and checksums such as `1.4.0` and `sha256:…`
- scopes such as `personal` and `org`
- validation states such as `valid` and `invalid`
- env vars and secret names such as `GITHUB_TOKEN`
- label paths such as `engineering/incident-response`

Use sentence case for headings, labels, buttons, navigation, and empty states. Product and technology names keep their canonical casing: Companion, Hermès, Hermes, Granite, Tailscale, Fly, Kubernetes, Modal, OpenRouter, OpenClaw, MCP, `SKILL.md`, `SOUL.md`.

UI copy is terse and operational. Say what happened, what will happen next, or what the user can do. Avoid greeting copy, delight copy, mascot copy, and broad value propositions inside the app.

## Layout

Use a dense product layout. The primary shell is a fixed sidebar (244px) plus compact topbar, with the
main content constrained enough to scan but not padded into a landing page. Layout tokens:
`sidebar-width` 244px, `topbar-height` 56px, `content-max` 1120px, `drawer-width` 460px.

The sidebar presents the Skills libraries directly: My Skills, Organization, Installed, Companion skills, Archived, and Secrets. When `COMPANION_COMPANIONS_ENABLED=true` and the required email-domain allowlist is non-empty, a two-option Skills | Companions mode segment sits directly under the workspace switcher for authenticated users allowed by that list; the segment is absent by default, when the allowlist is empty, and for users outside the allowlist, and there is no separate top-level or bottom Companions entry. Skills mode keeps the libraries unchanged. Companions mode replaces them with the workspace Companion list, each row carrying an initial, a name, and a status dot paired with its status word, and keeps Secrets, Archived, and Settings reachable. The Companions surface is a list plus a workspace count, one search field, a Plugins action, and a New companion action. Plugins is a separate web and mobile-web surface that groups each MCP provider's member-private accounts into short labels such as `work` and `personal`; it offers the product-owned Linear, GitHub, and Notion catalog plus manual custom MCP connection, and credentials are entered there and never in chat. Creating a Companion asks for a name, one line of persona, one connected provider, then one model from that provider's live pi.dev list; provider credentials and sharing stay in focused dialogs. Opening a Companion replaces the list with its single chat thread: a back control, the Companion identity, its Box status chip, a Computer toggle for a runner, the conversation, and one composer. Nothing else belongs there — no Pi tools, no Skills, no plugins, no run chrome. The status chip names the compute it reports, as a dot plus `Box · online`, `Box · starting`, `Box · asleep`, or `Box · error`, and for a runner whose Box is already running the same chip opens the Box desktop Lux drives in a new tab. Computer use has exactly two places and no third: that tab, and one Computer panel a runner opens beside the conversation, which frames the live Box desktop in the thread and carries only Reconnect, Open desktop, and — for a sleeping Box — the header's own Wake. Both are the same Lux desktop over the same route, each join mints its own stream and keeps none, and neither can start a Box; there is no settings page for computer use and no third surface for it. A runner whose Box is asleep gets exactly one Wake control in that header; a Viewer gets the same transcript with the composer replaced by a read-only note and the same chip as text only, because reading a Companion must never start a Box. It must not render the Box/Pi harness, a full provider catalog, a creation wizard, or raw runtime chrome. Native mobile has no Plugins surface or MCP injection. External coding-agent access lives in Settings and is described explicitly as delegated Skills Hub access.

The focused model-provider dialog keeps API-key connection to one write-only field. Claude
subscription connection uses a browser authorization code and Codex uses a device code; neither
surface asks for `auth.json` or renders access and refresh tokens. Connected entries feed the first
step of the shared picker used by both creation and Companion settings; its second step shows only
the selected provider's live pi.dev models. The server bounds that fetch, caches the last-known
catalog, and falls back to bundled models so the picker never becomes empty.

Prefer tables and structured rows for resources. Companion lists skills, labels, versions, dependencies, members, scopes, comments, releases, databases, and audit events. These surfaces should be compact and sortable/filterable over time, not inflated into repeated marketing cards.

Summary metrics are inline counts, not hero cards. Use patterns like `Total 12 · Healthy 9 · Degraded 2 · Down 1`, with tabular numerals and status labels. Avoid large vanity numerals.

Rows should expose the operational facts in stable order: status, name or id, library, version, validation, creator, labels, dependencies, and last activity. Use truncation for long machine values, but keep copy affordances for ids and URLs.

Detail belongs in a right slide-over drawer. Do not make modal dialogs the default detail surface. The drawer should keep the list visible behind a flat scrim, support Esc and scrim close, and return focus to the originating row.

Forms are direct and compact. Use labels, concise helper text, and explicit consequences. For destructive or delayed lifecycle actions, explain the declared-state effect rather than hiding it behind vague confirmation copy.

## Elevation & Depth

Companion is flat and hairline-driven. Use 1px borders and subtle surface changes to separate layers. Cards, tables, sidebars, and topbars rely on `line`, not drop-shadow stacks.

Use shadows only for floating layers such as drawers, dropdowns, and dialogs. Shadow tokens are `xs`, `sm`, `md`, and `lg`; they should be soft and restrained; never use glow. Scrims are flat tinted overlays with no blur.

No glassmorphism. No backdrop blur. No translucent panels pretending to be glass. No gradient depth. No bokeh, grain, decorative textures, or atmospheric image backgrounds in product UI.

Motion is sparse and functional. Use `duration-fast` (120ms), `duration-base` (180ms), or `duration-slow` (240ms) with
`ease-out-quint` transitions. Allowed motion: drawer slide-in/out, scrim fade, hover color changes, selection color
changes, and short copy confirmation. Do not animate layout properties such as width, height, margin, or top. Respect
`prefers-reduced-motion` by removing drawer slide and scrim fade.

## Shapes

Radii are small and pragmatic:

- `sm` for badges, chips, icon buttons, and compact status containers.
- `md` for buttons, inputs, cards, rows, and error blocks.
- `lg` for drawers and larger panels.
- `full` only for status dots, toggle thumbs, and true pills.

Do not use oversized rounded SaaS cards. Do not put cards inside cards. Page sections are not decorative floating cards; reserve cards for actual framed data groups, repeated resource items, and compact panels.

Selection uses a tinted row background plus an inset accent edge via box-shadow. Do not use colored side-stripe borders. Focus uses one visible accent ring with offset and must not shift layout.

## Components

**Topbar** is compact and single-line. It shows product/workspace/view context, connection state, and updated timestamp. Use middle-dot separators and mono timestamps. No tagline, greeting, or hero title.

**Sidebar** contains the Companion brand mark, wordmark, workspace context, primary navigation, counts where useful, and a quiet environment/footer indicator. Active nav uses `surface-raised` with foreground text; unread counts may use the accent fill. The brand mark tile uses the official transparent Companion mark on a tokenized `surface` tile with a `line` border, so it works across light, dark, and accent presets.

**Skills workspace** is the single product workspace. The shell opens directly on the skill library. Skill detail uses Overview, Dependencies, Files, Database, History, and Activity only when those sections apply. Upload, browser creation, publishing, installation, public release management, comments, labels, secrets, and hosted database workflows stay close to the selected skill. No control may imply that Companion can run a skill or launch an agent.

**External agent access** is an account setting for delegated clients that consume the Skills Hub. Describe capabilities such as skill read/write, database read/write, and secret read/write. Never present a connected external client as a Companion-hosted or Companion-launched agent.

**Summary counts** are slim inline rows. Use tabular numbers, muted labels, and status dot plus label. They are not cards.

**Resource rows** are the core component. Rows are dense, keyboard-focusable, and full-width. Default rows use surface plus hairline dividers; hover uses `surface-raised`; selected uses `accent-tint` and a 2px inset accent edge. Copy affordances can reveal on hover, but keyboard users must still reach them.

**Skills Rhythm list** applies only to My Skills and Organization. The default grouped mode creates one
flat section per root folder and uses a light icon/name/count/chevron header with no card, side stripe,
colored band, or nested subsection. Subfolders stay as quiet relative-path metadata on the row, limited
to two most-specific paths plus an accessible `+N`. Installed and Without folder are trailing utility
sections. Sections start open and may collapse; search temporarily reveals matches. A compact
Grouped/Flat control sits beside sort. Selecting a sidebar folder keeps descendant roll-up, but scopes
group sections, visible paths, and inherited folder icons to that selected branch; other roots assigned
to the same skill stay hidden. In that scoped view, sections advance to the immediate subfolder level;
skills filed directly in the selected folder render first as plain rows without a section header or
collapse control. In unscoped root sections, direct rows lead and remaining rows stay contiguous by
immediate subfolder, while the selected sort remains stable inside each block. Every grouped row keeps the same
horizontal inset regardless of subfolder depth; order and quiet path metadata carry the hierarchy rather
than extra indentation. Flat mode keeps the full folder chips within that scope. In both modes the literal slug
is the only visible row identity, set in monospace, and accessible labels repeat the slug rather than a
display title. Skill icons resolve from the package manifest, then the deepest custom folder icon and
color for that occurrence, then a neutral package glyph. Keep this rhythm dense on mobile by wrapping
controls and metadata, not by turning rows or groups into cards.

**Skill Tables** is a conditional detail tab shown only when hosted databases are enabled and the
selected Skill declares tables. Use one compact master-detail workspace, not a dashboard: the first
rail selects `My data`, `Shared with me`, or `Organization`; shared data adds an owner selector; the
second rail selects a table; and the main pane shows a 50-row page ordered by primary key. Keep schema
information and add/edit forms in the standard slide-over drawer. Primary keys are visible but
immutable during edit, mutations must report exactly one changed row, and tables without a primary key
are explicitly read-only. Typed controls cover text, numbers, booleans, JSON, and timestamps; optional
values can be omitted so SQLite defaults or `NULL` still apply. `Manage sharing` appears only for the
caller's `My data` realm and opens a searchable member checklist with an explicit Save action. Shared
and organization realms retain data editing but never expose sharing controls. Loading uses skeleton
rows; empty, revoked, conflicted, failed, and archived-read-only states explain the consequence and
offer Retry where useful. On narrow screens preserve every capability through progressive
table → rows → full-screen panel navigation rather than shrinking the grid or removing actions.

**Companion settings** is a separate page reached from each Companion row action in the
Companions list. It has one direct form for name, instructions, and the same provider-then-model picker
used during creation, on the same flat hairline surface as the list without stacking cards or adding
navigation. The Owner alone sees a hairline-separated delete action and an explicit irreversible
confirmation; Editor can save but cannot delete, and Viewer sees disabled read-only fields. The thread, Box
chip, Plugins, Lux, and top-level navigation remain unchanged.

**Companion thread** is one transcript in one reading column, not a two-sided bubble chat. Turns are
left-aligned in a column narrower than the page; a writer keeps the floor across consecutive turns, so
the writer and the time appear once per passage and the turns under it are only the words. A member's
message is a tinted block with `md` radius and no border; a Companion reply is plain text on the page;
a run note is one quiet muted line. Loading uses static skeleton lines, and a running Box that owes a
reply says so as a muted line, never as an animated indicator. The composer is one field with its send
control inside it, one hint line underneath, and no toolbar: no attachments, dictation, slash commands,
mentions, model picker, or tool controls belong in the thread. A Viewer gets the same transcript with a
read-only note in place of the composer. Empty threads state what happens next instead of greeting the
reader, and there is no centered welcome panel and no thread list.

**Status dot plus label** is mandatory for health and lifecycle state. Dots are static 6px to 8px circles. No pulse, no glow, no animation.

**Badges** are compact chips for scope, lifecycle, role, validation, and status. Use mono only for machine-like values. Status badges use low-tint backgrounds and borders; neutral badges use raised surface and muted text.

**Buttons** are restrained. Primary uses signal yellow (`accent` / `accent-fg`) and appears only for the main action on the surface. Secondary buttons are hairline-bordered surface buttons. Ghost buttons are quiet utility actions. Danger buttons are reserved for destructive intent. Default control height is 36px (`cds-btn--md`); compact actions use 28px (`cds-btn--sm`); onboarding primary actions may use 40px (`cds-btn--lg`).

**Forms** use 36px controls, clear labels, one-line helper text, and visible error text. Technical inputs such as ids, env vars, paths, hosts, and resource addresses use monospace.

**Cards** are flat hairline panels on `surface` with `md` radius. Optional headers use title, description, and right-aligned actions separated by a hairline. Do not use colored decorative accents.

**Slide-over drawer** is the default detail surface. Width is about 460px on desktop and full-width on narrow screens. Header contains the resource name, status badge, and close button. Body uses definition lists, error blocks, code previews, and related resource chips. Footer contains the primary resource action and supporting actions.

**Error banners and blocks** reserve `danger-tint` and `danger-line` for failed validation or a failed
skill mutation. A recoverable synchronization problem uses `warn-tint` and keeps the safe retry or
download action visible. Put storage and validation diagnostics behind `Technical details`.
Machine output remains monospace and preserves line breaks.

**Empty states** are plain. Use a short title, one sentence of consequence, and one clear action when appropriate. No illustrations are required.

**Loading states** should be skeleton rows or quiet placeholders under text like `Waiting for first poll...`. Avoid full-screen spinners for data tables.

**Iconography** uses Lucide-style line icons: 24x24 viewBox, no fill, currentColor stroke, rounded caps and joins, around 1.75 stroke width. Icons are monochrome and support labels; they should not replace labels for unfamiliar actions. The brand mark may be a simple CSS mark or future official asset, but product UI should not invent mascots or illustrations.

## Do's and Don'ts

Do:

- Use the YAML tokens in this file as normative values.
- Build dense, scannable operator surfaces.
- Show real operational state plainly.
- Pair every status color with a text label.
- Use system fonts only.
- Render machine values literally in monospace.
- Use sentence case for UI copy.
- Use hairlines and flat surfaces for structure.
- Use slide-over drawers for resource detail.
- Keep focus states obvious and accessible.
- Keep motion short, functional, and reduceable.

Don't:

- Do not create marketing hero dashboards.
- Do not use big-number vanity metric cards.
- Do not use gradients, gradient text, glassmorphism, backdrop blur, glow, bokeh, or decorative texture.
- Do not use emoji in product UI.
- Do not use em dashes in UI copy.
- Do not use web fonts.
- Do not use pulsing, glowing, or animated status dots.
- Do not make color the only carrier of meaning.
- Do not use modal-first detail flows when a drawer preserves context.
- Do not build generic AI SaaS visuals: purple gradient cards, sparkle icons, oversized rounded panels, or identical icon-heading-text card grids.
- Do not prettify ids, states, roles, scopes, env vars, hostnames, resource addresses, or model names.
- Do not let healthy state shout. Do not let broken state hide.
