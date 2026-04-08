# Pesto Component Guidelines

These rules are mandatory. Every generated page must comply. Violations must be corrected.

---

## General

- Every page must import or inline the full `pesto.css` variables. No hardcoded color, spacing, or typography values — use `var(--pesto-*)` tokens exclusively.
- All text must meet WCAG AA contrast (4.5:1 for body, 3:1 for large text). Use the semantic text tokens to ensure this.
- Every interactive element must have a visible `:focus-visible` outline.

## Layout

- Page sections must be wrapped in a centered container.
- No layout element may exceed the max container width.
- Never use raw pixel or rem values for gaps — use spacing tokens.

## Typography

- Heading hierarchy must be sequential — no skipping levels (e.g. h1 → h3 is a violation).
- Never use font sizes outside the `--pesto-text-*` scale.

## Buttons

- Minimum touch target: 40×40px.

## Cards

- Cards must not nest inside other cards.

## Forms

- Every input must have an associated `<label>`.

## Navigation

- Mobile nav must collapse into a hamburger at the `md` breakpoint or below.

## Images and Media

- All images must have descriptive `alt` text. Decorative images use `alt=""` and `aria-hidden="true"`.
- Images in content sections must be wrapped in a `<figure>` with an optional `<figcaption>`.
- Image aspect ratios must be preserved — use `object-fit: cover` when cropping.

## Responsive

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
