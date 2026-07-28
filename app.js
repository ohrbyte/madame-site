/* Madame — entrance + hand parallax (the only interactive bit) */
(function () {
  const ready = () => document.body.classList.add("is-ready");
  if (document.readyState !== "loading") ready();
  else document.addEventListener("DOMContentLoaded", ready);

  /* Choosing an option puts the cursor in the field it reveals, so you can just
     keep typing instead of hunting for the box you asked for.
     Generic on purpose: any control that swaps something in can say which field
     it hands over to, via data-focuses="#id". The swap itself is pure CSS, so
     this is an enhancement — without it the toggle still works, it just doesn't
     move the cursor for you. */
  document.querySelectorAll("[data-focuses]").forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked === false) return;
      const target = document.querySelector(el.dataset.focuses);
      if (target) target.focus();
    });
  });

  /* Live map preview (step 2). The element already carries a full Maps URL — we
     only ever swap one query parameter — so this stays a dumb string edit. The
     key= parameter ships as the __GOOGLE_MAPS_API_KEY__ placeholder: the Pages
     build substitutes the real key into the HTML, so in production this branch
     is a no-op; on local mounts (which serve the raw tree) it is patched here
     from window.MAPS_KEY (gitignored maps-key.js).
       data-map-src   : selector for the field that drives it
       data-map-param : which parameter carries the place (Static uses `center`,
                        the Embed API used `q`)
       data-map-zoom  : zoom once a REAL place drives the map. The markup ships
                        the wide default view (town at zoom=13); a typed/picked
                        address is a street, so we tighten to this and pin a
                        brand-pink marker on it — at street zoom an unmarked
                        centre is unreadable.
     Debounced, because every change is a fresh image request: typing an address
     should cost one request when you stop, not one per keystroke. Progressive —
     with no JS the map just shows whatever the markup shipped with. */
  document.querySelectorAll("[data-map-src]").forEach((el) => {
    const field = document.querySelector(el.dataset.mapSrc);
    if (!field) return;
    const param = el.dataset.mapParam || "center";
    const url = new URL(el.src);
    if (url.searchParams.get("key") === "__GOOGLE_MAPS_API_KEY__" && window.MAPS_KEY) {
      url.searchParams.set("key", window.MAPS_KEY);
      el.src = url.toString();
    }
    let timer = null;
    const update = () => {
      const q = field.value.trim();
      if (!q || q === url.searchParams.get(param)) return;
      url.searchParams.set(param, q);
      if (el.dataset.mapZoom) {
        url.searchParams.set("zoom", el.dataset.mapZoom);
        url.searchParams.set("markers", "color:0xDB3694|" + q);
      }
      el.src = url.toString();
    };
    field.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(update, 700);
    });
    field.addEventListener("change", () => {
      clearTimeout(timer);
      update();
    });
  });

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canHover = window.matchMedia("(hover: hover)").matches;
  if (reduce || !canHover) return;

  document.querySelectorAll(".stage").forEach((stage) => {
    const hand = stage.querySelector(".layer-hand");
    if (!hand) return;
    stage.dataset.hand = "on";

    let raf = null, tx = 0, ty = 0, cx = 0, cy = 0;
    const lerp = (a, b, n) => a + (b - a) * n;

    function tick() {
      cx = lerp(cx, tx, 0.12);
      cy = lerp(cy, ty, 0.12);
      stage.style.setProperty("--px", cx.toFixed(4));
      stage.style.setProperty("--py", cy.toFixed(4));
      if (Math.abs(cx - tx) > 0.001 || Math.abs(cy - ty) > 0.001) {
        raf = requestAnimationFrame(tick);
      } else { raf = null; }
    }
    function move(e) {
      const r = stage.getBoundingClientRect();
      // -1 .. 1 from the stage centre
      tx = ((e.clientX - r.left) / r.width  - 0.5) * 2;
      ty = ((e.clientY - r.top)  / r.height - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function leave() { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(tick); }

    window.addEventListener("pointermove", move, { passive: true });
    stage.addEventListener("pointerleave", leave, { passive: true });
  });
})();
