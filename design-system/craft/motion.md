# Motion Design

## Duration Guidelines
| Duration | Use Case |
|---|---|
| 100-150ms | Instant feedback: button press, toggle, color change |
| 200-300ms | State changes: menu open, tooltip, hover states |
| 300-500ms | Layout changes: accordion, modal, drawer |
| 500-800ms | Entrance animations: page load, hero reveals |

Exit animations should be ~75% of entrance duration.

## Easing Curves
Never use default `ease` — it's a compromise. Use exponential curves for natural deceleration:
- ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1) — smooth, refined (recommended default)
- ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1) — snappy, confident

For on-interact motion, use the Pesto interaction curve: var(--pesto-ease-interact) at 300ms.
For general transitions, use var(--pesto-duration-normal) with var(--pesto-ease-out).

Never use bounce or elastic easing — they feel dated and tacky. Real objects decelerate smoothly.

## What to Animate
ONLY animate transform and opacity — everything else causes layout recalculation.
For height animations, use grid-template-rows: 0fr to 1fr instead of animating height.

## Interaction Motion
- Buttons: translate up 1-2px on hover, subtle scale on press
- Cards: lift with increased shadow on hover (shadow-sm to shadow-md)
- Links: color transition on hover
- All interactive elements should respond visually to interaction

## Entrance Animations
- Page-load: fade-in + translateY(8px to 0) over 400ms
- Staggered reveals: 50-75ms per item, cap total stagger at ~500ms
- Use CSS custom properties for stagger: animation-delay: calc(var(--i, 0) * 60ms)

## Reduced Motion
Respect prefers-reduced-motion. Replace spatial animations with crossfade alternatives.
Preserve functional animations (progress bars, spinners) — just remove spatial movement.

## Perceived Performance
- Under 80ms feels instant (our brains buffer ~80ms of input)
- Show content progressively — don't wait for everything
- Skeleton screens > spinners (preview content shape)
- Optimistic UI: update immediately for low-stakes actions, handle failures gracefully
