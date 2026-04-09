# Responsive Design

## Mobile-First
Write base styles for mobile, use min-width queries to layer complexity. Desktop-first means mobile loads unnecessary styles. Use the Pesto breakpoints: 640px, 768px, 1024px, 1280px.

## Content-Driven Breakpoints
Don't blindly apply breakpoints everywhere. Start narrow, stretch until the design breaks, add a breakpoint there. Three breakpoints usually suffice.

Use clamp() for fluid values that scale without breakpoints:
- Fluid spacing: clamp(1rem, 2vw + 0.5rem, 3rem)
- Fluid type for display headings (not body text — body stays fixed rem)

## Layout Adaptation
- Navigation: hamburger + drawer on mobile, horizontal on tablet, full with labels on desktop
- Card grids: single column on mobile, auto-fit with minmax on wider screens
- Tables: transform to card layout on mobile using display: block
- Sidebars: stack below main content on mobile
- Don't hide critical functionality on mobile — adapt the interface, don't amputate it

## Touch Targets
- 44px minimum tap area on all interactive elements
- Adequate spacing between touch targets to prevent mis-taps
- Use @media (pointer: coarse) to detect touch devices and increase padding
- Don't rely on hover for functionality — touch users can't hover

## Responsive Typography
- Use rem for font sizes (respects user browser settings)
- Minimum 16px body text on any viewport (--pesto-text-sm minimum)
- Fluid type via clamp() for marketing/display headings
- Fixed rem scales for app UIs and data-dense interfaces

## Images
- Use object-fit: cover to preserve aspect ratios
- Descriptive alt text on content images
- Decorative images: alt="" and aria-hidden="true"
- Placeholder images: use https://placehold.co/WxH with appropriate dimensions
