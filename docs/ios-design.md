# Companion iOS — Design System & User Journeys

**Reference: Grok Bot (Anysphere). Status: approved by owner.**

This document is the single source of truth for the Companion iOS redesign. It copies the Grok Bot design language faithfully — the owner's explicit direction — and adapts it to the companion-v2 stack (apps/ios, SwiftUI, CompanionKit). Every value is extracted from nine reference screens (5 App Store, 4 owner-provided) and the cursor.com/help/grok-bot UX documentation.

## Part I — Foundations

### 1. Philosophy
1. **Few screens.** The whole product is: one home list, one chat, three sheets (settings, plugins, bot detail), one computer view. No tab bar, no hamburger menu, no dashboard.
2. **The chat is the product.** Everything happens in conversation: tasks, approvals, plugin connects, file delivery. A routine is born from conversation, not from a form.
3. **Quiet chrome, loud identity.** Surfaces are neutral (white / light gray / true black). The ONLY color is each bot's character mark. Actions use black (primary) or system blue (secondary); system green appears only in native toggles and success checks.
4. **Bots are characters.** Every bot has a mark: a solid colored shape with two small white eyes. The mark is the avatar everywhere — list, chat, notifications, detail header.
5. **Native iOS or nothing.** Sheets, toggles, swipe actions, keyboards, haptics: all system components styled minimally.

### 2. Color tokens
Light (default): canvas #FFFFFF; surface.card #F2F2F7 (settings cards, plugin rows); surface.bubble.bot #EFEFF1; surface.bubble.inner #FFFFFF (inner card inside approval container); surface.chip #EFEFF1; bubble.user #0B0B0F; text.primary #111111; text.secondary #8E8E93; separator #E5E5EA (hairlines inside grouped cards only); cta.primary #0B0B0F; action.blue #007AFF (links, Authorize, Add routine, unread dots); toggle.green #34C759 (native toggles ON, connection checkmarks); danger #FF3B30 (destructive only).

Black (Appearance option): canvas #000000; surface.card #1C1C1E; surface.bubble.bot #1C1C1E; bubble.user #FFFFFF with text inverting to #000000; text.primary #F2F2F7; text.secondary #8E8E93; separator #38383A; cta.primary #FFFFFF with #000000 label.

### 3. Typography (SF Pro, system font)
Large title 28-34 bold; Row title 17 semibold; Body 16 regular; Preview/description 15 regular secondary; Section label 13 regular secondary; Timestamp 13-14 regular secondary; Button label 15 semibold; In-chat time 12 regular secondary. No display fonts, no letter-spacing games, no uppercase labels.

### 4. Character marks
A mark is a solid shape in one palette color with two small white eyes (two rounded oblique strokes, like //, centered in the upper third, tilted ~15°).
- Palette (11) — iOS system colors: black #000000, brown #A2845E, red #FF3B30, orange #FF9500, yellow #FFCC00, green #34C759, teal #30B0C7, blue #007AFF, purple #AF52DE, pink #FF2D55, gray #8E8E93.
- Shapes (8) — circle, blob (organic pebble), squircle, capsule, triangle, hexagon, flower/cloud, drop. These map to icon_shape 0-7.
- No mouth, no accessory. icon_mouth / icon_accessory stay in the schema but are NEVER rendered. Rendering is shape + color + eyes only.
- Sizes: 36pt (list rows), 20pt (chat header pill, inline), 64-80pt (detail header, pinned grid), 96pt (creation preview).
- One SwiftUI CharacterMark view, vector-drawn, used by every surface and by the APNs avatar renderer.

### 5. Radii, spacing, depth, motion
Radii: bubbles & cards 18; inner cards 12; chips & pills = capsule; header buttons = circle (44pt hit). Spacing: 4pt base; 16 screen margins; 12 between grouped cards; 8 between list rows (NO hairlines between rows — only inside grouped settings cards). Depth: flat, no shadows in content. Motion: system sheets, spring pushes, 0.2s control transitions, soft haptics on toggle and send.

## Part II — Components (Wave A scope: HOME only; chat/sheets/computer are later waves)

### 6. Home
- Header: owner avatar photo (44pt circle, left) — search circle button, + circle button (right). 1pt outline circles, white fill (light) / #1C1C1E (black). + opens New Bot creation.
- Sections: collapsible. Header row = section name + chevron, text.secondary. A section with <=3 bots renders as a PINNED GRID: horizontal row of 64-80pt marks with labels underneath. Otherwise standard rows. Unassigned is the default section at the bottom.
- Row: mark 36pt — title 17 semibold — preview one line 15 regular secondary — trailing timestamp (hierarchical: 8:41 AM today, Yesterday, weekday, 8/19) — blue unread dot 6pt right-aligned when unread. No hairline between rows.
- Swipe actions: trailing Move to (section picker), mute, delete.
- Long-press: context menu — Duplicate (copy with suffix, opens detail), Edit character, Move to, Delete.
- Creation sheet (New Bot): name field, shape row (8 shapes, tap to select), color row (11 swatches), title optional. Two taps and a name — done. No wizard.

## Part III — Wave A user journeys
- J1 First launch: onboarding (white canvas, floating marks, title, one line, black pill Sign in) -> home empty state (Create your first companion + black +) -> creation sheet -> chat opens, composer focused. No plugin setup, no wizard.
- J5 Organize sections: swipe row -> Move to -> pick section or New Section (name it). Section header tap = collapse. Small sections auto-render as pinned grid. Deleting a section moves its bots to Unassigned (never deletes bots).
- J7 Duplicate: home long-press -> Duplicate -> copy opens in detail (name suffix), same character editable.
- J8 Appearance: Settings sheet Appearance row -> segmented System / Black -> instant switch (marks stay colored; canvas/cards invert). (The settings sheet restyle itself is Wave C; only wire the appearance value storage/picker row if trivial.)

## Part IV — Adaptation rules
Mapping: Bot=Companion; Character (shape+color)=icon_shape 0-7 + icon_color 0-10 (exact match already; drop mouth/accessory from rendering); Sections=companion_sections (NEW backend entity needed); Duplicate=existing server-side duplicate, surfaced in context menu.
Migration: CharacterMark replaces every iOS avatar render (list, detail; push in Wave D). Web roster keeps old marks until its own wave — do NOT break web.
