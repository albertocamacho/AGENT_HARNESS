# Spatial Design

## Spacing Rhythm
Not all spacing should be equal. Vary spacing intentionally:
- Tight groupings for related content (--pesto-space-2, --pesto-space-3)
- Generous separations between sections (--pesto-space-12, --pesto-space-16)
- Proximity equals meaning: elements close together are perceived as related

Use the Pesto spacing scale — don't invent values. The scale is 4pt-based for granularity: 4, 8, 12, 16, 24, 32, 48, 64, 96px.

## The Squint Test
Blur your eyes. Can you still identify:
- The most important element?
- The second most important?
- Clear groupings?
If everything looks the same weight blurred, you have a hierarchy problem.

## Layout Composition
- Asymmetry over symmetry: 60/40 or 2/3-1/3 splits feel more designed than 50/50
- Generous hero sections: 60-70vh for impact
- 3-column grids for features, 2-column for content+sidebar, single column for text-heavy
- Break the grid intentionally for emphasis — one element spanning wider draws the eye
- Use gap instead of margins for sibling spacing — eliminates margin collapse

## Cards: Use Sparingly
Cards are overused. Use them only when:
- Content is truly distinct and actionable
- Items need visual comparison in a grid
- Content needs clear interaction boundaries

Never nest cards inside cards. Use spacing, typography, and subtle dividers for hierarchy within a card.

## Container Width
Use a centered container pattern: width: var(--pesto-content-width); margin-inline: auto. No content element should exceed the max container width.

## Optical Adjustments
- Text at margin-left: 0 looks indented due to letterform whitespace — use slight negative margin to optically align
- Geometrically centered icons look off-center — play icons shift right, arrows shift toward their direction
- Touch targets: 44px minimum tap area, even if the visual element is smaller (use padding or pseudo-elements)

## Depth and Elevation
- Shadows should be subtle — if you can clearly see it, it's probably too strong
- Create consistent elevation: cards at shadow-sm, hover at shadow-md, modals at shadow-lg
- Semantic z-index: dropdown → sticky → modal-backdrop → modal → toast → tooltip
