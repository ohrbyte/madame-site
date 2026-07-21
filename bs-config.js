/* Browser-sync config — replaces the old CLI flags in package.json so we can
   add MIDDLEWARE: a same-origin reverse proxy for the Cleaneri public API.

   /api/* → https://admin.cleanmadame.com/api/*  (the PRODUCTION public API)

   Why a proxy and not a cross-origin fetch: the backend's CORS policy is an
   allowlist (security H9) and this preview host isn't on it. Same-origin also
   matches how every other mount of this site works (nginx does the same job
   on :8083 and under /docs/madame-site/ on :9091), so api.js's
   document.currentScript.src base-derivation gives one behaviour everywhere.

   NOTE: prod API — bookings, clients and Stripe (test-mode) charges created
   through this proxy are real rows in the production database. */

const https = require("https");
const http = require("http");

const API_ORIGIN = "admin.cleanmadame.com";

/* Clean routes — the pages live on disk as step-N.html (named for the PSDs
   they were built from), but the URLs a visitor sees describe the step. The
   map rewrites the request path; the file name never reaches the address bar.
   Links in the HTML are RELATIVE ("address", not "/address") so the same
   pages also work mounted under a sub-path (nginx :8083 and the
   /docs/madame-site/ mount carry the same rewrites). */
const ROUTES = {
  "/sign-in": "/step-1.html",
  "/address": "/step-2.html",
  "/day": "/step-3.html",
  "/time": "/step-4.html",
  "/review": "/step-5.html",
  "/all-set": "/step-6.html",
  "/my-bookings": "/my-bookings.html",
  "/purchase-a-gift": "/purchase-a-gift.html",
  "/about": "/about.html",
  "/terms": "/terms.html",
};

function apiProxy(req, res, next) {
  // connect treats "." as a route boundary too, so "/api.js" ALSO lands here
  // (stripped and re-rooted to "/.js" — indistinguishable from a real API
  // path once stripped). Route on the ORIGINAL url: only /api/… is ours;
  // anything else goes back to the static server.
  const original = req.originalUrl || "/api" + req.url;
  if (!original.startsWith("/api/")) return next();
  const proxied = https.request(
    {
      hostname: API_ORIGIN,
      path: original,
      method: req.method,
      headers: { ...req.headers, host: API_ORIGIN },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    }
  );
  proxied.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "BadGateway", message: err.message }));
  });
  req.pipe(proxied);
}

module.exports = {
  port: 3001,
  ui: { port: 3011 },
  server: {
    baseDir: ".",
    index: "index.html",
    middleware: [
      // SECURITY GUARD (must stay first). baseDir is the working tree, so
      // without this the public tunnel serves repo internals — including
      // /.git/config, whose remote URL had a push credential embedded. 404
      // anything that is not a deliverable: any dot-prefixed path segment
      // (.git, .claude, .env, .gitignore), plus known internal files/dirs.
      // Real pages (/step-1.html, /api.js, /dist/…, /css/…, /assets/…) have no
      // dot-segment and pass straight through.
      {
        route: "",
        handle: (req, res, next) => {
          let p;
          try { p = decodeURIComponent((req.url || "/").split("?")[0]); }
          catch { p = (req.url || "/").split("?")[0]; }
          const blocked =
            /(^|\/)\.[^/]/.test(p) ||
            /^\/(bs-config\.js|package(-lock)?\.json|CLAUDE\.md|CONVERSION\.md|INTEGRATION\.md|README\.md)$/.test(p) ||
            /^\/(scripts|node_modules)(\/|$)/.test(p);
          if (blocked) {
            res.statusCode = 404;
            res.setHeader("Cache-Control", "no-store");
            return res.end("Not found");
          }
          next();
        },
      },
      // This origin is reached through Cloudflare (madame.ohrbyte.dev), and
      // with no Cache-Control from the origin Cloudflare edge-caches static
      // extensions — including 404s (it held api.js's 404 for 4h once). A
      // live-reload dev server must never be cached upstream.
      {
        route: "",
        handle: (req, res, next) => {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          const [path, query] = req.url.split("?");
          if (ROUTES[path]) req.url = ROUTES[path] + (query ? `?${query}` : "");
          next();
        },
      },
      { route: "/api", handle: apiProxy },
      // Same proxy, DEV flavour: /dev-api/* → the local cleaneri-api on
      // :5000. Point a session at it with
      //   localStorage.setItem('madame_api_base', location.origin + '/dev-api/v1')
      // to exercise the flow against the dev stack instead of production
      // (and localStorage.removeItem(...) to go back).
      {
        route: "/dev-api",
        handle: (req, res, next) => {
          const original = req.originalUrl || "/dev-api" + req.url;
          if (!original.startsWith("/dev-api/")) return next();
          const proxied = http.request(
            {
              hostname: "127.0.0.1",
              port: 5000,
              path: "/api" + original.slice("/dev-api".length),
              method: req.method,
              headers: { ...req.headers, host: "localhost:5000" },
            },
            (upstream) => {
              res.writeHead(upstream.statusCode, upstream.headers);
              upstream.pipe(res);
            }
          );
          proxied.on("error", (err) => {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: "BadGateway", message: err.message }));
          });
          req.pipe(proxied);
        },
      },
    ],
  },
  files: [
    "*.html",
    "dist/styles.css",
    "css/pages/*.css",
    "app.js",
    "api.js",
    "booking.js",
    "assets/**/*.svg",
  ],
  notify: false,
  open: false,
  /* ghostMode replicates clicks, form inputs and submits across every
     connected client — with two people (or a person and an agent) testing
     the flow at once, one tab's radio/submit state stomps the other's.
     A booking form is exactly where that must never happen. */
  ghostMode: false,
};
