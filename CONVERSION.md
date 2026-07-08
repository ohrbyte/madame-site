# Madame — PSD → Web conversion

How the Photoshop designs become this site, and how to redo it for any new PSD.

## The core idea: delayer, don't flatten

A flat export of each PSD can't animate — the hand is welded to the background.
So each page is split into **independent layers**, stacked with CSS, with the
**text added live on top** (sharper than baked-in type, and it lets the cursive
underlines/circles draw themselves).

Each screen is a z-stack of separate layers (every part lives as its own file in
`assets/layers/<page>/` as PNG, plus shared optimised WebP/SVG in `assets/`):

| z | Layer | File | Animates? |
|---|-------|------|-----------|
| 0 | cream canvas | `cream.webp` | no |
| 1 | soft glow | `landing-glow.webp` (screen blend) | no |
| 2 | swirl — full, **behind** hand | `swirl.webp` / `swirl.svg` | no |
| 3 | hand + item | `<page>-hand.webp` | **yes — mouse parallax** |
| 4 | swirl — **same asset**, masked to the crossing band, **in front** | `swirl.webp` | no |

Then the logo, headline, buttons and form blocks are HTML/CSS on top.

### One swirl, not two

The swirl is a **single asset drawn twice** at the *identical* position: once
behind the hand (z2) and once in front (z4) masked to just the band that crosses
the forearm (`--front-band` in `styles.css`). Because both passes use the same
file at the same coordinates they coincide exactly — so it reads as one
continuous swirl, never doubled. The hand sits between the two passes (z3), so it
can drift on mouse-move while the front band keeps weaving over the wrist.

> Earlier builds used a *separate* `Layer 7 copy` for the front strand — a
> slightly different shape — which is what made the swirl appear twice. Using the
> one swirl asset for both passes fixes it. The `--front-band` mask can be nudged
> per page if a hand's forearm sits higher or lower.

## Pixel-accurate placement

Each PSD is `3900 × 1816`. The stage keeps that aspect ratio, and every layer is
positioned by its **exact PSD coordinates**, converted to percentages. Example
(landing hand at PSD x=1825, y=13, w=2769):

```
--hand-l: 1825/3900 = 46.795%
--hand-t:   13/1816 =  0.716%
--hand-w: 2769/3900 = 71.000%
```

Those numbers live in `assets/manifest.json` and are baked into each page's
`<main class="stage" style="...">`. This is why the layers line up perfectly with
the original — verified by blending the rebuilt art over the mockup (no ghosting).

## Re-delayering a PSD (the tool)

`scripts/delayer.py` does the extraction. Two steps:

```bash
pip install psd-tools pillow numpy scipy   # scipy: PSDs use gradient adjustments

# 1) See what's in the file (writes a labelled contact sheet)
python scripts/delayer.py inspect "../Design/b 2.psd"

# 2) Export the 3 layers once you know the indices (from the contact sheet)
python scripts/delayer.py export "../Design/b 2.psd" --slug step2 --hand 21 --front 22
```

The layer indices used for the current pages (all share the same swirl layers):

| Page  | PSD            | hand | front |
|-------|----------------|------|-------|
| landing / step-1 | `landing page.psd` | 16 | 18 |
| step-2 | `b 2.psd` | 21 | 22 |
| step-3 | `b 3.psd` | 20 | 21 |
| step-4 | `b 4.psd` | 15 | 19 |
| step-5 | `b 5.psd` | 16 | 20 |
| step-6 | `b 6.psd` | 20 | 21 |

> The PSDs are working files with generic layer names (`Layer 7`, `Generative
> Fill copy`, …) and many hidden experiment layers — always `inspect` first.

## Fonts (Neulis)

The titles use **Neulis Sans** + **Neulis Cursive** (Adobe-synced, so they can't
be auto-fetched). Drop the files into `fonts/` using the names in
`fonts/README.txt` and the whole site picks them up. Until then it falls back to
a close system stack, so layout and animation still look right.

## The four animations (per the brief)

1. **Copy entrance** — every text element rises + fades in the same way, lightly
   staggered (`.anim` + `--d` delay). `app.js` adds `.is-ready` on load.
2. **Hand parallax** — `app.js` tracks the pointer and nudges only the hand
   layer (with a faint idle float so it never looks like flat background).
3. **Buttons pink → blue** on hover (`.btn:hover`).
4. **Self-drawing accents** — the pink underlines/circles are inline SVG strokes
   that draw on (`stroke-dashoffset`) a beat after the title arrives.

All respect `prefers-reduced-motion`.

## Files

```
index.html, step-1..6.html   the 7 screens
styles.css                   tokens, layout, all animations
app.js                       entrance + hand parallax (only JS)
fonts/                       fonts.css + where Neulis files go
assets/                      delayered WebP layers + manifest.json
scripts/delayer.py           the PSD → layers tool
index.legacy.html            previous attempt, kept for reference
```

## Preview locally

Just open `index.html`, or for clean relative paths:

```bash
cd Site && python -m http.server 8000   # then open http://localhost:8000
```
