# Elastic Horizon — Brand Reference for Development

## Colors

### Core palette

| Token | Hex | Usage |
|---|---|---|
| `--horizon-red` | `#7A0E13` | Primary CTA, accents, links, active states |
| `--graphite` | `#1A1A1A` | Headlines, body text, table headers |
| `--logo-grey` | `#97989C` | Wordmark color, scrollbar thumbs |
| `--ivory` | `#F5F2EC` | Page backgrounds |
| `--grey` | `#6B6B6B` | Secondary/caption text, scrollbar hover |
| `--dark-maroon` | `#3A0A0D` | Dark UI surfaces (e.g. chat panel), paused badge |
| `--ivory-tint` | `#ECEADE` | Input field backgrounds, alternating table rows, borders |
| `--white` | `#FFFFFF` | Card surfaces, button text on dark backgrounds |

### Accent palette

Warm extensions derived from the brand's "reds, maroons, golds, ivories" spectrum. No blues or greens.

| Token | Hex | Contrast on white | Usage |
|---|---|---|---|
| `--arena-gold` | `#8B6914` | ~5.6:1 AA | Published badge, success/positive states |
| `--arena-amber` | `#A37F1F` | ~4.5:1 AA | Load more, pagination, tertiary exploration actions |
| `--arena-copper` | `#8B5C34` | ~5.3:1 AA | Back/navigation-backward buttons |
| `--arena-wine` | `#5C1118` | ~8.5:1 AA | Destructive actions (Archive, Deactivate) |

All text/background pairings must meet WCAG AA (4.5:1 body, 3:1 large text).

## Typography

### Font stacks

```css
/* Primary — all UI, body, headings */
font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

/* Logo wordmark only */
--font-logo: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

/* Code/data */
--font-mono: "IBM Plex Mono", monospace;

/* Hero/campaign headlines only */
--font-hero: "Space Grotesk", sans-serif;
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
| Buttons | IBM Plex Sans | 500–600 | 14px | — | `letter-spacing: 0.01em; text-transform: none` (sentence case) |
| Column header | IBM Plex Sans | 600 | 11px | 1.4 | `text-transform: uppercase; letter-spacing: 0.07em; color: white` (on graphite bg) |

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

## Geometry and Borders

### Border radius scale

Sharp geometry is the default. Rounded/pill shapes are reserved for specific uses.

| Token | Value | Usage |
|---|---|---|
| `rounded` (default) | 2px | Cards, modals, inputs, badges |
| `rounded-md` | 4px | All buttons (primary, secondary, copper, amber, wine) |
| `rounded-lg` | 6px | Interactive card hover state |
| `rounded-pill` | 999px | Small inline badges only (Required/Optional labels, count indicators). Never for buttons. |

### Border-driven hierarchy

- Use `1px solid` borders (`border-ivory-tint`) instead of box-shadows for card/container edges.
- Use `2px` horizon-red accent lines (`border-l-2 border-l-horizon-red`) for active/emphasis states (e.g. active nav item).
- No soft shadows anywhere in the admin UI. The only exception is that table containers may use borders for separation from the page.

### Hover interactions

- Interactive cards: `rounded` → `rounded-lg` on hover (`transition-[border-radius] duration-200`)
- All buttons: `active:scale-[0.98]` on click
- Table rows: `hover:bg-horizon-red/[0.03]` with `transition-colors duration-100`

## Key Components

### Buttons

All buttons use `rounded-md` (4px). No pill-shaped buttons.

| Class | Background | Text | Border | Usage |
|---|---|---|---|---|
| `btn-primary` | `--horizon-red` | white | none | Primary CTA: Save, Next, Publish, Submit |
| `btn-secondary` | white | `--graphite` | `--grey` | Cancel, Edit, general secondary actions |
| `btn-copper` | `--arena-copper` | white | none | Back, navigation-backward |
| `btn-amber` | transparent | `--arena-amber` | `--arena-amber` | Load more, pagination (outline style) |
| `btn-wine` | transparent | `--arena-wine` | `--arena-wine` | Archive, Deactivate, destructive (outline style) |
| `btn-ghost` | transparent | `--grey` | none | Subtle links, sign out, dismiss |

### Status badges

Brand-only palette — no Tailwind pastels (no blue, green, yellow, pink).

| Class | Background | Text | Maps to |
|---|---|---|---|
| `badge-active` | `--horizon-red` | white | `in_progress`, `active` |
| `badge-published` | `--arena-gold` | white | `published` |
| `badge-completed` | `--graphite` | white | `completed`, `granted` |
| `badge-draft` | `--ivory-tint` | `--graphite` | `draft`, `scheduled` |
| `badge-paused` | `--dark-maroon` | `--ivory` | `paused` |
| `badge-archived` | none | `--grey` | `archived`, `abandoned`, `inactive`, `denied` |

### Data tables

Tables are the primary data presentation pattern in the admin UI. All tables follow this structure:

- **Container:** `bg-white rounded border border-ivory-tint overflow-hidden`
- **Header row:** `bg-graphite` with white uppercase column text (`.col-header` class). Creates strong visual separation from the ivory page background.
- **Data rows:** Alternating `bg-white` / `bg-ivory-tint`. Never use `bg-ivory` for row striping (it matches the page background and confuses the eye).
- **Row hover:** `hover:bg-horizon-red/[0.03]` with `transition-colors duration-100` on all data rows.
- **Row borders:** `border-b border-ivory-tint` between rows, omitted on last row.
- **Sortable columns:** Active sort indicator uses `text-arena-gold` on the graphite header.

Visual stack (back to front): ivory page → white table card with border → dark graphite header → white/ivory-tint alternating rows.

### Navigation (admin sidebar)

- Fixed left sidebar, `bg-white`, `border-r border-ivory-tint`
- Active nav item: `border-l-2 border-l-horizon-red bg-horizon-red/[0.06] text-horizon-red`
- Inactive nav item: `border-l-2 border-l-transparent text-grey`
- Hover: `hover:text-graphite hover:bg-graphite/[0.02] hover:rounded-lg`
- All JS `onMouseEnter`/`onMouseLeave` handlers replaced with Tailwind `hover:` variants

### Inputs

- `bg-ivory-tint` background, `border-grey` border
- Focus: `border-horizon-red`
- Dropdowns (select fields): same styling as text inputs

### Cards

- Static: `bg-white rounded border border-ivory-tint p-6`
- Interactive: adds `hover:rounded-lg active:scale-[0.98]`

### Modals

- Backdrop: `rgba(26, 26, 26, 0.5)` (graphite at 50%)
- Panel: `bg-white rounded p-8 border border-ivory-tint max-w-lg`

### Alerts

- Error: `border-horizon-red/30 bg-horizon-red/5 text-horizon-red`
- Warning: `border-grey/30 bg-ivory-tint text-graphite`

### Scrollbars

Branded globally across all scrollable elements:
- **Track:** `--ivory-tint` background
- **Thumb:** `--logo-grey` (#97989C), 6px wide, 3px border-radius
- **Thumb hover:** `--grey` (#6B6B6B)
- Firefox: `scrollbar-width: thin; scrollbar-color: var(--grey) var(--ivory-tint)`

### Chat widget
- Panel: `background: --dark-maroon`
- Text: `--ivory` / `--white`
- Input: `background: --ivory-tint`, placeholder in `--grey`
- Suggested prompts: pill chips, ivory text on dark background

## Imagery

- Hero illustration: generative/parametric wave mesh in reds, maroons, golds, ivories.
- Must stay within brand palette — no blues/greens.
- Visual weight in lower portion; never obscure headline text.

## Implementation notes

### Tailwind CSS

All styling uses Tailwind utility classes. No inline React `style={{}}` objects. Configuration in `frontend/tailwind.config.ts`.

- Colors reference CSS custom properties via RGB channels for opacity modifier support (e.g. `--c-horizon-red: 122 14 19` → `rgb(var(--c-horizon-red) / <alpha-value>)`)
- Reusable component classes defined in `frontend/src/styles/globals.css` using `@layer components`
- Conditional classes merged with `cn()` utility (clsx + tailwind-merge) from `frontend/src/lib/utils.ts`
- Shared `<StatusBadge>` component at `frontend/src/components/ui/StatusBadge.tsx` maps all status strings to the 6 badge variants above

### Anti-patterns to avoid

- No soft box-shadows (use borders for hierarchy)
- No pastel Tailwind colors (blue, green, yellow, pink) for badges or states
- No pill-shaped buttons (use `rounded-md` for all buttons)
- No `bg-ivory` for table row striping (use `bg-ivory-tint`)
- No JS hover handlers (`onMouseEnter`/`onMouseLeave`) — use Tailwind `hover:` variants
- No inline `style={{}}` objects — use Tailwind classes
- No `borderRadius: 8` or `borderRadius: 12` on cards/containers (default is 2px)

## Brand tone through design

Disciplined. Modern. Structured. Technically sophisticated. No decorative fonts, no excessive weights, no off-brand colors.