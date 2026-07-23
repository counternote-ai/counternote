# Interface quality

## Direction

Use the accepted **Review Desk** direction: a warm, calm, compact macOS utility for interview review. It should not resemble a marketing page or a dense enterprise dashboard.

## Foundation

- Reuse components in `src/renderer/components/ui/` before adding custom controls.
- Use Tailwind utilities and semantic tokens from `src/renderer/styles.css`; avoid inline styles and arbitrary visual values when a token exists.
- Use Lucide icons, not emoji, and give icon-only actions accessible names.
- Keep the light-only warm neutral theme unless dark mode is explicitly designed as a separate project.
- Treat the existing 400 x 600 window as the design viewport.

## Visual hierarchy

- Make the screen title, current system state, and primary action unmistakable.
- Use spacing, alignment, typography, and subtle dividers before adding containers.
- Use white or near-white cards selectively for recordings, transcript blocks, and settings groups.
- Keep toolbar actions quiet; committed actions such as saving may use primary styling.
- Reserve destructive red for real errors and stopping an active recording.
- Use text plus color for status. Do not encode state by color alone.
- Keep the interface compact but never crowd app name, title, primary action, and secondary action onto one narrow row.

## Tokens and components

- The canonical palette and radius tokens live in `src/renderer/styles.css`.
- Status intent: sage for ready, amber/taupe for pending, muted red for stop/error, dark ink for committed actions.
- Prefer `Button`, `Card`, `Badge`, `Input`, `Label`, `Select`, `Switch`, `ScrollArea`, `Separator`, `Tooltip`, and `Alert` from the shared UI layer.
- Extend a shared component variant when a treatment repeats. Keep one-off layout classes at the call site.
- Do not override a shared component's core color, radius, or shadow casually; first check whether a semantic variant belongs in the component.

## Interaction and accessibility

- Use buttons for actions and links/navigation controls for navigation semantics.
- Keep visible focus on every interactive element.
- Preserve stable control dimensions while loading.
- Disable duplicate submissions without disabling unrelated work.
- Use at least a 32 px target for compact toolbar controls and prefer 40 px where the layout allows.
- Keep headings in a logical order and ensure every form control has a programmatic label.
- Do not place interactive controls inside another interactive control.
- Respect reduced motion; animation may clarify state but must not delay action or decorate idly.

## Verification checklist

- Inspect 400 x 600 with zero, sparse, and long content.
- Check long recording titles, transcript paragraphs, and settings help text for clipping.
- Confirm scroll regions retain headers and actions without hiding content.
- Tab through the screen and activate controls with the keyboard.
- Verify focus after navigation or dismissal.
- Confirm loading and disabled states communicate why the action is unavailable.
