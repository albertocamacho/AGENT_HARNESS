# Visual Craft Guidelines

The bar is Airbnb, Notion, Linear. Every page should feel considered, calm, and intentional — like a product team sweated the details. Follow these principles:

## Hierarchy and Spacing
- One clear focal point per viewport: a dominant heading, a hero metric, or a primary action. Everything else is supporting.
- Use a strict spacing rhythm. Pick 2-3 tokens and repeat them religiously: --pesto-space-6 for component padding, --pesto-space-8 for grid gaps, --pesto-space-20 or --pesto-space-24 for section breaks. Inconsistent spacing looks amateur.
- White space is the most powerful design tool. Generous padding around content groups signals clarity and confidence. When in doubt, add more space, not less.
- Group related elements tightly and separate unrelated groups with clear breathing room — proximity is meaning.

## Typography
- Type is the interface. Treat it as the primary design element, not an afterthought.
- Create a clear type ramp with visible size jumps between levels — h1 should feel dramatically larger than h2, not incrementally.
- Use weight contrast aggressively: --pesto-weight-bold for headings, --pesto-weight-medium for labels and nav, --pesto-weight-normal for body. The eye follows weight.
- Body text must be comfortable to read: --pesto-leading-normal, max-width 60-65ch, --pesto-text-secondary for supporting copy to reduce visual noise.
- Small text (captions, metadata, timestamps) should feel intentionally quiet: --pesto-text-sm in --pesto-text-tertiary.

## Surface and Depth
- Build a clear layer cake: page surface at the bottom, cards floating above with shadow-sm, modals/overlays on top with shadow-lg. The user should feel the z-axis.
- Cards should feel like physical objects — solid background, subtle border, gentle shadow. On hover, they lift (shadow-md) to invite interaction.
- Alternate between --pesto-surface-page and --pesto-surface-sunken across adjacent sections to create rhythm and prevent visual monotony.
- Use borders sparingly. Prefer spacing and surface color changes to separate content. When you do use borders, keep them --pesto-border-default (not strong).

## Motion and Interaction
- Every interactive element must respond to the user. No dead-feeling buttons or flat links.
- Use `transition: all 300ms cubic-bezier(1, 0, 0, 1)` as the default interaction curve. This gives a snappy, slightly springy feel — fast out, smooth in.
- Buttons: translate up 1-2px on hover (`transform: translateY(-1px)`) and increase shadow. The button should feel like it's rising to meet the finger.
- Cards: lift on hover with shadow-md and a subtle translateY(-2px). The card is saying "I'm clickable."
- Links: color shift to --pesto-text-link-hover is sufficient. No underlines on hover for nav links — underline only for inline text links.
- Focus states must be visible and beautiful: 2px solid --pesto-border-focus with a 2px offset. Focus is a feature, not a compliance checkbox.
- Stagger entrance animations when multiple cards or list items appear together — each item delayed 50-75ms after the previous. This creates a cascade that feels alive.
- Use `@keyframes` for page-load entrance: fade in + translateY(8px → 0) over 400ms. Content should arrive, not just appear.

## Color and Contrast
- Use color with intention. The brand color (--pesto-brand-*) should appear in exactly 2-3 places per viewport: the primary CTA, an accent element, and maybe an active nav indicator. More than that dilutes its power.
- Body text is always --pesto-text-primary. Secondary information is --pesto-text-secondary. Never reverse this.
- Status colors (error, warning, success, info) should only appear in context — badges, alerts, form states. Never use them decoratively.
- Dark backgrounds create drama. Use --pesto-neutral-800 or --pesto-neutral-900 sections sparingly for hero areas or CTAs, with --pesto-text-inverse for text.

## Layout and Composition
- Asymmetry is more interesting than symmetry. A 60/40 or 2/3-1/3 split is more dynamic than 50/50.
- Hero sections should be generous — at least 60-70vh on desktop. Don't crowd the first impression.
- Grid layouts should feel inevitable, not forced. Use 3-column for feature cards, 2-column for content + sidebar, single column for text-heavy sections.
- Align everything to the container. Stray elements that break the grid feel like bugs, not design choices.
- On mobile, everything stacks to single column. No exceptions. Touch targets are 44px minimum.

## Details that Matter
- Icons should be consistent in size and stroke weight. If using emoji as icons, wrap them in a colored circle (brand-100 background, brand-700 text) to make them feel designed.
- Numbers and metrics should be large (--pesto-text-3xl or --pesto-text-4xl), bold, and in --pesto-brand-600 or --pesto-text-primary. They're the content, not decoration.
- Empty states and edge cases matter. If a section could be empty, design for it — don't leave a blank void.
- Consistent border-radius across a page. Pick one radius (--pesto-radius-lg for cards, --pesto-radius-md for buttons/inputs) and stick with it.
