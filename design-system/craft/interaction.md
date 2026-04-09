# Interaction Design

## The Eight States
Every interactive element must account for these states:
1. **Default** — base styling
2. **Hover** — subtle lift, color shift (pointer only, not touch)
3. **Focus** — visible ring via :focus-visible (keyboard users need this)
4. **Active** — pressed in, darker
5. **Disabled** — reduced opacity, no pointer events
6. **Loading** — spinner or skeleton
7. **Error** — red border, icon, message
8. **Success** — green check, confirmation

The common miss: designing hover without focus. Keyboard users never see hover states.

## Focus Rings
Never outline: none without replacement — it's an accessibility violation.
Use :focus-visible to show focus only for keyboard users:
- High contrast (3:1 minimum against adjacent colors)
- 2-3px thick
- Offset from element (outline-offset: 2px)
- Consistent across all interactive elements

## Forms
- Always use visible <label> elements — placeholders disappear on input
- Validate on blur, not on every keystroke (exception: password strength)
- Place errors below fields with aria-describedby connecting them
- Every input must have an associated label

## Progressive Disclosure
Start simple, reveal sophistication through interaction:
- Basic options first, advanced behind expandable sections
- Hover states that reveal secondary actions
- Don't front-load complexity

## Button Hierarchy
Not every button should be primary. Use a mix:
- Primary: one per section, the main action
- Secondary: supporting actions
- Ghost/text: tertiary, low-emphasis actions
Visual hierarchy in buttons guides users to the right action.

## Loading Patterns
- Skeleton screens over spinners — they preview content shape
- Optimistic updates for low-stakes actions (likes, toggles)
- Show specific progress text: "Saving your draft..." not "Loading..."
- For long waits, set expectations: "This usually takes 30 seconds"

## Empty States
Empty states are onboarding moments:
1. Acknowledge briefly
2. Explain the value of filling it
3. Provide a clear action
"No projects yet. Create your first one to get started." — not just "No items."
