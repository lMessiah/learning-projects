# home

home of shcherbakov.co

A web design website — the home site for a Maltese web design group.

Single-file, no build step, no external requests: open `index.html`.

## What's in it

- **Silver treatment** — layered radial/linear gradients, a brushed-metal grain
  overlay, and a chrome text ramp (`.chrome`) on the headline.
- **Rainbow outline** — `.rainbow-frame`, a fixed ring around the viewport using a
  rotating `conic-gradient` (`@property --spin`) with a mask cut-out and a blurred
  bloom underneath. Echoed in the logo stroke, the eyebrow pip, and the work box.
- **Logo** — inline SVG eight-point Maltese cross, chrome fill with a prism edge.
- **Work box** — `.workbox`, holding three linked cards. Each card sets its own
  `--tint` / `--tint-2`:
  | Site | Colours | Why |
  | --- | --- | --- |
  | saliba.shcherbakov.co | `#8a5a3b` → `#c9a227` | oak & brass, matching the woodworking site |
  | dayplanner.shcherbakov.co | `#3b5bdb` → `#22b8cf` | indigo/cyan, calendar & productivity |
  | And much more | full rainbow | the spectrum — links to the contact section |
- **Settings bar** — the cog at bottom right. Light / Dark / Auto appearance, an
  animations on/off switch, and the credit line. Both settings persist in
  `localStorage` (`sc-theme`, `sc-motion`) and are applied by a small inline script
  in `<head>` before first paint, so there's no flash of the wrong theme.
- **Animations** — headline lines rise out of an overflow mask, hero elements stagger
  in on load, sections reveal on scroll from four directions, a rainbow scroll-progress
  bar tracks the frame, the nav condenses into a glass pill, three blurred blobs drift
  behind the page, a soft glow eases after the pointer, and the work cards tilt in 3D
  with a tint spotlight that follows the cursor.

## Theming

Colours are semantic custom properties on `:root`, overridden wholesale by
`:root[data-theme="dark"]`. Frosted surfaces read from `--glass-hi` / `--glass-md` /
`--glass-lo` / `--glass-in` rather than hard-coded `rgba(255,255,255,…)`, so a new
theme only needs the token block — no per-component edits.

## Notes

- Respects `prefers-reduced-motion` as the *default* for the animations switch; once
  the visitor sets the switch themselves, their choice wins. Turning animations off
  sets `data-motion="off"` on `<html>`, which kills every animation and transition,
  shows all reveals immediately, and drops the drifting blobs, cursor glow and card
  tilt.
- Contact address is `retrocriticsmalta@gmail.com` — change it in the contact section
  and footer if that's not the right inbox.
