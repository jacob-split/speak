# Speak Branding And UI Guidelines

Speak should feel like a compact native operations app: quiet, precise, neutral, dense, and built around outbound voice workflows. The design reference is the restraint of Codex and ChatGPT, not their trademarks, artwork, or exact UI.

The interface is successful when an operator can scan business contacts, understand call state, act without hunting, and switch between Dialer and Playground without relearning control placement.

## Source Of Truth Model

`BRANDING.md` is the visual-design authority for Speak. It captures the
product-specific intent, negative constraints, component grammar, token roles,
and verification expectations future Codex agents and outside agent hosts must
follow.

Do not create or maintain a separate `DESIGN.md` as a second source of truth.
If an outside tool requires DESIGN.md-shaped context, derive it from this file,
`src/index.css`, and the generated `frontend.designSystem` contract instead of
forking the design rules into another manually maintained document.

Source order:

1. `BRANDING.md`: visual intent, component grammar, layout rules, responsive
   standards, anti-patterns, and QA expectations.
2. `src/index.css`: exact token values for colors, typography families, popout
   treatment, geometry, breakpoints, and theme variants.
3. `src/App.css`: component implementation using the shared tokens.
4. `server/agent-contract.mjs`: machine-readable `frontend.designSystem`
   summary for outside agents, browser automation, widgets, and host adapters.
5. `src/uiContract.ts`: stable route IDs, `data-testid`, and `data-action-id`
   values for browser QA and agent automation.

When these conflict, do not guess. Inspect the rendered UI, current CSS tokens,
and generated agent contract, then update the stale document or implementation
as part of the same change.

## Agent Design Contract

Agents should treat this document like a design.md-style checklist, but with
Speak-specific runtime and proof requirements included. The useful DESIGN.md
categories map here as follows:

| DESIGN.md area | Speak authority |
| --- | --- |
| Overview | Brand Position and Design Philosophy. |
| Colors | Color And Theme plus `src/index.css`. |
| Typography | Typography plus `--font-sans` and `--mono`. |
| Layout | Topbar Grammar, Panel Geometry, Layout Rules, and Responsive Standards. |
| Elevation & Depth | Color And Theme, popout tokens, and Layout Rules. |
| Shapes | Geometry tokens and component recipes. |
| Components | Components and Component Token Recipes. |
| Do's and Don'ts | Design Principles, Anti-Patterns, and UI QA Checklist. |

External agents must not invent controls, colors, action names, or layout
patterns from generic design-system defaults. Start from the generated
`frontend.designSystem` contract, then use this file for the reasoning behind
the tokens and component rules.

## Brand Position

- Product: Speak.
- Category: outbound voice-agent operations platform.
- Audience: enterprises, startups, independent operators, and sole proprietors managing high-trust phone workflows.
- Desired feel: reliable, calm, high-control, compact, professional.
- Undesired feel: SaaS marketing dashboard, AI demo toy, CRM clutter, decorative assistant, large-button kiosk.

## Design Philosophy

Speak should look designed by someone who understands the operator's pressure. The app is quiet because the work is loud: phones ring, contacts interrupt, voice and phone state can change quickly, and the operator needs confidence more than delight. Good design here removes uncertainty.

This product should feel native, not theatrical. Native means controls are where the hand expects them, status is visible without shouting, and dense information remains readable. It does not mean copying macOS or OpenAI literally; it means adopting their restraint, hierarchy, and respect for repeated work.

The design philosophy is built on five ideas:

1. **Trust Through Specificity**
   Controls must map to real backend actions. Status pills should describe actual runtime state. Empty states should say what is true now. Never use UI to imply capability the system cannot prove.

2. **Density Without Clutter**
   Dense is not crowded. Dense means the important information is close together, aligned, and scannable. Clutter is duplicated labels, extra cards, large buttons for routine actions, helper text that explains the obvious, and decorative surfaces that steal rows from the queue or height from transcripts.

3. **Muscle Memory As Safety**
   Repeated actions should land in the same place across pages. The route switch, search, appearance, and transcript/test action groups are deliberately symmetrical because page switching should not force the operator to re-aim. If a new shared control appears on multiple pages, design it as one cross-surface pattern.

4. **Playground Is A Workshop, Dialer Is The Floor**
   The dialer is for live calling. Playground is for shaping agents and testing behavior. Do not move deep prompt or Speak settings onto the dialer just because they are available. Keep the dialer focused on the operator loop and make Playground powerful without making it loud.

5. **Aesthetic Restraint Serves Runtime Clarity**
   The visual system should be neutral and compact so realtime state carries the emphasis. Accent color is for focus, selection, readiness, and primary action. Large colors, gradients, illustrations, and oversized typography compete with the job and should be absent.

When unsure, ask: does this change make the operator faster, more certain, or less likely to make a call-state mistake? If not, remove it or keep it out of the primary surface.

## Design Principles

- Density is useful. Protect visible business contacts, transcript height, and repeated-action speed.
- Every element must earn its space through action, state, configuration, or review.
- Use clean icons over large labeled buttons when the icon is standard and the action has `title` and `aria-label`.
- Keep symmetry between Dialer and Playground for shared controls. Cursor-stable placement is a product goal.
- Prefer one strong work surface over multiple decorative sections.
- Menus, popovers, and popout dialogs must dismiss on outside click or backdrop click and on Escape. Inline accordions are the exception.
- Menus, popovers, drawers, and modal popouts use the shared `--speak-popout-*` token set for surface color, border, corner radius, row radius, divider color, and restrained shadow. Do not hard-code a one-off edge treatment for new popouts.
- Do not use glow, halo, or shadow rings to represent focused inputs, active cells, selected rows, or active controls. Use border, background, icon, or text weight changes instead.
- Use existing tokens and shared components before adding new styles.
- Avoid explanatory UI copy. If a conventional control can communicate the action, do not add visible instructions.
- No gradients, decorative blobs, oversized cards, hero sections, stock imagery, or marketing composition.

## Surface Hierarchy

### Generative UI Widgets

Speak widgets should be host-portable and product-consistent. ChatGPT/OpenAI
Apps, MCP Apps, AG-UI, A2UI, AI SDK, iframe, custom-element, or future widget
hosts may provide different chrome, but the Speak action semantics, proof
language, authorization modes, and compact operator hierarchy should come from
the shared `generativeUi` and backend action contracts.

Widget UI should preserve the same restraint as the web app: queue/profile
state first, recent proof second, high-risk live-world actions as explicit
intents or preauthorized tool calls, and no decorative instructional panels.
Conversational widget or web-app chat must still route through the shared
backend action contract and return proof, draft patches, or commands rather
than becoming a separate decorative assistant surface.

Approved GenUI widgets are chrome-free from the operator's perspective.
Framework names, adapter panels, schema rails, host descriptions, and preview
headings belong in documentation or generated manifests, not inside the visible
widget. Desktop widgets begin at the `Library / Dialer / Playground` route
selector with utility controls to the right and the context/work surface below.
Mobile widgets render nothing above that same route selector. If a host needs to
show ChatGPT Apps, MCP UI, AG-UI, A2UI, Vercel AI SDK, Vercel JSON Render, or
CopilotKit metadata, keep it outside the Speak widget frame.

### Dialer

The dialer is the primary surface. It should show the business contact list and transcript console immediately.

Priority order:

1. Business contact list and row detail actions.
2. Transcript/call controls.
3. Persistent app chrome and compact global actions.
4. Secondary popovers.

Business rows should identify the account or organization first, then the contact and operational state. Keep transcript height dominant.
Contact rows should use the leading field-values popout for row details, not a repeated static Start button. The dialer has one stateful Call/Stop/End action using the same visual grammar as the Playground Call button, plus one persistent device-call action for calling the selected contact from the operator's current device. On desktop they are centered in the transcript surface; on phone they sit in the top command row with search and appearance shifted left. Queue state remains obvious and repeated call actions do not compete with contact metadata.
The Dialer transcript panel remains the call-history and live-transcript
surface. Agent Whisper and conversational operator turns are backend/action
paths, not a separate visible Dialer chat panel unless that component is
rebuilt.
Transcript attempts should read oldest-to-newest, with live call attempts as
the newest conversation section after history. The transcript header must keep
every currently available live-call control visible, including End Call,
takeover, skip, audio, expand, and close; on phone, action rows wrap instead of
clipping or hiding critical controls.
When Hume emotion scores exist, show them as compact per-turn metadata under
the transcript text. Use restrained score bars attached to the message, not a
separate analytics card or detached dashboard.
Transcript labels should read as people and profiles, not raw roles: agent
turns use the active configuration name and contact turns use the contact or test
contact name. Preserve role-based alignment and styling underneath.

### Playground

Playground is secondary to the live-calling loop, but it must use the same chrome and control grammar.

Priority order:

1. Centered Playground agent selector.
2. Unified Call control for browser and explicit phone-quality tests.
3. Prompt editor and playground transcript or Smart Config chat split across the main desktop canvas.
4. Speak settings pop-out and profile maintenance.
5. Owner-only Smart Config as a playground conversation mode.

Saved profiles are selected from the centered Playground selector. Speak settings live in the settings pop-out so profile maintenance does not consume prompt or transcript width.
On phone, the playground chat surface becomes the primary full-height config experience. Agent switching stays inside Playground chrome instead of becoming global Dialer or Library chrome, and the Prompt control toggles the prompt editor into the transcript body instead of rendering a second stacked panel.
Contact and profile lists expose visible select-all controls in the list surface itself. Contact bulk actions may change statuses or delete records; profile bulk actions may copy or delete profiles, while active-agent selection remains in Playground.
Bulk action bars should render as quiet count/select surfaces until at least one row is selected. Do not show disabled bulk action labels in the resting state; reveal compact status/delete/clear or copy/delete/clear actions only after selection.
Smart Views are saved workflow objects, not decorative filters. Creating, selecting, importing, and assigning them should stay in compact controls that preserve the contact-list and profile-list rhythm.

### Library

The library is the dense data-management surface. It is allowed to feel more like a compact database than the dialer because its job is bulk editing, CSV import, Smart View creation, column management, and call ordering.

Priority order:

1. Smart Views and current list source.
2. Editable contact database.
3. Agent-library reconciliation across profiles, Smart Views, contacts, calls, recordings, and transcripts.
4. Bulk status/delete and queue-order actions.
5. Column labels, column order, visibility, filter, and sort controls.
6. Transcript-history mode for completed phone and playground conversations.

Library should keep the same app navigation and global-search grammar as Dialer and Playground, but it should not inherit dialer transcript spacing or live-call hierarchy.
Agent and transcript history may borrow compact transcript grammar for expanded
previews, but the Library shell should feel like a record browser: searchable,
filterable, compact, and organized by source, recording status, outcome, agent,
Smart View linkage, contact linkage, and score availability.

Communication-thread views should feel like the existing transcript grammar
extended across channels, not like a separate inbox product. A one-pane contact
conversation may mix call transcript turns, SMS, email messages,
browser tests, operator chat, tool proof, recordings, and provider events, but
those entries should share compact message geometry, participant labels,
copy/collapse actions, timestamps, fixed sender colors, and provider metadata.
Sent/outbound agent and operator turns use the dark bubble in every appearance
mode. Received/contact turns use the readback bubble, except contact/user-side
SMS which is always iMessage blue in every appearance mode. Sent/outbound SMS
stays on the fixed sent/dark treatment. Email messages use the fixed Speak
purple communication treatment in every appearance mode, render the subject as
the collapsed message body, and expand inline to show the full body. Received
SMS/email messages expose a reply action in the same action strip as copy.
SMS reply must always offer both current-device SMS handoff and backend send
through the configured Telnyx/Speak agent number. If a provider emits
per-turn enrichments such as Hume emotion scores, render the same compact score
strip used by transcripts; providers without that enrichment simply omit it.
Channel filters are view controls only; they must not imply separate customer
histories or separate memory stores.

On phone, Library source controls should be immediately visible as one compact stack: contact add, CSV import, Personal Phone sync, Smart View name/save, then the table filter controls. Avoid nested mini-scroll regions in this top control stack. Library route/search/appearance controls use the same top command coordinates as Dialer and Playground; dense record controls do not get to shift shared chrome. Library selection should feel like the desktop bulk pattern: a quiet select/count surface at rest, then compact status/delete/clear actions only after records are selected. Mobile contact rows use selection state and background/border contrast before exposing secondary ordering controls.

## Topbar Grammar

Topbars are the clearest place where symmetry matters.

### Shared Structure

Desktop persistent chrome:

- Left compact island: Library, Dialer, Playground, global search, and appearance.
- Route icons use compact active-page disclosure: the active route shows
  `Library`, `Dialer`, or `Playground`; inactive routes remain icon-only.
  The active label uses the same optical size as its icon so page identity reads
  as one selected control instead of a small caption. The route dock uses one
  stable visible track on desktop and phone so Search and Appearance do not
  drift when switching between Library, Dialer, and Playground. The selected
  route uses the fixed active slot with even inline padding; inactive routes
  stay icon-only in their literal order. Do not add hidden padding outside the
  route track, let the active route jump to the first slot, or expand the left
  panel width to compensate for page-title length.
- Do not render a persistent global active-agent selector on Dialer or Library. The current profile selector is a Playground control; the dialer may expose a compact queue setup selector for choosing the calling agent, contact source, optional Smart View filter, and schedule.
- Do not render a separate active-agent pill or glow state. Active and focus states use border/background contrast only.
- Owner-only Codex access lives in Smart Config inside the playground, not as a separate floating popout. Smart Config uses the theme-aware Codex app icon from the light/dark image assets without a visible text label in the composer source picker.
- Do not render auth/token fields in the app chrome; owner access belongs to server/runtime setup. A compact `Continue with Google` action is acceptable when the Smart Config owner session cookie is missing. New Smart Config Codex sessions use `Speak / Main / Smart Config - {agentName}` as the visible thread title.
- Do not use the `Speak` wordmark in page chrome; the browser title/icon carry the product name.

Phone chrome:

- Use a mobile-first top command band: route controls keep the same literal `Library / Dialer / Playground` order, while the mobile root URL defaults to Playground. Search and Appearance live in a top-right utility cluster, and Dialer may add the Call action beside that shared chrome.
- On mobile Dialer, keep route navigation, search, appearance, and the Call button in the top row. Search and appearance may shift left to make room for the Call button. Place the agent/list/schedule setup chip in its own row below so controls do not cluster or overlap.
- Keep route controls and utility controls visible without horizontal overflow or clipped hit targets.
- Global search is an icon trigger, not a full-width input.
- Mobile inputs must request the right keyboard: search for search/filter fields, tel for phone numbers, email for email, numeric for scores, and send/done enter hints for chat and edit completion. Use the visual viewport to preserve the active composer or form action when iOS or Android keyboards are open. Keep mobile input text at iOS-safe sizes so focusing an input does not zoom the full page.
- Phone pages should feel native-app stable: lock accidental pinch/double-tap/focus zoom, contain scroll bounce inside the intended panel, and prevent document-level width/scale drift while preserving normal vertical and horizontal panel gestures.
- Start/Stop remains a large repeated-action button in the work surface where the user is already acting, not a duplicate topbar control.
- Live-call and live-test controls must remain visible without page hunting. Let compact header action groups wrap on phone before reducing control size or hiding a Stop/End action.
- The visible `Dialer` / `Playground` title row stays collapsed on phone. Preserve page identity through active navigation state, page URL, browser title, and useful `title`/`aria-label` text.

### Dialer Topbar

Middle group:

- Global search icon for contacts, communication threads, transcripts, profiles, and Smart Views.
- Appearance immediately to the right of search.
- Compact dialer setup for agent, contact source, optional source-scoped Smart View filter, and schedule. On phone it uses a separate full-width row below route/search chrome.
- Advanced filter/sort/view manipulation belongs in Library.

- The transcript panel fills the top-right space immediately; no right-side status group is rendered. The stateful Call/Stop/End action is centered in the transcript panel on desktop and moves to the mobile top command row, not duplicated in every contact row.

### Playground Topbar

Middle group:

- Global search icon for profiles, contacts, communication threads, transcripts, and Smart Views.
- Appearance immediately to the right of search.

- Add agent through the Playground selector menu.
- Profile edits do not autosave while typing. Minimal icon-only Save controls are allowed beside the Playground agent selector and in the settings pop-out because they provide explicit provider-sync proof before the next browser test, phone test, or dialer call.
- Selecting a profile in the Playground selector chooses the profile being edited and tested.
- Copy and Delete belong in the configuration settings pop-out so profile
  maintenance actions do not crowd the playground command strip.

### Alignment Rules

- Desktop search and appearance should share the same x-position across Dialer,
  Library, and Playground.
- Desktop app navigation should keep the active route icon visible and stable.
- Phone route controls and search/appearance utility cluster should remain stable across Dialer, Library, and Playground. Dialer setup may take a second row below them, but it must not overlap the route or utility controls.
- Phone Dialer and Playground are fixed-height workspaces. The document itself should not scroll or drift under the operator; only the contact list, transcript, prompt, chat, or popout body that owns the content should scroll. Call buttons, route controls, search, appearance, and the active composer stay anchored through accidental swipes and keyboard viewport changes.
- Dialer continuity is part of the design contract. The selected agent/list,
  Smart View, filters, selected rows, queue IDs, running/scheduled state, and
  controller heartbeat are server-owned workspace state so route switching,
  reloads, and desktop-to-mobile handoff do not make the operator rebuild the
  working queue.
- Browser and Phone are options inside one Call control in the playground command strip. A separate persistent device-call action sits beside it and uses the same selected saved/ad hoc contact. The Call popover lets the operator choose an existing contact or create a new one, then start Browser or Phone from that same context.
- Smart Config belongs in the bottom-left playground composer source picker with Speak and, on phone, Prompt. It should use the theme-aware Codex app icon only and feel like another conversation mode of the selected agent, not a marketing assistant, settings wizard, or separate desktop Codex popout.
- Do not add a redundant ready check icon, persistent active-agent pill, or glow state to page chrome.
- On phone, do not spend a dedicated row on the Speak logo plus page title; active icon navigation carries page identity.
- Do not accept "close enough" from screenshots when changing topbars; measure DOM geometry.

## Panel Geometry

- Dialer panes should be contiguous. Do not use decorative gaps between contact list, transcript, and details surfaces.
- If no dialer contact source has been selected, the contact list may be blank; do not backfill the full database just to occupy space. Smart Views filter within the selected source rather than replacing the source.
- Contact and profile/history lists are flush scroll surfaces. Do not add wrapper padding,
  bottom gutters, title rows, card borders, or visible row grid lines; use
  spacing, hover state, and selected-state backgrounds instead.
- Expanded transcript panel fills the available height from the top edge on desktop; on phone it must respect the top command and utility safe areas.
- Operator chat uses the transcript panel geometry with a bottom composer;
  on phone, composer controls should use large tap targets and the panel should
  keep the same 420 px minimum work height as the expanded transcript/test
  panels.
- Phone transcript review opens from the business row as a message-style pop-out drawer, with a second action to expand to full viewport.
- Phone expanded transcript panel is full viewport content width and at least 420 px tall; fullscreen transcript review should use the full phone viewport.

### Agent Playground Panel

Playground should mirror the dialer grammar: compact chrome, one primary work surface, and transcript-style testing.

- Desktop: agent switching lives in the centered Playground selector, while prompt and test transcript split the reclaimed work surface width.
- Desktop Smart Config keeps the prompt editor visible beside the chat so auto-applied prompt changes are inspectable without mode switching.
- Phone: the test panel uses the full useful viewport height below the mobile command chrome, with one Call control in the header and Speak, Prompt, and Smart Config available from the bottom-left composer source picker inside one chat frame.
- Phone Smart Config uses the same full-height chat frame and safe-area behavior as the playground transcript.
- Browser tests and real phone-quality tests share the Playground test transcript surface and selected-contact picker. Browser does not place a phone call, but it should use production-style selected-contact context and configured agent actions; the phone path must look and behave like a real outbound call with an explicit Phone/Stop control.
- Only an active Playground Phone call adds compact Spy and Barge controls to the bottom console plus a microphone action for audio Whisper. Typed console text becomes private Whisper guidance. Spy/Barge/Whisper must not appear for Browser or Device modes, and they must use the existing compact icon grammar with explicit labels or accessible titles instead of expanding the top command strip.
- The playground command strip is for the unified Call control. Prompt, Speak playground, and Smart Config belong in the bottom-left composer source picker. The selected profile name belongs in the Playground selector, not in a repeated transcript title.
- Smart Config messages use the existing Codex transcript grammar: user bubbles on the right, Codex responses on the left, Markdown/code/table rendering through the Codex rich-message renderer, and compact history/new-thread controls scoped to the selected profile.
- Switching the selected profile clears the prior profile's visible Playground and Smart Config transcript state before loading the newly selected profile's saved history.
- Saved playground attempts render oldest-to-newest, and active playground attempts render after saved history so the visible flow follows the live session. The unified Call control and Stop state stay in the playground command strip and may wrap on phone instead of opening clipped menus.
- The selected profile in the Playground selector is the profile used for future testing and dialing. Preserve transcript height and desktop width by avoiding a separate profile selector row, separate profile sidebar, or separate mobile prompt panel.
- On phone, the Prompt source option opens the prompt editor in the transcript body area. Choosing Speak or Smart Config restores the relevant chat body without changing the bottom composer.
- Typed playground messages are simulated contact/user turns sent into the active browser test session. They use the transcript bubble grammar with a bottom composer and must not become hidden operator guidance or temporary prompt context.
- The playground composer is compact by default. The transcript/test body owns the flexible height; the Send button must remain a normal tap target, not stretch vertically with the panel.
- Persisted playground attempts render as transcript call-attempt sections so test conversations can be reviewed after the active browser or phone session ends.
- The config prompt and test panels are the framed work surfaces; avoid wrapping them in another visible card.
- If Speak settings collapses to a rail on phone, it must not reduce test-panel width.

## Color And Theme

Use `src/index.css` tokens. Do not introduce one-off colors unless a semantic token is missing and the new token is used consistently.

Exact values live in `src/index.css`; this file defines roles and allowed use.
Do not copy CSS values into docs, screenshots, generated manifests, or prompt
templates as a parallel token system.

### Core Token Index

| Group | Tokens | Use |
| --- | --- | --- |
| Base surfaces | `--bg`, `--surface`, `--surface-raised`, `--surface-subtle`, `--surface-muted` | Page canvas, primary panes, raised surfaces, and quiet grouped controls. |
| Interaction surfaces | `--surface-hover`, `--surface-selected`, `--surface-active`, `--selection`, `--tap-highlight` | Hover, selected, active, text-selection, and touch feedback states. |
| Text | `--text-strong`, `--text`, `--muted` | Primary labels, normal reading text, and secondary metadata. |
| Lines | `--border`, `--border-strong`, `--divider-soft` | Standard borders, stronger dividers, and quiet internal rules. |
| Accent | `--accent`, `--accent-hover`, `--accent-strong`, `--accent-contrast`, `--accent-soft`, `--accent-border` | Primary action, selected state, focus selection, and sparse emphasis. |
| Focus | `--focus-border`, `--focus-ring` | Accessible focus treatment without glow or halo styling. |
| Status | `--success`, `--success-surface`, `--success-border`, `--danger`, `--danger-surface`, `--danger-border`, `--warning`, `--warning-surface`, `--warning-border`, `--info`, `--info-surface`, `--info-border` | Runtime and destructive states. Keep them compact and proof-backed. |
| Specialized | `--purple`, `--purple-surface`, `--neutral-surface`, `--audio-fill`, `--audio-fill-hover`, `--audio-text` | Limited special states such as score metadata and audio controls. |
| Shadows | `--shadow-subtle`, `--shadow-raised` | Restrained depth only; avoid creating new shadow scales. |
| Popouts | `--speak-popout-bg`, `--speak-popout-inner`, `--speak-popout-border`, `--speak-popout-divider`, `--speak-popout-shadow`, `--speak-popout-radius`, `--speak-menu-radius`, `--speak-popout-row-radius` | Menus, popovers, drawers, and modal popouts. |
| Geometry | `--speak-control-height-desktop`, `--speak-control-height-phone`, `--speak-dense-icon-size`, `--speak-phone-icon-size`, `--speak-radius-panel`, `--speak-radius-control`, `--speak-topbar-search-width`, `--speak-left-panel-width`, `--speak-phone-transcript-min-height`, `--speak-phone-breakpoint` | Stable control sizing, pane width, radii, and responsive thresholds. |
| Typography | `--font-sans`, `--mono` | App text and compact technical metadata. |

### Token Roles

- `--bg`: page background.
- `--surface`: main surface.
- `--surface-subtle`: nested or quiet surface.
- `--surface-muted`: grouped control background.
- `--surface-active`: hover/selected low-emphasis state.
- `--text-strong`: primary text.
- `--text`: normal text.
- `--muted`: secondary text.
- `--border`: standard border.
- `--border-strong`: stronger divider or empty-state border.
- `--accent`: primary action.
- `--accent-soft`: active or selected background.
- `--accent-strong`: selected text/icon.
- `--danger`: destructive action.
- `--warning`: caution or unsaved state.
- `--success`: ready state.
- `--shadow-subtle`: restrained elevation.

Agent-readable geometry tokens live in `src/index.css` and are advertised by
`/api/agent/capabilities` under `frontend.designSystem.cssTokens`. Use these
before adding new dimensions:

- `--speak-control-height-desktop`
- `--speak-control-height-phone`
- `--speak-dense-icon-size`
- `--speak-phone-icon-size`
- `--speak-radius-panel`
- `--speak-radius-control`
- `--speak-topbar-search-width`
- `--speak-left-panel-width`
- `--speak-phone-transcript-min-height`
- `--speak-phone-breakpoint`

Direction:

- Neutral grays and native surfaces are the base.
- Accent color is functional and sparse.
- Ready, warning, and danger states must be legible but not oversized.
- Warm warning colors should not dominate this product.
- Avoid large colored backgrounds and one-note palettes.

## Typography

- Primary font: Helvetica Neue.
- Fallbacks: Apple system fonts, SF Pro Text/Display, Inter, ui-sans-serif, system fonts.
- Use the lighter Codex-aligned typography weight profile: body/nav at `300-420`, wordmark and product-page hero `Speak` at `200`, route labels and public page titles at `300`, compact headings around `360-540`, and only rare status emphasis up to `560`.
- Do not use `700+` weights in Speak app, public docs, logo, favicon/share-card, or generated public assets unless a specific brand review approves it.
- Do not scale font size with viewport width.
- Letter spacing should be `0` except established compact uppercase metadata.
- App title is compact, not hero type.
- Panel headings are short and functional.
- Row text should be readable at dense sizes.
- Pills, chips, and buttons must stay single-line or collapse labels.

## Logo And App Icon

- The Speak logo mark is the waveform only. Browser tabs, favicons, normal app chrome, composer mode controls, documentation headers, and wordmarks must use the waveform-only mark, not the rounded-square app-icon container.
- The Codex-style rounded square is reserved for app icons, Apple/Android touch icons, social previews, and prototype/icon contexts where the platform expects a contained square icon.
- When a wordmark is needed, pair the waveform-only mark with the thin Helvetica Neue `Speak` wordmark. Do not use the square icon as the wordmark mark.
- The waveform strokes must stay very thin and minimalistic, with visual weight matched to the `200` wordmark. Do not use heavy pill bars, thick strokes, shadows, or glossy highlights for the normal mark.
- The waveform should fill its own mark box generously while retaining a restrained grayscale material.

## Components

Before adding or changing a component, identify:

1. The workflow object it represents.
2. The stable action or state it exposes.
3. The existing token group it uses.
4. The desktop and phone geometry it must preserve.
5. The proof or backend action that makes it real, when applicable.

If no existing token fits, add one semantic token to `src/index.css`, expose it
through `frontend.designSystem` if outside agents need it, update this file, and
verify the rendered UI. Do not solve a single component with a local color,
radius, shadow, or type scale.

### Component Token Recipes

| Component | Required grammar |
| --- | --- |
| Route switch and topbar icons | Fixed dock footprint, icon-first, active route expands to show its page label, inactive routes stay icon-only, hover/active state through subtle surface contrast, stable across Library/Dialer/Playground. |
| Global search and appearance | One compact chrome band, aligned across surfaces, no full-width search field on phone. |
| Stateful Call/Stop/End | One repeated-action control in the work surface or phone command row; never repeated in every list row. |
| Device call | Adjacent to agent-backed Call on Dialer and Playground, opens `tel:`, and never implies backend call proof. |
| Popovers, menus, sheets, drawers | Use only `--speak-popout-*` tokens, outside-click/Escape dismissal, phone sheets must not clip primary actions. |
| Transcript and chat bubbles | Participant labels from call context, transcript geometry, bottom composer, oldest-to-newest saved history with active attempts last. Sent/outbound agent and operator bubbles use the dark role color in every appearance and keep a visible tokenized border, matching the selection-control edge treatment so their shape remains legible on dark transcript surfaces. Received/contact bubbles use the readback bubble, except contact/user-side SMS which is always iMessage blue in every appearance. Sent/outbound SMS stays on the fixed sent/dark treatment. Email bubbles use the fixed Speak purple channel color in every appearance, show subject-first when collapsed, and expand inline for body copy. Any activity or transcript source-history surface, including Library contact, agent, Activity, Dialer linked source history, and Playground linked source history, uses the shared chat body pattern so labels, copy, reply, long-message collapse actions, fixed sender colors, and optional provider score strips stay consistent with Playground. |
| SMS thread bubbles | In communication-thread views, received SMS bubbles use the iMessage blue treatment (`#007aff` in light, `#0a84ff` in dark/system-dark) with white text. Sent SMS bubbles use the same dark user-message bubble treatment already used for user turns in both light and dark appearances. |
| Email thread bubbles | In communication-thread views, sent and received email bubbles use `--communication-email-bg` with white text in every appearance mode. Email body text is hidden until the operator expands the message. |
| Contact delivery actions | Contact phone fields expose current-device call, current-device SMS, and agent-number SMS where the field is editable. Contact email fields expose workspace-email send. Backend sends must return provider proof and write the outbound message back into the communication thread. |
| Library records | Dense table/list treatment, bulk actions quiet until selected, context and transcript expansion without duplicating storage. |
| Forms and settings | Compact labels close to controls, tokenized borders/focus, explicit Save when provider-backed sync is required. |
| Empty states | One short state sentence. No tutorials, marketing copy, or implementation detail. |

### Buttons

- Use `src/SpeakIcons.tsx` for app-owned action, route, and status icons:
  phone, play, stop, chat, mic/takeover, filter, settings, save, copy, delete,
  upload, add, check, route, appearance, transcript, Library, Dialer, and
  Playground symbols. `SpeakIcons` wraps professional outline geometry with a
  fixed `1.65` stroke so controls stay recognizable while feeling lighter than
  stock icon chrome. Do not import `lucide-react` directly into app surfaces for
  owned controls.
- Official brand marks stay as their source assets: `SpeakLogoMark`,
  `CodexAppIcon`, Personal Phone/BlueBubbles, and provider/framework logos in docs.
- Icon-only controls require `title` and `aria-label`.
- Icon buttons should usually be 32-34 px on desktop-dense chrome. On phone, primary tap targets should be closer to 40-44 px unless a smaller passive indicator is clearly non-interactive.
- Topbar icon chrome is borderless by default; use hover/active background and fixed hit area rather than outlined mini-containers.
- Primary buttons are for the next high-value action only.
- Destructive actions use danger styling but remain compact.
- Avoid text-only rounded rectangles where a standard icon works better.
- Shared topbar buttons should use the largest stable target that fits the work band: 34-40 px on desktop/tablet and about 40-44 px on phone.

### Grouped Controls

- Use compact grouped controls for related actions.
- Do not nest grouped controls inside another visible bordered group.
- Start/Stop uses one stateful control in the relevant work surface; avoid duplicate topbar copies.
- Page action groups use the shared `topbar-action-group` grammar.
- The current agent is not part of persistent app chrome; keep it in Playground profile/list/settings context or local work-surface state.
- Less frequent actions should move into an overflow menu instead of competing for always-visible topbar space.

### Pills And Chips

- Use pills for runtime state, metrics, unsaved status, and compact tags.
- Keep pills single-purpose and single-line.
- Do not let chips increase row height; summarize with `+N` and keep full detail in `title` when useful.

### Lists

- The dialer primary surface is a business contact list, not a spreadsheet table.
- Business name is the primary row identity; contact name, call metadata, status, pinning, and row actions support it.
- Sorting and filtering belong in compact popovers near search.
- Contact field edits belong in the selected-business detail editor.
- Do not reintroduce horizontal table scrolling for the primary dialer workflow.

### Forms

- Inputs should be compact and aligned.
- Labels should be clear, short, and close to the control.
- Use tokenized borders and focus rings.
- Avoid helper copy unless it prevents a real mistake.

### Empty States

Empty states are short and state-based.

Good:

- `No test transcript yet.`
- `Waiting for spoken turns.`
- `No call transcript has been captured for this contact yet.`

Avoid tutorials, marketing copy, and implementation detail in empty states.

## Layout Rules

- Panels and cards use restrained radius, usually 8 px or less.
- Do not put cards inside cards.
- Main desktop panes should fill useful viewport height and touch adjacent panes unless a real workflow boundary requires separation.
- Use internal scroll regions for long content.
- On phone, document vertical scrolling is acceptable; horizontal overflow is not.
- Phone layouts are allowed to depart from desktop placement when the mobile operator workflow is better served by a different order, larger tap targets, or card-like rows.
- Keep control dimensions stable so labels, hover states, and dynamic values do not shift the layout.
- Do not use blank dividers or page sections that consume space without supporting the workflow.

## Responsive Standards

Verify at least:

- Desktop: `1440 x 900`.
- Tablet/small browser: around `768 x 814` when topbar or layout changes.
- Phone: `390 x 844`.

Expected:

- No document-level horizontal overflow.
- Topbar remains compact but uses finger-sized controls.
- Phone action labels collapse before layout breaks.
- Contact queue remains usable before transcript on phone; a phone-specific row/card layout is preferred over forcing desktop horizontal table scanning.
- Playground may scroll vertically on phone, but prompt/test work should appear before secondary Speak settings.
- Transcript and Playground test panels match width/height when expanded.

## Accessibility

- All icon-only controls need `title` and `aria-label`.
- Toggle-like controls should expose pressed/expanded state where applicable.
- Dialog/popover controls should expose useful labels.
- Focus rings must remain visible.
- Disabled states must be clear through state and titles, not paragraphs.
- Do not remove text labels if the icon is ambiguous and no accessible label exists.

## Copy Style

- Short, factual, operational.
- Use established terms: contact, call, transcript, agent, profile, config, queue, takeover, next, playback, Speak settings. Keep legacy `lead` only where naming actual API fields, action IDs, or persisted schema keys.
- Model labels must make the route explicit. Use `Hume native` or
  `Inworld native` for provider-owned runtime choices and `Codex auth` for
  Codex-authenticated choices, even when the same OpenAI model family appears
  in both groups.
- Avoid filler such as `AI-powered`.
- Avoid visible text explaining how the UI works.
- Use sober fallbacks such as `Not recorded` when data is missing.

## Anti-Patterns

Do not introduce:

- Landing pages or hero sections.
- Decorative images, gradients, or abstract backgrounds.
- Repeated status blocks already represented in the topbar or panel.
- Oversized buttons for routine actions.
- Hidden fake controls that only look wired.
- Redundant saved-profile sidebars when profile search already handles selection.
- Prompt/config controls on the dialer surface unless needed during live calling.
- Arbitrary new colors, shadows, radii, or typography scales.

## Design Change Protocol

Use this sequence for visual, layout, or component changes:

1. Inspect the current rendered surface before editing.
2. Identify the workflow object and the existing component/token recipe.
3. Change implementation through shared CSS tokens/components first.
4. Update `BRANDING.md` when the design rule, token role, component grammar, or
   responsive expectation changes.
5. Update `server/agent-contract.mjs` when outside agents need the new token,
   component grammar, selector, route, or action mapping.
6. Update `AGENTS.md`, README/docs, and the repo-contained Speak skill when the
   rule affects future agent behavior.
7. Verify with lint/build/diff checks and browser QA for any rendered UI change.

For docs-only design updates, `git diff --check` plus targeted contract syntax
or generated-contract checks are usually enough. For visible UI changes, do not
close without desktop and phone proof.

## UI QA Checklist

Before handoff:

- Follow the `AGENTS.md` Clean Start / Clean End closeout checklist. For UI
  work this includes stopping any local dev server used for visual QA, committing
  intentional changes, and confirming `git status --short` is empty before the
  final response unless the user explicitly asked for an uncommitted end state.
- Inspect current rendered UI first.
- Confirm the changed controls perform real actions or show real state.
- Confirm critical controls keep stable `data-testid` and `data-action-id` values from `src/uiContract.ts`.
- Confirm `/api/agent/capabilities` still maps visible UI actions to backend actions or clear browser-only equivalents.
- Check topbar order and x-position symmetry across Dialer and Playground when shared controls are involved.
- Check search, appearance, route dock/island, and in-surface Start/Stop positions.
- Check transcript/Playground test panel dimensions if either surface changed.
- Check desktop, phone, and tablet when relevant.
- Check text clipping, overlap, and horizontal overflow.
- Check console warnings/errors in browser.
- Run `npm run lint`, `npm run build:speak`, and `git diff --check`.
- Run `SPEAK_QA_BASE_URL=http://127.0.0.1:5173/speak npm run qa:ui-contract` for selector, topbar, shared-control, or layout changes.
- Deploy and verify live URLs when the user expects production.
