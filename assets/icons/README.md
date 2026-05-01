# Drev section icons

Pixel-art icons for the README's section headings. Same aesthetic as `drev_logo.png`: dark background, the same blue / orange / red palette, retro terminal feel.

## Spec

- **Output format:** PNG with transparent or matched-dark-background pixels
- **Display size:** 40px wide (the README's `<img>` tag has `width="40"`)
- **Native canvas:** square. Pick whichever multiple looks cleanest:
  - 16×16 native, displayed at 40×40 (2.5x, slightly fuzzy on whole-pixel rendering)
  - 20×20 native, displayed at 40×40 (2x, crisp)
  - 32×32 native, displayed at 40×40 (1.25x, slightly soft)
  - 40×40 native, displayed at 40×40 (1x, sharpest but tightest pixel budget)
- **Transparent backgrounds** preferred so the icons sit cleanly on GitHub's white or dark theme
- **Match the logo's palette**: navy / dark blue background tones, the orange-to-red gradient on the wordmark, light blue accents

## Files needed

Drop these into this directory. The README is already wired to pick them up; you don't need to touch the markup.

| File | Section | Concept |
|---|---|---|
| `demo.png` | Demo | CRT screen with a play triangle, or a VHS tape, or a film slate |
| `quick-start.png` | Quick start | Rocket, sparkle, sprout, or a starting flag |
| `example.png` | Example: a session end-to-end | Two-terminal handoff, linked-chain, or a baton being passed |
| `inside-claude-code.png` | Use it inside Claude Code | Speech bubble with a cursor inside, or a chat icon with a small terminal mark |
| `from-terminal.png` | Use it from the terminal | Pixel terminal cursor (a blinking `█`), or a `$_` prompt |
| `auto-share.png` | Auto-share | Cyclic arrows, sync icon, or a radar ping |
| `reference.png` | Reference | Open book, index card, or a stack of notes |
| `how-built.png` | How this was built | Hammer + gear, scaffolding, or a wave of small agent sprites |
| `license.png` | License | Scroll with a seal, or a parchment with a star |

## Production order (recommended)

If you're making them in stages, do this order so the README looks intentional even halfway through:

1. **Top-of-page first:** `demo.png`, `quick-start.png` (visible above the fold)
2. **Common-use sections next:** `inside-claude-code.png`, `from-terminal.png`, `auto-share.png`
3. **Lower sections last:** `example.png`, `reference.png`, `how-built.png`, `license.png`

While icons are missing, GitHub renders a broken-image placeholder next to the heading. The heading text is still readable because the markup keeps the `## Title` text outside the `<img>` tag.

## Tips that helped on `drev_logo.png`

- The wordmark uses a 1-pixel light-blue outline against a slightly darker fill. Replicating that on the icons keeps them consistent.
- The starfield background on the logo is optional for the small icons; transparent backgrounds usually read better at 40px.
- For mid-detail icons (book, terminal, rocket), 20×20 native at 2x display is the sweet spot. Fine details get lost at 16×16, and 32×32 pushes you toward more detail than a 40px display can show.
