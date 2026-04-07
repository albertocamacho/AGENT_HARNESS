# Pesto Component Rules

These rules are mandatory. Every generated page must comply. Violations must be corrected.

---

## General

- Every page must import or inline the full `pesto.css` variables. No hardcoded color, spacing, or typography values — use `var(--pesto-*)` tokens exclusively.
- The `<body>` must set `font-family: var(--pesto-font-sans)` and `color: var(--pesto-text-primary)` and `background: var(--pesto-surface-page)`.
- All text must meet WCAG AA contrast (4.5:1 for body, 3:1 for large text). Use the semantic text tokens to ensure this.
- Every interactive element must have a visible `:focus-visible` outline using `--pesto-border-focus`.

## Layout

- Page sections must be wrapped in a centered container: `width: var(--pesto-content-width); margin-inline: auto`.
- Vertical section spacing uses `--pesto-space-16` or `--pesto-space-20`. Never less than `--pesto-space-12`.
- Grid gaps use `--pesto-space-6` or `--pesto-space-8`. Never use raw pixel or rem values for gaps.
- No layout element may exceed `--pesto-container-xl` in width.

## Typography

- Heading hierarchy must be sequential — no skipping levels (e.g. h1 → h3 is a violation).
- h1: `--pesto-text-4xl` or `--pesto-text-5xl`, weight `--pesto-weight-bold`.
- h2: `--pesto-text-2xl` or `--pesto-text-3xl`, weight `--pesto-weight-semibold`.
- h3: `--pesto-text-xl`, weight `--pesto-weight-semibold`.
- h4 and below: `--pesto-text-lg`, weight `--pesto-weight-medium`.
- Body text: `--pesto-text-base`, line-height `--pesto-leading-normal`.
- Small / caption text: `--pesto-text-sm`, color `--pesto-text-secondary`.
- Never use font sizes outside the `--pesto-text-*` scale.
- Maximum line width for body text: 65ch.

## Buttons

- Primary button: `background: var(--pesto-brand-600)`, `color: var(--pesto-text-inverse)`, `border-radius: var(--pesto-radius-md)`, padding `var(--pesto-space-3) var(--pesto-space-6)`.
- Primary hover: `background: var(--pesto-brand-700)`.
- Secondary button: `background: transparent`, `border: 1px solid var(--pesto-border-default)`, `color: var(--pesto-text-primary)`.
- Secondary hover: `background: var(--pesto-surface-sunken)`.
- Ghost button: no border, no background. `color: var(--pesto-text-link)`. Hover: underline.
- All buttons: `font-weight: var(--pesto-weight-medium)`, `font-size: var(--pesto-text-sm)`, `transition: all var(--pesto-duration-normal) var(--pesto-ease-default)`.
- Disabled buttons: `opacity: 0.5`, `cursor: not-allowed`.
- Minimum touch target: 44×44px.

## Cards

- Background: `var(--pesto-surface-raised)`.
- Border: `1px solid var(--pesto-border-default)`.
- Border radius: `var(--pesto-radius-lg)`.
- Padding: `var(--pesto-space-6)`.
- Shadow: `var(--pesto-shadow-sm)`. On hover (if interactive): `var(--pesto-shadow-md)`.
- Cards must not nest inside other cards.

## Forms

- Input fields: `border: 1px solid var(--pesto-border-default)`, `border-radius: var(--pesto-radius-md)`, padding `var(--pesto-space-3) var(--pesto-space-4)`.
- Focus state: `border-color: var(--pesto-border-focus)`, `outline: 2px solid var(--pesto-brand-200)`, `outline-offset: 1px`.
- Error state: `border-color: var(--pesto-error-500)`, helper text in `color: var(--pesto-error-700)`.
- Labels: `font-size: var(--pesto-text-sm)`, `font-weight: var(--pesto-weight-medium)`, `color: var(--pesto-text-primary)`. Placed above the input with `margin-bottom: var(--pesto-space-2)`.
- Every input must have an associated `<label>`.

## Navigation

- Nav links: `color: var(--pesto-text-secondary)`. Active/current: `color: var(--pesto-text-primary)`, `font-weight: var(--pesto-weight-medium)`.
- Nav link hover: `color: var(--pesto-text-primary)`.
- Mobile nav must collapse into a hamburger at `--pesto-container-md` or below.
- Sticky navs use `z-index: var(--pesto-z-sticky)` and `background: var(--pesto-surface-page)`.

## Images and Media

- All images must have descriptive `alt` text. Decorative images use `alt=""` and `aria-hidden="true"`.
- Images in content sections must be wrapped in a `<figure>` with an optional `<figcaption>`.
- Image aspect ratios must be preserved — use `object-fit: cover` when cropping.
- Border radius on media: `var(--pesto-radius-md)` or `var(--pesto-radius-lg)`.

## Badges and Tags

- Background: brand `--pesto-brand-100`, text `--pesto-brand-800`. Or use any semantic color pair (e.g. `--pesto-error-50` / `--pesto-error-700`).
- Padding: `var(--pesto-space-1) var(--pesto-space-3)`.
- Border radius: `var(--pesto-radius-full)`.
- Font size: `var(--pesto-text-xs)`, weight `var(--pesto-weight-medium)`.

## Dividers and Separators

- Use `<hr>` or `border-top: 1px solid var(--pesto-border-default)`.
- Vertical spacing around dividers: `var(--pesto-space-8)` minimum.

## Responsive

- Breakpoints: `640px` (sm), `768px` (md), `1024px` (lg), `1280px` (xl).
- Mobile-first — base styles are mobile, then layer up with `min-width` media queries.
- Touch targets must be at least 44×44px on mobile.
- Font sizes must not go below `--pesto-text-sm` on any viewport.

## Forbidden Patterns

- No inline styles in HTML (all styling via CSS rules and custom properties).
- No `!important` declarations.
- No hardcoded hex colors, pixel font sizes, or raw spacing values.
- No CSS frameworks (Tailwind classes, Bootstrap, etc.).
- No `<br>` tags for spacing — use margin/padding.
- No pixel-based media queries that don't match the defined breakpoints.
- No `<div>` soup — use semantic elements (`<section>`, `<article>`, `<aside>`, `<nav>`, etc.).
