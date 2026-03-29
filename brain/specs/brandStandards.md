# Elastic Horizon — Brand Reference for Development

## Colors

| Token | Hex | Usage |
|---|---|---|
| `--horizon-red` | `#7A0E13` | Primary CTA, accents, links, active states |
| `--graphite` | `#1A1A1A` | Headlines, body text |
| `--logo-grey` | `#97989C` | Wordmark color |
| `--ivory` | `#F5F2EC` | Page backgrounds, card surfaces |
| `--grey` | `#6B6B6B` | Secondary/caption text |
| `--dark-maroon` | `#3A0A0D` | Dark UI surfaces (e.g. chat panel) |
| `--ivory-tint` | `#ECEADE` | Input field backgrounds |
| `--white` | `#FFFFFF` | Button text on red/dark backgrounds |

All text/background pairings must meet WCAG AA (4.5:1 body, 3:1 large text).

## Typography

### Font stacks

```css
/* Primary — all UI, body, headings */
font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

/* Logo wordmark only */
--font-logo: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

### Hierarchy

| Element | Font | Weight | Size | Line Height | Extras |
|---|---|---|---|---|---|
| Logo wordmark | IBM Plex Sans | 100 | 22px | — | `letter-spacing: -0.06em; color: var(--logo-grey); text-transform: lowercase; user-select: none` |
| H1 (hero only) | Space Grotesk | 700 | — | 1.05–1.1 | `letter-spacing: -0.015em` |
| H2 | IBM Plex Sans | 600 | — | — | — |
| H3 | IBM Plex Sans | 500 | — | — | — |
| Body | IBM Plex Sans | 400 | 16–18px | 1.5–1.6 | `letter-spacing: 0` |
| Subheadline | IBM Plex Sans | 400 | 18–20px | 1.55 | `opacity: 0.85–0.9; max-width: 520px` |
| Caption | IBM Plex Sans | 300 | — | — | — |
| Code/data | IBM Plex Mono | 400 | 14–16px | 1.5 | — |
| Nav | IBM Plex Sans | 500 | 14px | — | `letter-spacing: 0.04em; text-transform: uppercase` |
| Buttons | IBM Plex Sans | 500–600 | — | — | `letter-spacing: 0.03em; text-transform: none` (sentence case) |

**Space Grotesk is only for hero/campaign headlines. Never use it for UI, nav, or body.**

## Logo

- **Format:** Wordmark only — `elastichorizon` (all lowercase, one word, no icon).
- **Rendering:**
  - `font-family: var(--font-logo)` (IBM Plex Sans)
  - `font-weight: 100`
  - `font-size: 22px`
  - `letter-spacing: -0.06em`
  - `color: var(--logo-grey)` (`#97989C`)
  - `text-transform: lowercase`
  - `user-select: none`
- **Placement:** Top-left, with clear space ≥ cap-height of "h" on all sides.
- **Never:** add icons, capitalize, hyphenate, add spaces, distort, or apply effects.

## Key Components

### Buttons (CTA)
- Pill/capsule shape (`border-radius: 999px`)
- Primary: `background: --horizon-red; color: --white`
- Text: IBM Plex Sans 500–600, sentence case

### Navigation bar
- Horizontal, uppercase, 14px, weight 500, `letter-spacing: 0.04em`
- Items: FEATURES · SOLUTIONS · PRICING · ABOUT · RESOURCES
- Login button (pill, red) + hamburger icon right-aligned

### Footer
- Same nav typography, left-aligned
- Copyright right-aligned: `© Copyright ELASTICHorizon`

### Chat widget
- Panel: `background: --dark-maroon`
- Text: `--ivory` / `--white`
- Input: `background: --ivory-tint`, placeholder in `--grey`
- Suggested prompts: pill chips, ivory text on dark background

## Imagery

- Hero illustration: generative/parametric wave mesh in reds, maroons, golds, ivories.
- Must stay within brand palette — no blues/greens.
- Visual weight in lower portion; never obscure headline text.

## Brand tone through design

Disciplined. Modern. Structured. Technically sophisticated. No decorative fonts, no excessive weights, no off-brand colors.