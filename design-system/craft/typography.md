# Typography

## Hierarchy Through Contrast
Use fewer sizes with more contrast. A 5-size system covers most needs:
- xs (0.75rem): captions, legal
- sm (0.875rem): secondary UI, metadata
- base (1rem): body text
- lg (1.25-1.5rem): subheadings, lead text
- xl+ (2-4rem): headlines, hero text

The common mistake: too many font sizes too close together (14px, 15px, 16px, 18px). This creates muddy hierarchy. Use the --pesto-text-* scale — it's designed with proper contrast ratios.

## Hierarchy Through Multiple Dimensions
Don't rely on size alone. The best hierarchy uses 2-3 dimensions at once:
- A heading that's larger AND bolder AND has more space above it
- Weight contrast: bold vs regular (not medium vs regular — too subtle)
- Color contrast: primary text for headings, secondary/tertiary for supporting text
- Position: top-left reads first in western layouts

## Readability
- Body text: max-width of 60-65ch for comfortable reading
- Line-height scales inversely with line length — narrow columns need tighter leading
- On dark backgrounds, increase line-height by 0.05-0.1 (perceived weight is lighter)
- Minimum 16px body text — smaller strains eyes on mobile

## Vertical Rhythm
Line-height is the base unit for vertical spacing. If body text has line-height: 1.5 on 16px (= 24px), spacing values should be multiples of 24px. This creates subconscious harmony.

## Font Pairing
You often don't need a second font. One well-chosen family in multiple weights creates cleaner hierarchy than two competing typefaces. Only add a second font for genuine contrast (display headlines + body serif).

When pairing, contrast on multiple axes:
- Serif + Sans (structure contrast)
- Geometric + Humanist (personality contrast)
- Never pair fonts that are similar but not identical — they create tension without hierarchy

## OpenType Features
Use these for polish:
- font-variant-numeric: tabular-nums — for data tables, metrics, prices
- font-variant-numeric: diagonal-fractions — for recipe-style amounts
- font-variant-caps: all-small-caps — for abbreviations
- font-kerning: normal — explicit kerning
