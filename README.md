# Madame Site

A minimal, Tailwind-powered static site — no JS rendering framework.

## Stack

- **Tailwind CSS v4** (`@tailwindcss/cli`) — utility-first styling, compiled from `src/input.css` → `dist/styles.css`
- **browser-sync** — local server with automatic browser reload on file changes
- **concurrently** — runs the CSS watcher and dev server together

## Develop

```bash
npm install      # once
npm run dev      # CSS watch + live-reload server at http://localhost:3001
```

Edit `index.html` or `src/input.css` and the browser reloads automatically.

## Build for production

```bash
npm run build    # minified dist/styles.css
```

Deploy `index.html`, `dist/styles.css`, and the served assets
(`background.webp`, `hand-sponge-*.webp`, `path1.svg`) as static files.
The source PNGs are not loaded by the page.

## Assets

The hero is a layered composite (cream base → swirl behind → hand+sponge cutout →
swirl strand in front), built with absolutely-positioned `<img>`s and z-index — no JS.

Images are optimized to WebP. To regenerate after replacing a source PNG:

```bash
node scripts/encode-images.mjs   # PNG -> WebP (background + responsive sponge)
```

`path1.svg` was run through `svgo` (stripped a 937 KB embedded ICC profile).

## Structure

```
index.html               Page markup (Tailwind utility classes)
src/input.css            Tailwind entry, tokens, weave + hover animation
dist/styles.css          Generated CSS (git-ignored)
scripts/encode-images.mjs  PNG -> WebP optimizer
path1.svg                Pink swirl (optimized)
background.webp          Cream base layer (served)
hand-sponge-*.webp       Hand+sponge cutout, 800w / 1600w (served)
background.png           Source for background.webp (not served)
hand-sponge.png          Source for the sponge WebPs (not served)
```
