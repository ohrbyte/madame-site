# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Madame is a static booking site for the Cleaneri cleaning service: seven PSD-designed
screens (landing + six flow steps), no framework, wired to the live Cleaneri public API.
Tailwind v4 compiles the one stylesheet; browser-sync serves and live-reloads.

## Commands

```bash
npm install
npm run dev        # tailwind --watch + browser-sync on :3001 (config: bs-config.js)
npm run build      # minified dist/styles.css only — the site itself needs no build
```

There are no tests. On the Cleaneri dev VPS this repo lives at `/root/madame-site`,
`npm run dev` already runs as the `madame-site` systemd service, and the Cloudflare
tunnel serves it at `https://madame.ohrbyte.dev/` — edit, save, the browser reloads.

## The flow

Clean routes (rewritten to files by bs-config.js and mirrored in the VPS nginx mounts —
`step-N.html` names the PSD each page came from, the route names the step):

| Route | File | What happens |
|---|---|---|
| `/` | index.html | Poster landing. "Click to hire" enters the flow. |
| `/sign-in` | step-1.html | Auth: phone (SMS code) or email (magic link); new clients give a name and register. |
| `/address` | step-2.html | One-line address, live Static-Maps preview; validated against the service area, saved to the profile. |
| `/day` | step-3.html | Real calendar (Monday-first, month pager, past days disabled). |
| `/time` | step-4.html | Hours stepper (bounds from booking rules) feeding live availability slots. |
| `/review` | step-5.html | Backend's estimate + saved cards / Stripe Payment Element; Confirm books (handles 3DS). |
| `/all-set` | step-6.html | Confirmation rendered from the real booking. |
| `/my-bookings` | my-bookings.html | Bookings made on this device (localStorage — the public API has no list endpoint). |
| `/purchase-a-gift` | purchase-a-gift.html | Anonymous gift purchase, amounts priced from the backend's hourly rate. |

Links in HTML are RELATIVE (`href="day"`, not `/day`) so the same pages work mounted
under a sub-path. Version bumps go through `scripts/bump-version.sh` — it moves the
HTML `?v=` strings, booking.js `SITE_VERSION`, and `version.txt` together. The last
two power the stale-tab self-heal (booking.js): restored/woken tabs poll version.txt
and reload once when behind, so a phone tab restored days later can't keep running
old code. Never edit the three markers separately.

## How the art works

Each screen is a delayered PSD, not a flat export — read CONVERSION.md before touching
it. The load-bearing ideas:

- **The z-stack** (`.stage`, in every page's `<main>`): cream canvas → optional glow →
  `swirl-back` → `layer-hand` → `swirl-front`. Only the hand animates (pointer
  parallax + idle float, app.js).
- **One swirl, drawn twice.** `swirl-back` and `swirl-front` are the SAME asset at the
  IDENTICAL position; the front pass is masked down to the one strand that crosses the
  wrist, so a single ribbon appears to weave over the forearm. The front mask is TWO
  masks intersected: `--front-band` (WHICH strand — a tilted strip derived by trig in
  `.stage` from measured asset constants) and `--front-span` (HOW MUCH of it — a
  per-page shape in `assets/weave/<page>.webp`). Debug with `class="show-stripe"` on
  `<body>`: whatever turns green is the promoted ribbon.
- **The dials.** Every positioning number is a custom property declared in `:root` of
  src/input.css (global: `--art-right`, swirl size/position; per-page: `--hand-*`,
  `--stripe-*`, copy block `--ctop/--cleft/--cw/--cgap`). Pages override them on
  `body[data-page="…"]` in css/pages/<page>.css. **THE ONE RULE: never declare a
  page-facing dial on `.stage`** — an own declaration beats an inherited one, so the
  per-page override silently dies. `.stage` may only derive.
- **Scaling.** `.stage` is `container-type: size` at the PSD's 3900×1816 aspect,
  height-filling and right-anchored (it bleeds off the LEFT on tall screens); all art
  positions are cqw/cqh, so the composition holds at any viewport. The copy/chrome is
  pinned to the VIEWPORT, outside the canvas.
- **CSS pipeline.** src/input.css → Tailwind CLI → dist/styles.css (gitignored).
  css/pages/*.css are NOT compiled — raw files loaded after dist/styles.css, so they
  win on cascade order alone. `url()` in input.css resolves relative to dist/; in page
  CSS relative to css/pages/.
- The headline accents (underlines, superellipse rings) are inline SVG strokes that
  draw on via `stroke-dashoffset`; entrance is `.anim` + `--d` delay, gated on
  `html.js` set inline in `<head>` so a JS failure never blanks the page.

## How the wiring works

Three scripts, loaded in this order on every page: **api.js** (the API client,
`window.MadameApi`) → **app.js** (pure presentation: entrance, hand parallax, map
preview, `data-focuses` handoff — keep it stateless) → **booking.js** (the flow
controller; everything stateful).

- **State:** `sessionStorage.madame_flow` carries `{date, hours, slot, address,
  estimate, booking}` between pages; `localStorage` holds the client JWT
  (`public_client_token`, owned by api.js) and this device's booking records
  (`madame_bookings`). Steps guard themselves: no token → `/sign-in`; no date/slot →
  back to `/day`.
- **booking.js** dispatches on `body[data-page]` — one `init*` per page. Rendered
  controls reuse the shared primitives; the markup-shipped grids/rows are no-JS
  fallbacks that get replaced on load.
- **step-1 stages:** the one centred card moves through `start → code | sent → name`,
  driven by `data-stage` on the form. Stage visibility uses the `hidden` ATTRIBUTE,
  not classes: the phone/email crossfade is `:has(#mode-…:checked)` whose ID-level
  specificity beats any class, but `[hidden]`'s `display:none` is a different property
  and always wins. The submit button (`.authsubmit`) appears only when the field holds
  something sendable and its label says what pressing it does; hidden, it is still the
  form's default button — a form with several text fields and no submit button never
  implicitly submits, so this is what makes Enter work.
- Money is never computed client-side — the backend's estimate/config is rendered
  verbatim. The Stripe elements are iframes and take the design through Stripe's
  appearance API (tokens in booking.js), not CSS.

## The dev server is part of the design (bs-config.js)

Browser-sync runs from bs-config.js, and its middleware is load-bearing:

- `/api/*` → reverse proxy to **production** admin.cleanmadame.com, so the browser
  stays same-origin (no CORS). Note the connect gotcha: `.` is a route boundary, so
  `/api.js` also matches the `/api` route — the handler filters on `req.originalUrl`.
- `/dev-api/*` → the local dev API on :5000. Point a session at it with
  `localStorage.setItem('madame_api_base', location.origin + '/dev-api/v1')`
  (`removeItem` to return to prod). `?api=<url>` works too.
- `Cache-Control: no-store` on everything — this origin is reached through Cloudflare,
  which otherwise edge-caches static extensions, including 404s.
- The clean-route rewrites (same map as the table above).
- `ghostMode: false` — it replicates clicks/inputs/submits across every connected
  client, which turns two simultaneous testers into a haunting. Leave it off.

**The API surface itself is deliberately not documented here** — api.js is small and
1:1 with the endpoints (snake_case both ways); read it, and see the backend repo
(`cleaneri-core`) for semantics. One behavior to know: a 401 clears the stored JWT.

## Design conventions for new UI

Anything new must be built from the existing primitives, all in src/input.css:
`.panel` (the blue card), `.choice` (any pick-one-of-many cell — calendar day, time
slot, gift amount, saved card), `.field`/`.fields` (cream inputs on the card),
`.btn`/`.eyebrow`, `.inkline` (the hand-drawn hover underline), `.formnote` (status
line: quiet info, pink error), `.stripe-box` (cream well for Stripe iframes),
`aria-busy` for in-flight actions. Pink means "this one" (and errors); cream wells on
blue; no new colors. Dates render American-style ("Friday, July 17"), built from fixed name tables in booking.js (no Intl locale — a missing-locale format() is what broke the Upcoming date filter once).

Fonts: Neulis Sans/Cursive are Adobe-synced and absent — drop files into fonts/ per
fonts/README.txt and the site picks them up; until then Poppins stands in, and a few
page CSS files carry fallback-size corrections marked for deletion once Neulis lands.

## Legacy / reference

`index.legacy.html` and root-level `styles.css` are the pre-Tailwind era, referenced by
nothing — don't extend them. `assets/manifest.json` records the PSD extraction (not
read at runtime). `scripts/delayer.py` re-extracts layers from a PSD (see
CONVERSION.md, which also lists per-PSD layer indices). README.md predates the
multi-page flow and is partly stale; trust this file and CONVERSION.md.
