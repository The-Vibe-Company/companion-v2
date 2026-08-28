# Companion iOS — Design System & User Journeys

**Reference: Grok Bot (Anysphere). Status: approved by owner.**

This document is the single source of truth for the Companion iOS redesign. It copies the Grok Bot design language faithfully — the owner's explicit direction — and adapts it to the companion-v2 stack (apps/ios, SwiftUI, CompanionKit). Every value is extracted from nine reference screens (5 App Store, 4 owner-provided) and the cursor.com/help/grok-bot UX documentation.

## Part I — Foundations

### 1. Philosophy
1. **Few screens.** The whole product is: one home list, one chat, one bot details page, supporting management sheets, and one computer view. No tab bar, no hamburger menu, no dashboard.
2. **The chat is the product.** Everything happens in conversation: tasks, approvals, plugin connects, file delivery. A routine is born from conversation, not from a form.
3. **Quiet chrome, loud identity.** Surfaces are neutral (white / light gray / true black). The ONLY color is each bot's character mark. Actions use black (primary) or system blue (secondary); system green appears only in native toggles and success checks.
4. **Bots are characters.** Every bot has a mark: a solid colored shape with two small white eyes. The mark is the avatar everywhere — list, chat, notifications, detail header.
5. **Native iOS or nothing.** Sheets, toggles, swipe actions, keyboards, haptics: all system components styled minimally.

### 2. Color tokens
Light (default): canvas #FFFFFF; surface.card #F2F2F7 (settings cards, plugin rows); surface.bubble.bot #EFEFF1; surface.bubble.inner #FFFFFF (inner card inside approval container); surface.chip #EFEFF1; bubble.user #0B0B0F; text.primary #111111; text.secondary #8E8E93; separator #E5E5EA (hairlines inside grouped cards only); cta.primary #0B0B0F; action.blue #007AFF (links, Authorize, Add routine, unread dots); toggle.green #34C759 (native toggles ON, connection checkmarks); danger #FF3B30 (destructive only).

Black (Appearance option): canvas #000000; surface.card #1C1C1E; surface.bubble.bot #1C1C1E; bubble.user #FFFFFF with text inverting to #000000; text.primary #F2F2F7; text.secondary #8E8E93; separator #38383A; cta.primary #FFFFFF with #000000 label.

The static launch canvas is always #000000. iOS launch screens cannot read the app's persisted Appearance choice before SwiftUI starts, so a black launch canvas prevents a saved Black preference from flashing white on a system-light device. Once the app root renders, System follows the OS and Black remains true black.

### 3. Typography (SF Pro, system font)
Large title 28-34 bold; Row title 17 semibold; Body 16 regular; Preview/description 15 regular secondary; Section label 13 regular secondary; Timestamp 13-14 regular secondary; Button label 15 semibold; In-chat time 12 regular secondary. No display fonts, no letter-spacing games, no uppercase labels.

### 4. Character marks
A mark is a solid shape in one palette color with two small white eyes (two rounded oblique strokes, like //, centered in the upper third, tilted ~15°).
- Palette (11) — iOS system colors: black #000000, brown #A2845E, red #FF3B30, orange #FF9500, yellow #FFCC00, green #34C759, teal #30B0C7, blue #007AFF, purple #AF52DE, pink #FF2D55, gray #8E8E93.
- Shapes (8) — circle, blob (organic pebble), squircle, capsule, triangle, hexagon, flower/cloud, drop. These map to icon_shape 0-7.
- No mouth, no accessory. icon_mouth / icon_accessory stay in the schema but are NEVER rendered. Rendering is shape + color + eyes only.
- Sizes: 36pt (list rows), 20pt (chat header pill, inline), 64-80pt (detail header), 96pt (creation preview).
- One SwiftUI CharacterMark view, vector-drawn, used by every surface and by the APNs avatar renderer.

### 5. Radii, spacing, depth, motion
Radii: bubbles & cards 18; inner cards 12; chips & pills = capsule. Header actions keep a 44pt hit area but render as bare icons with no drawn circle, outline, or shadow. Spacing: 4pt base; 16 screen margins; 12 between grouped cards; 8 between list rows (NO hairlines between rows — only inside grouped settings cards). Depth: flat, no shadows in content. Motion: system sheets, spring pushes, 0.2s control transitions, soft haptics on toggle and send.

## Part II — Components (Wave A scope: HOME only; chat/sheets/computer are later waves)

### 6. Home
- Header: owner avatar photo (44pt clipped circle, left) with no border or ring — bare search and + icons (right), each retaining a 44pt hit area with no visible circle or outline. + opens New Bot creation. The chat header keeps only back, the tappable Companion pill, and the bare computer action.
- Sections: collapsible. Header row = section name + chevron, text.secondary. Every section uses standard rows with a 36pt mark, title, one-line preview, timestamp, and unread dot. Unassigned is the default section at the bottom.
- Row: mark 36pt — title 17 semibold — preview one line 15 regular secondary — trailing timestamp (hierarchical: 8:41 AM today, Yesterday, weekday, 8/19) — blue unread dot 6pt right-aligned when unread. No hairline between rows.
- Swipe actions: trailing Move to (section picker), mute, delete.
- Long-press: context menu — Duplicate (copy with suffix, opens detail), Move to, Delete. Detail has no context-menu shortcut; activate the Companion row or mark itself.
- Creation sheet (New Bot): name field, shape row (8 shapes, tap to select), color row (11 swatches), title optional. Two taps and a name — done. No wizard.

## Part III — Wave A user journeys
- J1 First launch: onboarding (white canvas, floating marks, title, one line, black pill Sign in) -> home empty state (Create your first companion + black +) -> creation sheet -> chat opens, composer focused. No plugin setup, no wizard.
- J5 Organize sections: swipe row -> Move to -> pick section or New Section (name it). Section header tap = collapse. Every section keeps the same readable list-row treatment. Deleting a section moves its bots to Unassigned (never deletes bots).
- J7 Duplicate: home long-press -> Duplicate -> copy opens in detail (name suffix), same character editable.
- J8 Appearance: Settings sheet Appearance row -> segmented System / Black -> instant switch (marks stay colored; canvas/cards invert). (The settings sheet restyle itself is Wave C; only wire the appearance value storage/picker row if trivial.)

### Navigation contract
The roster is the entry point for every Companion: a row opens the same details page. The chat header is a centered CharacterMark-and-name pill that opens that page too. Details presents character, name, instructions, provider/model, routines and run history, notifications, Skills, plugins and selected MCP accounts, triggers, runtime controls, and Owner-only deletion as peer cards in one scroll. Its explicit Open chat action replaces the detail route, preserving a single chat/details cycle. Member settings remains reachable only from the account avatar; there are no separate connected-resources or legacy Companion-settings destinations. The root NavigationStack installs the native interactive pop plus a supplemental leading-edge capture once, so pushed chat, details, computer, and history surfaces share guarded back behavior without intercepting horizontal content scrolling.

## Part IV — Adaptation rules
Mapping: Bot=Companion; Character (shape+color)=icon_shape 0-7 + icon_color 0-10 (exact match already; drop mouth/accessory from rendering); Sections=companion_sections (NEW backend entity needed); Duplicate=existing server-side duplicate, surfaced in context menu.
Migration: CharacterMark replaces every iOS avatar render (list, detail; push in Wave D). Web roster keeps old marks until its own wave — do NOT break web.
