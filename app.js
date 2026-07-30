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

  /* Address autocomplete (step 2). A custom cream dropdown on Google's Places
     API (New), driven by fetch — NOT the Maps JS widget, for the same reason
     the preview is a Static Map and not the Embed iframe: keep Google's chrome
     out and style it ourselves. Progressive — with no JS, no key, or a blocked
     referrer the structured fields still work by hand. On pick we fill the
     fields and fire `input`, so booking.js's existing #addr composition and the
     map preview react with nothing new wired in. One session token bundles the
     keystroke lookups and the final details fetch into a single billed session.
     Placed BEFORE the parallax early-return below so it also runs on touch /
     reduced-motion devices — where autocomplete matters most. */
  (function addressAutocomplete() {
    const street = document.querySelector("#addr-street");
    if (!street) return;
    // The key the map already uses: window.MAPS_KEY on raw/local mounts, or the
    // value the Pages build baked into the map image's src on the live site.
    let key = window.MAPS_KEY;
    const mapImg = document.querySelector(".addr-map");
    if (!key && mapImg) { try { key = new URL(mapImg.src).searchParams.get("key"); } catch (e) { /* noop */ } }
    if (!key || key === "__GOOGLE_MAPS_API_KEY__") return; // no usable key → manual entry stands

    const apt = document.querySelector("#addr-apt");
    const city = document.querySelector("#addr-city");
    const state = document.querySelector("#addr-state");
    const zip = document.querySelector("#addr-zip");

    const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
      : "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16);
        }));
    let token = uuid();   // one billing session; regenerated after each pick

    const box = street.closest(".field") || street.parentElement;
    box.classList.add("addr-ac");
    const menu = document.createElement("ul");
    menu.className = "addr-ac-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    box.appendChild(menu);

    street.setAttribute("role", "combobox");
    street.setAttribute("aria-autocomplete", "list");
    street.setAttribute("aria-expanded", "false");
    street.setAttribute("autocomplete", "off"); // suppress the browser's own box over ours

    let items = [];
    let active = -1;
    let timer = null;
    let lastQuery = "";
    let suppress = false; // guards the input event we fire ourselves on a pick

    function close() {
      menu.hidden = true; menu.innerHTML = ""; items = []; active = -1;
      street.setAttribute("aria-expanded", "false");
    }

    async function lookup(q) {
      const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({
          input: q,
          sessionToken: token,
          includedRegionCodes: ["us"],
          // bias toward the service area (Monroe / Hudson Valley) without
          // hard-restricting — someone just outside it still resolves.
          locationBias: { circle: { center: { latitude: 41.3176, longitude: -74.1868 }, radius: 45000 } },
        }),
      });
      if (!res.ok) throw new Error("ac " + res.status);
      const data = await res.json();
      return (data.suggestions || []).map((s) => s.placePrediction).filter(Boolean);
    }

    function render() {
      menu.innerHTML = "";
      items.forEach((p, i) => {
        const li = document.createElement("li");
        li.className = "addr-ac-opt" + (i === active ? " is-active" : "");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", i === active ? "true" : "false");
        const sf = p.structuredFormat || {};
        const main = (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || "";
        const sec = (sf.secondaryText && sf.secondaryText.text) || "";
        const m = document.createElement("span"); m.className = "addr-ac-main"; m.textContent = main;
        const s = document.createElement("span"); s.className = "addr-ac-sec"; s.textContent = sec;
        li.append(m, s);
        li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); }); // beat blur
        menu.appendChild(li);
      });
      menu.hidden = items.length === 0;
      // sit the popover right under the input, whatever the label height
      menu.style.top = (street.offsetTop + street.offsetHeight + 4) + "px";
      street.setAttribute("aria-expanded", items.length ? "true" : "false");
    }

    function comp(comps, type, short) {
      const c = comps.find((x) => (x.types || []).includes(type));
      return c ? (short ? c.shortText : c.longText) : "";
    }

    async function choose(i) {
      const p = items[i];
      if (!p) return;
      close();
      const placeId = p.placeId || (p.place && p.place.split("/").pop());
      if (!placeId) return;
      try {
        const res = await fetch(
          "https://places.googleapis.com/v1/places/" + encodeURIComponent(placeId) +
          "?sessionToken=" + encodeURIComponent(token),
          { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "addressComponents" } });
        if (!res.ok) throw new Error("details " + res.status);
        const place = await res.json();
        const c = place.addressComponents || [];
        const street1 = [comp(c, "street_number"), comp(c, "route")].filter(Boolean).join(" ").trim();
        const cityV = comp(c, "locality") || comp(c, "postal_town") || comp(c, "sublocality") || comp(c, "administrative_area_level_2");
        const stateV = comp(c, "administrative_area_level_1", true);
        const zipV = comp(c, "postal_code");
        suppress = true;
        if (street1) street.value = street1;
        if (city) city.value = cityV;
        if (state && stateV) state.value = stateV;
        if (zip) zip.value = zipV;
        // one input on the street field: booking.js recomposes #addr, the map
        // redraws, and it un-picks any saved address (this is a fresh one).
        street.dispatchEvent(new Event("input", { bubbles: true }));
        suppress = false;
        if (apt) apt.focus(); // the one thing autocomplete can't know
      } catch (e) {
        suppress = false; // details failed — keep what they typed; manual entry stands
      }
      token = uuid(); // fresh billing session after a completed pick
      lastQuery = "";
    }

    street.addEventListener("input", () => {
      if (suppress) return;
      const q = street.value.trim();
      clearTimeout(timer);
      if (q.length < 3) { close(); return; }
      if (q === lastQuery) return;
      lastQuery = q;
      timer = setTimeout(() => {
        lookup(q).then((r) => { items = r; active = -1; render(); }).catch(() => close());
      }, 220);
    });

    street.addEventListener("keydown", (e) => {
      if (menu.hidden || !items.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === "Escape") { close(); }
    });

    street.addEventListener("blur", () => setTimeout(close, 120)); // let a click land first
  })();

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
