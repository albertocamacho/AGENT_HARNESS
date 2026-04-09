# Color & Contrast

## Palette Strategy
A dominant color with sharp accents outperforms timid, evenly-distributed palettes.

### The 60-30-10 Rule
This is about visual weight, not pixel count:
- 60%: neutral backgrounds, white space, base surfaces
- 30%: secondary colors — text, borders, inactive states
- 10%: accent — CTAs, highlights, focus states
The accent color works BECAUSE it's rare. Overuse kills its power.

### Tinted Neutrals
Pure gray has no personality. The Pesto neutral scale already has warmth baked in — use it. Neutral surfaces should feel cohesive with the brand color, not sterile.

## Contrast Requirements
| Content Type | AA Minimum |
|---|---|
| Body text | 4.5:1 |
| Large text (18px+ or 14px bold) | 3:1 |
| UI components, icons | 3:1 |
| Placeholder text | 4.5:1 (yes, really) |

## Dangerous Combinations
- Light gray text on white — the #1 accessibility fail
- Gray text on any colored background — gray looks washed out on color; use a darker shade of the background color instead
- Red on green (8% of men can't distinguish)
- Blue on red (vibrates visually)
- Yellow on white (almost always fails)
- Thin light text on images (unpredictable contrast)

## Color Usage
- Brand color in exactly 2-3 places per viewport — no more
- Body text: always primary text color (--pesto-text-primary)
- Secondary text for supporting information only
- Status colors (success, error, warning) used contextually, never decoratively
- Dark sections: use neutral-800/900 with inverse text for contrast blocks

## Dark Mode (if applicable)
Dark mode is NOT inverted light mode:
- Use lighter surfaces for depth (no shadows on dark)
- Desaturate accents slightly
- Reduce font weight
- Never use pure black — use dark gray (12-18% lightness)
