---
version: alpha
name: MiroShark
description: A graph-native prediction-market operator terminal whose identity fuses blue-command brutalism, financial telemetry density, and swarm-intelligence theater. The base canvas is white and gridded; Operator Blue (`#0000ff`) is the single voltage rail, used for headers, command tags, active states, and data emphasis. Typography pairs JetBrains Mono for operational truth with Space Grotesk for titles and human-readable hierarchy. Every surface should feel like one console: setup, terminal, Storybook, and any future control plane.

colors:
  operator-blue: "#0000ff"
  operator-blue-soft: "#eef1ff"
  operator-blue-softer: "#f6f7ff"
  ink: "#050505"
  ink-soft: "#1b1f2b"
  graphite: "#8f8f98"
  graphite-strong: "#5a5f70"
  mist: "#cfcfd7"
  paper: "#ffffff"
  paper-soft: "#f3f3f7"
  gridline: "rgba(0, 0, 255, 0.025)"
  success: "#067a1f"
  success-soft: "rgba(6, 122, 31, 0.08)"
  danger: "#c8102e"
  danger-soft: "rgba(200, 16, 46, 0.08)"
  warning: "#b56a00"
  warning-soft: "rgba(181, 106, 0, 0.10)"
  on-blue: "#ffffff"

typography:
  display-xl:
    fontFamily: "'Space Grotesk', 'JetBrains Mono', sans-serif"
    fontSize: 56px
    fontWeight: 700
    lineHeight: 0.96
    letterSpacing: -0.05em
  display-lg:
    fontFamily: "'Space Grotesk', sans-serif"
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: -0.04em
  title-lg:
    fontFamily: "'Space Grotesk', sans-serif"
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: -0.03em
  title-md:
    fontFamily: "'Space Grotesk', sans-serif"
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: -0.02em
  body-md:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  body-sm:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: 10px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0.16em
  metric:
    fontFamily: "'Space Grotesk', sans-serif"
    fontSize: 32px
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: -0.05em
  code:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: 10.5px
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: 0
  button:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0.08em

rounded:
  none: 0px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 10px
  base: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 72px

motion:
  press:
    duration: 120ms
    easing: "cubic-bezier(0.23, 1, 0.32, 1)"
  hover:
    duration: 160ms
    easing: "cubic-bezier(0.23, 1, 0.32, 1)"
  reveal:
    duration: 220ms
    easing: "cubic-bezier(0.23, 1, 0.32, 1)"
  ticker:
    duration: 46s
    easing: linear

components:
  terminal-header:
    backgroundColor: "{colors.operator-blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.label}"
    height: 28px
  status-pill:
    backgroundColor: transparent
    textColor: "{colors.on-blue}"
    typography: "{typography.label}"
    padding: 4px 8px
  rail-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.operator-blue}"
    padding: "0 12px 12px"
  stage-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.operator-blue}"
    padding: "0 12px 12px"
  setup-step-link:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.mist}"
    padding: 10px
  button-primary:
    backgroundColor: "{colors.operator-blue}"
    textColor: "{colors.on-blue}"
    typography: "{typography.button}"
    border: "1px solid {colors.operator-blue}"
    height: 32px
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.operator-blue}"
    typography: "{typography.button}"
    border: "1px solid {colors.operator-blue}"
    height: 32px
  field-input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.operator-blue}"
    typography: "{typography.body-sm}"
    border: "1px solid {colors.operator-blue}"
    height: 32px
  ticker-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.operator-blue}"
    typography: "{typography.label}"
  metric-row:
    backgroundColor: transparent
    textColor: "{colors.graphite}"
    border: "1px dotted {colors.mist}"

---

# MiroShark Design System

This file is the source of truth for MiroShark's operator-terminal design direction. It applies to the authenticated app, setup routes, Storybook, and the shared `@miroshark/ui` package.

## Implementation References

- Shared design contract: `packages/ui/src/brand/miroshark-brand.js`
- Shared UI stylesheet: `packages/ui/src/globals.css`
- Shared UI primitives: `packages/ui/src/components/*`
- Shared Unicorn scene backdrop: `packages/ui/src/components/unicorn-scene.jsx`
- Storybook brand book: `packages/ui/src/stories/brand-book.stories.jsx`
- Storybook terminal specimens: `packages/ui/src/stories/terminal-primitives.stories.jsx`
- Storybook setup specimen: `packages/ui/src/stories/setup-route.stories.jsx`
- Storybook backdrop specimen: `packages/ui/src/stories/unicorn-scene.stories.jsx`
- Storybook app wiring: `apps/storybook/.storybook/*`
- Marketing landing: `apps/web/app/page.jsx`
- Live terminal shell: `apps/app/components/miroshark/operator-terminal.jsx`
- Live setup routes: `apps/app/components/setup/setup-page-client.jsx`

## Overview

MiroShark is a prediction-market hedge-fund console, not a startup dashboard and not a consumer wallet. The UI should feel like a human operator stepped into a live command deck where capital, swarm judgment, and execution telemetry all converge in one surface.

The design is built from three commitments:

- **blue-command brutalism** — hard borders, white paper, electric blue rails, no decorative softness
- **financial density** — real facts win over ornamental chrome
- **swarm theater** — the product should feel alive, with feeds, tapes, graph motion, and operator context always visible

The setup flow is part of the same product. It must never read like a pastel onboarding SaaS detour.

The public landing is part of the same product too. It is allowed to be more cinematic, but it must still feel like the prelude to the operator console, not a separate startup site.

## Brand Personality

**Decisive** — the system should feel like it expects to act.
**Cold-blooded** — this is about returns, not lifestyle uplift.
**Technical** — graph-native, agentic, and operational.
**Legible** — even when dense, the interface must stay scannable.
**Theatrical in the right places** — tickers, graph reveals, and key metrics can carry motion, but never at the cost of speed.

## Core Visual Principles

### 1. One Product, One Console

The operator terminal is the canonical surface.

- Setup uses the same shell as trading.
- Wallet provisioning uses the same shell as graph review.
- Storybook should render the same primitives the app ships.

### 2. Hard Structure, Not Soft SaaS

- Panels are defined by blue rules, not floating glass cards.
- White space does hierarchy work before shadows do.
- Colored surfaces are reserved for command rails, active states, and data emphasis.

### 3. Density With Discipline

- Use small mono labels and larger sans metrics.
- Group facts in scannable rows.
- Keep one dominant action per card.

### 4. Motion Must Serve the Desk

Motion exists for:

- page-load orientation
- graph rehearsal energy
- tickers and rails
- operator feedback
- active-state transitions

Motion does not exist for:

- repeated keyboard actions
- modal choreography for its own sake
- slow command-palette interactions

## Colors

### Primary Rail

- **Operator Blue** (`{colors.operator-blue}`) is the only hard brand rail.
- It owns headers, chips, active buttons, panel borders, and important numbers.
- Do not dilute it with gradient variants or multiple accent blues.

### Neutrals

- **Paper** (`{colors.paper}`) is the default surface.
- **Paper Soft** (`{colors.paper-soft}`) supports subtle contrast bands.
- **Ink** (`{colors.ink}`) is the strongest text.
- **Graphite** (`{colors.graphite}`) is support text.
- **Mist** (`{colors.mist}`) is hairline rhythm only.

### State Colors

- **Success** (`{colors.success}`) means realized gain, ready status, or confirmed path.
- **Danger** (`{colors.danger}`) means failed or blocked.
- **Warning** (`{colors.warning}`) means caution, not catastrophe.

State colors should appear mostly as text or subtle tints, not giant fill blocks.

## Typography

The type system is intentionally split:

- **JetBrains Mono** for labels, controls, code, row facts, and operator instructions
- **Space Grotesk** for titles, metrics, and moments that need human hierarchy

Rules:

- Labels are uppercase mono with generous tracking.
- Metrics use large sans numerals or compact sans values.
- Long descriptive copy stays short; this is a terminal, not a brochure.

## Layout

### Shell

- Header rail at the top
- left rail for context, state, and progress
- right stage for the one live decision surface

### Cards

- `rail-card` for support context
- `stage-card` for the main live work area
- `card-head` always carries the control identity
- `card-title` always states the job to be done

### Setup

Setup always follows this structure:

1. command header
2. route progress rail
3. operator context rail
4. one live ceremony card

No multi-card onboarding dashboards.

## Shapes

- Default panel geometry is near-square with modest radii.
- Buttons are rectangular, not pill-happy.
- Use circles only for status dots or tiny markers.

This is not Coinbase and not Apple. Avoid over-rounding.

## Motion

The motion language should feel like market infrastructure, not app candy.

### Approved Motion

- horizontal ticker drift
- graph-node rehearsal energy
- small reveal of setup or state cards
- button press compression
- active-state wash on hover/focus

### Motion Rules

- Press feedback: 100–120ms
- Hover/selection: 140–180ms
- Card/stage reveal: 180–220ms
- Continuous tickers: linear and calm

### Motion Bans

- scaling from zero
- heavy spring bounce on operator controls
- delayed keyboard action responses
- decorative looping animations inside dense data cards

## Components

### Terminal Header

Blue strip. Small, compact, always on. Carries product mark, surface identity, and live status.

### Rail Card

Support context only. It should help the operator decide faster, not compete for attention.

### Stage Card

The live work zone. One stage card should dominate the route.

### Status Pill

Tiny, uppercase, blue-first. Never bulky.

### Setup Step Link

Compact row, not a glossy onboarding card. It should feel like a route in a control panel.

### Treasury Ceremony Panel

This is a custody ritual, not a settings screen. It must feel serious, explicit, and sequential.

## Do

- Do keep setup visually identical to the terminal family.
- Do reserve blue for structure and active emphasis.
- Do let the graph feel alive.
- Do make Storybook mirror the same CSS variables and primitives the app uses.
- Do keep design tokens in `@miroshark/ui` and reference them from stories.

## Don’t

- Don’t introduce purple, neon cyan, or startup gradients.
- Don’t switch setup into consumer-SaaS card language.
- Don’t over-round controls.
- Don’t animate command surfaces that users hit constantly.
- Don’t fork the design system in app code when a shared primitive should exist.

## Storybook Sync Rules

If a design decision affects:

- colors
- typography
- spacing
- shared shell primitives
- setup route primitives
- terminal card primitives

then it must update all three:

1. `DESIGN.md`
2. `packages/ui`
3. `apps/storybook`

That is the discipline that keeps MiroShark visually coherent as the product expands.
