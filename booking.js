/* Madame — booking flow controller.

   Wires the designed step pages to the Cleaneri public API (window.MadameApi,
   see api.js — same-origin /api/v1 proxy to admin.cleanmadame.com). app.js
   stays pure presentation (entrance + parallax); everything stateful is here.

   The flow spans SEPARATE PAGES (step-1.html … step-6.html), unlike the
   single-page reference implementation this is ported from, so the state that
   used to live in one in-memory object rides in sessionStorage between pages:

     sessionStorage.madame_flow   { date, hours, slot, frequency_weeks, notes,
                                    preferred_cleaner_id, preferred_cleaner_name,
                                    address, address_id, estimate, booking }
     localStorage.public_client_token   the client JWT (owned by api.js)
     localStorage.madame_bookings       bookings made on THIS device — the
                                        public API has no list endpoint, so
                                        my-bookings can only show what it saw

   Flow: step-1 auth (SMS OTP or email magic link; new clients register)
       → step-2 address (validate service area, save)
       → step-3 day → step-4 hours + slot
       → step-5 estimate + payment (Stripe SetupIntent / saved card) + book
       → step-6 confirmation. */

(function () {
  const api = window.MadameApi;
  if (!api) return;
  const page = document.body.dataset.page || "";

  /* ---------- flow state (sessionStorage) ---------- */

  const FLOW_KEY = "madame_flow";
  const RECORDS_KEY = "madame_bookings";

  const flow = {
    read() {
      try { return JSON.parse(sessionStorage.getItem(FLOW_KEY)) || {}; }
      catch { return {}; }
    },
    patch(part) {
      const next = { ...flow.read(), ...part };
      sessionStorage.setItem(FLOW_KEY, JSON.stringify(next));
      return next;
    },
    clear() { sessionStorage.removeItem(FLOW_KEY); },
  };

  /* ---------- small shared helpers ---------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const money = (n) => `$${Number(n).toFixed(2)}`;

  function digits(value) { return String(value || "").replace(/\D+/g, ""); }

  // 10 digits → +1##########, 11 starting with 1 → +###########, else pass through.
  function toE164(value) {
    const d = digits(value);
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return value.startsWith("+") ? value : `+${d}`;
  }

  // "Friday 17 July" — the design writes dates UK-style, so we keep its voice.
  function designDate(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(dt);
    const month = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(dt);
    return `${weekday} ${d} ${month}`;
  }

  function shortDate(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(dt);
  }

  function weekdayName(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  }

  // Cadence in prose: 1 → "every week", 2 → "every 2 weeks".
  function freqPhrase(weeks) {
    return weeks === 1 ? "every week" : `every ${weeks} weeks`;
  }

  function formatErr(e) {
    return (e && (e.message || (e.status ? `Error ${e.status}` : ""))) || "Something went wrong.";
  }

  /* The status line. Every panel that talks to the API gets one .formnote;
     info stays quiet, errors go pink. */
  function note(el, msg, isErr) {
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.classList.toggle("formnote--err", !!isErr);
  }

  /* An action that is underway must say so and refuse a second press. Works on
     both <button> and the design's <a class="btn"> actions — and on a whole
     <form>, where only aria-busy is set (swapping a form's textContent would
     flatten its children to a string). */
  async function busy(el, label, fn) {
    if (!el || el.getAttribute("aria-busy") === "true") return;
    const prev = label ? el.textContent : null;
    el.setAttribute("aria-busy", "true");
    if (label) el.textContent = label;
    try { return await fn(); }
    finally {
      el.removeAttribute("aria-busy");
      if (label) el.textContent = prev;
    }
  }

  function goto(href) { window.location.href = href; }

  /* A session is live only if the token exists AND hasn't expired — judging
     by existence alone let a stale token brick sign-in: the sign-in page
     bounced "already signed in" visitors onward while every API call 401'd.
     A dead token is cleared on sight so no page trips over it again. */
  function hasLiveSession() {
    const claims = api.claims();
    if (!claims) return false;
    if (claims.exp && claims.exp * 1000 <= Date.now() + 30000) {
      api.setToken(null);
      return false;
    }
    return true;
  }

  /* Signed-out visitors get bounced to the start of the flow. */
  function requireAuth() {
    if (hasLiveSession()) return true;
    goto("sign-in");
    return false;
  }

  /* A magic-link click lands back with ?token=… (on whichever page the email
     pointed at). Verify it, keep the JWT, scrub the URL. Runs on every page.
     Returns "ok" (signed in), "failed" (link dead — say so), or false. */
  async function handleMagicLinkReturn() {
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (!token) return false;
    let failed = false;
    try {
      const res = await api.verifyMagicLink(token);
      if (res && res.access_token) api.setToken(res.access_token);
      else failed = true;
    } catch { failed = true; /* used or expired — fall through signed out */ }
    params.delete("token");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
    return api.getToken() ? "ok" : (failed ? "failed" : false);
  }

  function isNewClient() {
    const claims = api.claims();
    return claims && (claims.is_new === true || claims.is_new === "true");
  }

  /* ---------- Stripe (step-5 + gift page) ---------- */

  let stripePromise = null;
  function getStripe(publishableKey) {
    if (!stripePromise) stripePromise = Promise.resolve(window.Stripe(publishableKey));
    return stripePromise;
  }

  /* The Payment Element is an iframe, so it can't inherit the panel's CSS —
     it takes the design tokens through Stripe's appearance API instead. */
  const STRIPE_APPEARANCE = {
    theme: "stripe",
    variables: {
      colorPrimary: "#D93A92",
      colorBackground: "#EDE3C7",
      colorText: "#045BA7",
      colorDanger: "#D93A92",
      borderRadius: "12px",
      fontFamily: 'Poppins, "Avenir Next", "Segoe UI", system-ui, sans-serif',
    },
  };

  /* ================================================================
     STEP 1 — auth. One centred panel, four stages, driven by
     data-stage on the form: start → code (SMS) / sent (email) → name
     (new clients register) → step-2.
     ================================================================ */
  function initStep1() {
    const form = $("form.panel");
    if (!form) return;
    const lede = $(".panel-lede", form);
    const authnote = $(".authnote", form);
    const authalt = $(".authalt", form);
    const phoneField = $("#signin-phone", form);
    const emailField = $("#signin-email", form);
    const codeField = $("#signin-code", form);
    const nameField = $("#signin-name", form);
    const status = $(".formnote", form);

    let pendingPhone = "";

    /* Stage visibility rides on the hidden attribute, not the stylesheet: the
       phone/email crossfade is driven by :has(#mode-…:checked), whose ID-level
       specificity would beat any stage class — but display:none from [hidden]
       is a different property, so it wins regardless. */
    const authswap = $(".authswap", form);
    const submitBtn = $(".authsubmit", form);

    const emailMode = () => !!($("#mode-email", form) || {}).checked;

    /* The button shows only when what's typed is actually sendable, and its
       label says what pressing it will do. Enter works either way — the
       hidden button is still the form's default button. */
    function stageValid() {
      const st = form.dataset.stage || "start";
      if (st === "start") {
        return emailMode()
          ? EMAIL_RE.test(emailField.value.trim())
          : digits(phoneField.value).replace(/^1/, "").length === 10;
      }
      if (st === "code") return digits(codeField.value).length >= 6;
      if (st === "name") return nameField.value.trim().length > 0;
      return false; // "sent" — the inbox is the next step, not this card
    }

    function refreshSubmit() {
      if (!submitBtn) return;
      const st = form.dataset.stage || "start";
      submitBtn.textContent =
        st === "code" ? "Sign in"
        : st === "name" ? "Continue"
        : emailMode() ? "Email me a sign-in link"
        : "Text me a sign-in code";
      submitBtn.hidden = !stageValid();
    }

    function stage(name) {
      form.dataset.stage = name;
      form.dataset.sent = name === "code" || name === "sent" ? "true" : "false";
      const inStart = name === "start";
      if (phoneField) phoneField.hidden = !inStart;
      if (emailField) emailField.hidden = !inStart;
      if (codeField) codeField.hidden = name !== "code";
      if (nameField) nameField.hidden = name !== "name";
      if (authswap) authswap.hidden = !inStart;
      note(status, "");
      refreshSubmit();
      const focus = { start: null, code: codeField, name: nameField }[name];
      if (focus) focus.focus();
    }

    [emailField, codeField, nameField].forEach((el) => {
      if (el) el.addEventListener("input", refreshSubmit);
    });
    form.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.addEventListener("change", refreshSubmit);
    });

    /* Where signing in lands you. Booking is the default; pages that sent the
       visitor here to re-authenticate (my-bookings after the session lapsed)
       say so with ?next= — allowlisted, never echoed blindly. */
    function authDestination() {
      const next = new URLSearchParams(window.location.search).get("next");
      return next === "my-bookings" ? "my-bookings" : "address";
    }

    async function afterAuth() {
      if (isNewClient()) {
        if (lede) lede.textContent = "Lovely to meet you — what should we call you?";
        if (authnote) authnote.hidden = true;
        stage("name");
        return;
      }
      goto(authDestination());
    }

    /* The phone field wears a live mask — (845) 576-6740 — so what you see is
       what a US number looks like. Digits only, ten of them; the mask is
       display, toE164 still derives the wire format from the digits. */
    if (phoneField) phoneField.addEventListener("input", () => {
      const d = digits(phoneField.value).replace(/^1/, "").slice(0, 10);
      phoneField.value =
        d.length > 6 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
        : d.length > 3 ? `(${d.slice(0, 3)}) ${d.slice(3)}`
        : d.length > 0 ? `(${d}`
        : "";
      refreshSubmit();
    });

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    // Came back via a magic link — walk straight on (or say the link is dead).
    handleMagicLinkReturn().then((result) => {
      if (result === "failed") {
        note(status, "That sign-in link is invalid or has already been used — request a new one below.", true);
        return;
      }
      if (result === "ok" || hasLiveSession()) afterAuth();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault(); // the action="address" GET stays as the no-JS path
      const st = form.dataset.stage || "start";
      const submitBusy = (label, fn) => busy(form, null, fn); // form-level lock
      try {
        if (st === "start") {
          const mode = $("#mode-email", form)?.checked ? "email" : "phone";
          if (mode === "phone") {
            pendingPhone = toE164(phoneField.value);
            if (digits(pendingPhone).length !== 11) return note(status, "That phone number doesn't look complete — we need all ten digits.", true);
            await submitBusy(null, () => api.sendSmsOtp(pendingPhone));
            if (authnote) authnote.innerHTML = `We sent a code to <strong>${pendingPhone}</strong> —<br>type it in above to sign in.`;
            if (authalt) authalt.textContent = "Use a different number";
            stage("code");
          } else {
            const email = emailField.value.trim();
            if (!EMAIL_RE.test(email)) return note(status, "That doesn't look like an email address yet.", true);
            await submitBusy(null, () => api.sendMagicLink(email));
            if (authnote) authnote.innerHTML = `We sent a login link to <strong>${email}</strong> —<br>check your inbox and click the link to sign in.`;
            if (authalt) authalt.textContent = "Use a different email";
            stage("sent");
          }
        } else if (st === "code") {
          const code = digits(codeField.value);
          if (code.length < 4) return note(status, "Enter the code from the text message.", true);
          const res = await submitBusy(null, () => api.verifySmsOtp(pendingPhone, code));
          if (res && res.access_token) api.setToken(res.access_token);
          await afterAuth();
        } else if (st === "name") {
          const name = nameField.value.trim();
          if (!name) return note(status, "We do need something to call you.", true);
          const claims = api.claims() || {};
          const res = await api.register({ name, phone: claims.phone || undefined, email: claims.email || undefined, tos_accepted: true });
          if (res && res.access_token) api.setToken(res.access_token);
          goto(authDestination());
        }
      } catch (err) {
        note(status, formatErr(err), true);
      }
    });

    if (authalt) authalt.addEventListener("click", (e) => {
      e.preventDefault();
      pendingPhone = "";
      if (codeField) codeField.value = "";
      stage("start");
    });

    refreshSubmit();
  }

  /* ================================================================
     STEP 2 — address. One free-text line, parsed to the API's shape,
     validated against the service area, then saved to the profile.
     ================================================================ */

  // "14 Smith St, Monroe, NY 10950" → { street1, city, state, zip_code }.
  // Four comma parts means an apartment line: street2 rides along.

  function formatAddress(a) {
    if (!a || !a.street1) return "";
    return [a.street1, a.street2, a.city, `${a.state} ${a.zip_code}`].filter(Boolean).join(", ");
  }

  function initStep2() {
    if (!requireAuth()) return;
    const field = $("#addr");            // hidden: the composed one-line form (map + sync contract)
    const form = $("form.panel");
    const btn = $(".content .btn");
    const status = $(".formnote", form);
    const list = $(".addrlist", form);
    const streetEl = $("#addr-street", form);
    const aptEl = $("#addr-apt", form);
    const cityEl = $("#addr-city", form);
    const stateEl = $("#addr-state", form);
    const zipEl = $("#addr-zip", form);
    const parts = [streetEl, aptEl, cityEl, stateEl, zipEl];

    let saved = [];      // every address on the account (API)
    let picked = null;   // the chosen saved address, or null = typing a new one

    function fmtSaved(a) {
      return `${a.street1}${a.street2 ? " " + a.street2 : ""}, ${a.city}, ${a.state} ${a.zip_code}`;
    }

    /* The structured fields are the source of truth; the hidden #addr gets the
       composed line so the map preview keeps working unchanged. */
    function fillParts(a) {
      streetEl.value = a.street1 || "";
      aptEl.value = a.street2 || "";
      cityEl.value = a.city || "";
      stateEl.value = a.state || "NY";
      zipEl.value = a.zip_code || "";
    }

    function readParts() {
      return {
        street1: streetEl.value.trim(),
        street2: aptEl.value.trim() || undefined,
        city: cityEl.value.trim(),
        state: stateEl.value.trim().toUpperCase(),
        zip_code: zipEl.value.trim(),
      };
    }

    function syncMap(instant) {
      const p = readParts();
      field.value = p.street1 && p.city ? `${p.street1}, ${p.city}, ${p.state} ${p.zip_code}`.trim() : "";
      field.dispatchEvent(new Event(instant ? "change" : "input"));
    }

    function renderList() {
      if (!list) return;
      list.innerHTML = "";
      if (!saved.length) { list.hidden = true; return; }
      list.hidden = false;
      saved.forEach((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice choice--addr";
        b.innerHTML = `<span>${a.street1}</span><small>${a.city}, ${a.state}</small>`;
        if (picked && picked.id === a.id) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          picked = a;
          fillParts(a);
          syncMap(true);
          note(status, "");
          renderList();
        });
        list.appendChild(b);
      });
      const other = document.createElement("button");
      other.type = "button";
      other.className = "choice choice--addr";
      other.innerHTML = `<span>Somewhere else</span><small>type a new address</small>`;
      if (!picked) { other.classList.add("is-on"); other.setAttribute("aria-pressed", "true"); }
      other.addEventListener("click", () => {
        picked = null;
        fillParts({ state: "NY" });
        syncMap(true);
        renderList();
        streetEl.focus();
      });
      list.appendChild(other);
    }

    // Every address on the account becomes a pick-one cell; the default (or
    // the flow's previous pick) starts selected. Editing any field by hand
    // un-picks — typing means "somewhere else".
    api.clientAddresses().then((rows) => {
      saved = rows || [];
      const prev = flow.read().address_id;
      picked = (prev && saved.find((a) => a.id === prev))
        || saved.find((a) => a.is_default) || saved[0] || null;
      if (picked) { fillParts(picked); syncMap(true); }
      renderList();
    }).catch(() => { /* older backend or expired token — the manual fields stand */ });

    parts.forEach((el) => el && el.addEventListener("input", () => {
      if (picked) { picked = null; renderList(); }
      syncMap(false);
    }));

    async function confirmAddress() {
      // A saved address was validated when it was added — confirm and move on.
      if (picked) {
        flow.patch({
          address: { street1: picked.street1, street2: picked.street2, city: picked.city, state: picked.state, zip_code: picked.zip_code },
          address_id: picked.id,
        });
        return goto("day");
      }
      const parsed = readParts();
      if (!parsed.street1 || !parsed.city || parsed.state.length !== 2 || !/^\d{5}$/.test(parsed.zip_code)) {
        return note(status, "Please fill in the street, city, two-letter state and 5-digit ZIP.", true);
      }
      await busy(btn, "Checking…", async () => {
        try {
          const res = await api.validateAddress({ street1: parsed.street1, city: parsed.city, state: parsed.state, zip_code: parsed.zip_code });
          if (!res || !res.is_in_service_area) {
            return note(status, "Sorry — that address is outside our service area.", true);
          }
          if (saved.length) {
            // The account already has addresses — ADD this one. Overwriting
            // the default in place (the old single-address behaviour) would
            // silently clobber an address the client still uses.
            const added = await api.addClientAddress(parsed);
            flow.patch({ address: parsed, address_id: added && added.id });
          } else {
            await api.updateAddress(parsed);
            flow.patch({ address: parsed, address_id: undefined });
          }
          goto("day");
        } catch (err) {
          note(status, formatErr(err), true);
        }
      });
    }

    if (btn) btn.addEventListener("click", (e) => { e.preventDefault(); confirmAddress(); });
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); confirmAddress(); });
  }

  /* ================================================================
     STEP 3 — the day. A real month with the design's Monday-first
     grid, paged by the little arrows next to the month name.
     ================================================================ */
  function initStep3() {
    if (!requireAuth()) return;
    const avail = window.MadameAvailability;
    const panel = $(".panel");
    const monthLabel = $("h2", panel);
    const grid = $(".cal-grid", panel);
    const continueBtn = $(".btn", panel);
    const status = $(".formnote", panel);

    if (flow.read().edit) note(status, "Changing your clean — pick the new day.");
    const prevBtn = $(".cal-nav-prev", panel);
    const nextBtn = $(".cal-nav-next", panel);

    const today = avail.todayKey();
    let [year, month] = today.split("-").map(Number);
    let selected = flow.read().date || "";
    // A date picked in an earlier session that has since gone by is stale.
    if (selected && selected < today) { selected = ""; flow.patch({ date: "" }); }
    const monthsAhead = 3; // rolling window — matches how far dispatch plans

    function render() {
      const cal = avail.generateCalendarMonth({ year, month });
      monthLabel.textContent = cal.monthLabel;
      grid.innerHTML = "";
      grid.setAttribute("aria-label", `Choose a day in ${cal.monthLabel}`);

      // generateCalendarMonth pads Sunday-first; the design's week runs M→S.
      const pad = (new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay() + 6) % 7;
      for (let i = 0; i < pad; i += 1) grid.appendChild(document.createElement("span"));

      cal.cells.filter((c) => !c.blank).forEach((cell) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = cell.day;
        if (cell.isPast) b.disabled = true;
        if (cell.dateKey === selected) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          selected = cell.dateKey;
          flow.patch({ date: selected, slot: null });
          note(status, "");
          render();
        });
        grid.appendChild(b);
      });

      const first = `${year}-${String(month).padStart(2, "0")}`;
      prevBtn.disabled = first <= today.slice(0, 7);
      const [ty, tm] = today.split("-").map(Number);
      const ahead = (year - ty) * 12 + (month - tm);
      nextBtn.disabled = ahead >= monthsAhead;
    }

    function shift(delta) {
      month += delta;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      render();
    }

    prevBtn.addEventListener("click", () => shift(-1));
    nextBtn.addEventListener("click", () => shift(1));

    continueBtn.addEventListener("click", (e) => {
      if (!selected) { e.preventDefault(); note(status, "Pick a day first.", true); }
    });

    render();
  }

  /* ================================================================
     STEP 4 — hours + start time. The stepper feeds the availability
     query: real slots for that day and that duration, from the API.
     ================================================================ */
  function initStep4() {
    if (!requireAuth()) return;
    const state = flow.read();
    if (!state.date) return goto("day");

    const panel = $(".panel");
    const heading = $("h2", panel);
    const hoursLine = $("[data-hours-line]", panel);
    const hoursValue = $("[data-hours-value]", panel);
    const minus = $(".hours-step--minus", panel);
    const plus = $(".hours-step--plus", panel);
    const freqBox = $(".freq", panel);
    const grid = $(".timegrid", panel);
    const continueBtn = $(".btn", panel);
    const status = $(".formnote", panel);

    heading.textContent = designDate(state.date);

    /* Edit mode: this visit is re-picking date/time/hours for an EXISTING
       booking (flow.edit from my-bookings). The backend previews the 24h
       late fees; pressing again confirms and applies. Frequency and the
       past-cleaner pick don't apply to an edit and stay hidden. */
    const editing = state.edit || null;
    let previewed = null;
    function invalidatePreview() {
      if (!editing) return;
      previewed = null;
      continueBtn.textContent = "Review change";
    }

    // How often — 0 keeps the flow one-time, anything else books a series
    // repeating on the picked day's weekday. Every 3 weeks exists on the phone
    // line but not here; four cells is what the card wears well.
    const FREQ_CHOICES = [
      { weeks: 0, label: "Just once" },
      { weeks: 1, label: "Every week" },
      { weeks: 2, label: "Every 2 weeks" },
      { weeks: 4, label: "Every 4 weeks" },
    ];
    let frequency = state.frequency_weeks || 0;

    /* Past cleaners — a returning client can ask for a lady they've had
       before. The whole section stays hidden when there are none. */
    const ladyLine = $(".ladypick-line", panel);
    const ladyBox = $(".ladypick", panel);
    let ladies = [];
    let preferredId = state.preferred_cleaner_id || "";

    function renderLadies() {
      if (!ladyBox || !ladies.length) return;
      ladyLine.hidden = false;
      ladyBox.hidden = false;
      ladyBox.innerHTML = "";
      const cells = [{ id: "", first_name: "No preference" }].concat(ladies);
      cells.forEach((l) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = l.first_name;
        if (l.id === preferredId) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          preferredId = l.id;
          flow.patch({ preferred_cleaner_id: l.id || undefined, preferred_cleaner_name: l.id ? l.first_name : undefined });
          renderLadies();
        });
        ladyBox.appendChild(b);
      });
    }

    if (!editing) {
      api.pastCleaners().then((rows) => {
        ladies = rows || [];
        if (preferredId && !ladies.some((l) => l.id === preferredId)) preferredId = "";
        renderLadies();
      }).catch(() => { /* section stays hidden */ });
    }

    function renderFreq() {
      if (editing) {
        freqBox.hidden = true;
        const freqLine = freqBox.previousElementSibling;
        if (freqLine && freqLine.tagName === "P") freqLine.hidden = true;
        return;
      }
      freqBox.innerHTML = "";
      FREQ_CHOICES.forEach((f) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = f.label;
        if (f.weeks === frequency) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          frequency = f.weeks;
          flow.patch({ frequency_weeks: frequency });
          renderFreq();
        });
        freqBox.appendChild(b);
      });
    }
    renderFreq();

    let rules = { min_hours: 3, max_hours: 12 };
    let hours = state.hours || 0;
    let slots = [];
    let selectedStart = state.slot ? state.slot.start_time : "";

    function renderHours() {
      hoursValue.textContent = `${hours} ${hours === 1 ? "hour" : "hours"}`;
      minus.disabled = hours <= rules.min_hours;
      plus.disabled = hours >= rules.max_hours;
    }

    function renderSlots() {
      grid.innerHTML = "";
      slots.forEach((slot) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = slot.start_formatted || slot.start_time;
        if (slot.start_time === selectedStart) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          selectedStart = slot.start_time;
          flow.patch({ slot, hours });
          note(status, "");
          invalidatePreview();
          renderSlots();
        });
        grid.appendChild(b);
      });
    }

    /* The old grid stays visible (dimmed) while fresh availability loads —
       blanking it on every stepper click made the section look like it was
       restarting. Rapid clicks fire overlapping requests; the token makes
       the LAST one win so a slow older response can't overwrite a newer one. */
    let slotsReq = 0;
    async function refreshSlots() {
      const req = ++slotsReq;
      grid.setAttribute("aria-busy", "true");
      note(status, "Checking who's free…");
      try {
        const fresh = (await api.availableSlots(state.date, hours)) || [];
        if (req !== slotsReq) return;
        slots = fresh;
        note(status, slots.length ? "" : "No one is free that day for that long — try another day or fewer hours.", !slots.length);
        if (!slots.some((s) => s.start_time === selectedStart)) { selectedStart = ""; flow.patch({ slot: null }); }
        renderSlots();
      } catch (err) {
        if (req === slotsReq) note(status, formatErr(err), true);
      } finally {
        if (req === slotsReq) grid.removeAttribute("aria-busy");
      }
    }

    function setHours(next) {
      hours = Math.min(rules.max_hours, Math.max(rules.min_hours, next));
      flow.patch({ hours });
      invalidatePreview();
      renderHours();
      refreshSlots();
    }

    minus.addEventListener("click", () => setHours(hours - 1));
    plus.addEventListener("click", () => setHours(hours + 1));

    if (editing) {
      continueBtn.textContent = "Review change";
      continueBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        const st = flow.read();
        if (!st.slot) return note(status, "Pick a start time first.", true);
        const body = { date: st.date, start_time: st.slot.start_time, hours };
        if (!previewed) {
          await busy(continueBtn, "Checking…", async () => {
            try {
              const p = await api.modifyPreview(editing.id, body);
              if (!p || p.valid === false) {
                return note(status, (p && p.error_message) || "That change isn't possible — try another time.", true);
              }
              previewed = p;
              const bits = (p.fees || []).map((f) => f.message);
              if (p.cleaner_unavailable) bits.push("Your usual lady isn't free then — another great lady will cover it.");
              if (p.new_total != null) bits.push(`New total: ${money(p.new_total)}.`);
              bits.push("Press again to confirm.");
              note(status, bits.join(" "));
            } catch (err) {
              note(status, formatErr(err), true);
            }
          });
          // busy() restores the label it saved on entry, so the new label
          // must land AFTER it settles.
          if (previewed) continueBtn.textContent = "Confirm change";
          return;
        }
        await busy(continueBtn, "Applying…", async () => {
          try {
            await api.modifyBooking(editing.id, body);
            try {
              const recs = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]");
              const rec = recs.find((x) => x.id === editing.id);
              if (rec) {
                rec.date = st.date;
                rec.start = st.slot.start_formatted || st.slot.start_time;
                rec.hours = hours;
                if (previewed.new_total != null) rec.amount = previewed.new_total;
              }
              localStorage.setItem(RECORDS_KEY, JSON.stringify(recs));
            } catch { /* records are a nicety */ }
            flow.clear();
            goto("my-bookings");
          } catch (err) {
            note(status, formatErr(err), true);
            invalidatePreview();
          }
        });
      });
    } else {
      continueBtn.addEventListener("click", (e) => {
        if (!flow.read().slot) { e.preventDefault(); note(status, "Pick a start time first.", true); }
      });
    }

    api.bookingRules().catch(() => rules).then((r) => {
      if (r && r.min_hours) rules = r;
      setHours(hours || rules.min_hours);
    });
  }

  /* ================================================================
     STEP 5 — review + pay + book. The estimate is the backend's
     (the site never computes money); payment is a saved card or a
     new one through a Stripe SetupIntent, then POST /bookings with
     the 3DS requires_action dance if Stripe asks for it.
     ================================================================ */
  function initStep5() {
    if (!requireAuth()) return;
    const state = flow.read();
    if (!state.date || !state.slot || !state.hours) return goto("day");

    const panel = $(".panel");
    const review = $(".review", panel);
    const status = $(".formnote", panel);
    const confirmBtn = $(".btn", panel);
    const payList = $(".paylist", panel);
    const stripeBox = $(".stripe-box", panel);
    const notesEl = $("#booking-notes", panel);
    const languageEl = $("#booking-language", panel);
    const freq = state.frequency_weeks || 0;

    // Special instructions and language ride the flow state so
    // back-navigation keeps them.
    if (notesEl) {
      notesEl.value = state.notes || "";
      notesEl.addEventListener("input", () => flow.patch({ notes: notesEl.value }));
    }
    if (languageEl) {
      languageEl.value = state.language || "English";
      languageEl.addEventListener("change", () => flow.patch({ language: languageEl.value }));
    }

    if (freq > 0) {
      // A series never charges at confirm — each visit is billed to the chosen
      // card as its date approaches. Say so where the card is picked.
      const payNote = document.createElement("p");
      payNote.className = "paynote";
      payNote.textContent = "Nothing is charged today — each visit is billed to this card around the time of the clean.";
      stripeBox.after(payNote);
    }

    let stripe = null;
    let elements = null;
    let selectedPm = "";      // a saved payment_method_id, or "new"
    let methods = [];
    let estimateOk = false;
    let coveredByCredit = false;   // one-time, fully paid by gift balance
    let preferredBusy = false;     // chosen past cleaner isn't free for this slot

    function reviewRow(dt, dd, cls) {
      const dtEl = document.createElement("dt");
      dtEl.textContent = dt;
      const ddEl = document.createElement("dd");
      ddEl.textContent = dd;
      if (cls) ddEl.className = cls;
      review.append(dtEl, ddEl);
    }

    async function loadEstimate() {
      const est = await api.estimate({ date: state.date, start_time: state.slot.start_time, hours: state.hours, address_id: state.address_id, preferred_cleaner_id: state.preferred_cleaner_id });
      review.innerHTML = "";
      reviewRow("When", `${designDate(state.date)}, ${state.slot.start_formatted || state.slot.start_time}`);
      if (freq > 0) reviewRow("Repeats", freq === 1 ? `Every ${weekdayName(state.date)}` : `Every ${freq} weeks on ${weekdayName(state.date)}s`);
      if (state.preferred_cleaner_name) reviewRow("Your lady", state.preferred_cleaner_name);
      reviewRow("Where", formatAddress(state.address) || "Your saved address");
      reviewRow("What", `Home clean · ${est.hours || state.hours} hours (${money(est.rate_per_hour)}/hr)`);
      if (est.taxi_fee > 0) reviewRow("Travel fee", money(est.taxi_fee));
      // Gift credit spends automatically on one-time cleans (recurring visits
      // bill the card in full), so the bold number is what the card REALLY
      // pays — a gifted customer shouldn't brace for a charge that isn't coming.
      if (freq === 0 && est.credit_applied > 0) {
        reviewRow("Total", money(est.total_amount));
        reviewRow("Gift credit", `−${money(est.credit_applied)}`);
        reviewRow("Your card pays", money(est.amount_due), "review-total");
      } else {
        reviewRow(freq > 0 ? "Total per visit" : "Total", money(est.total_amount), "review-total");
      }
      coveredByCredit = freq === 0 && est.credit_applied > 0 && est.amount_due === 0;
      if (coveredByCredit) {
        const payTitle = $(".pay-title", panel);
        if (payTitle) payTitle.hidden = true;
        payList.hidden = true;
        stripeBox.hidden = true;
        const covered = document.createElement("p");
        covered.className = "paynote";
        covered.textContent = "No card needed — your gift credit covers this clean.";
        payList.before(covered);
      }
      // The busy heads-up: booking still works, but the customer must know a
      // substitute steps in — continuing past this note IS the acknowledgment
      // (accept_substitute) the backend requires.
      preferredBusy = est.preferred_cleaner_available === false;
      if (preferredBusy) {
        note(status,
          `${state.preferred_cleaner_name} isn't free at this time — pick another time to keep her, or continue and we'll send another great lady.`,
          true);
      }
      flow.patch({ estimate: est });
      estimateOk = true;
    }

    function renderMethods() {
      payList.innerHTML = "";
      methods.forEach((m) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice choice--pay";
        b.innerHTML = `<span>${(m.brand || "card").toUpperCase()} ·· ${m.last4}</span><small>exp ${m.exp_month}/${String(m.exp_year).slice(-2)}</small>`;
        if (m.payment_method_id === selectedPm) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => { selectedPm = m.payment_method_id; stripeBox.hidden = true; renderMethods(); });
        payList.appendChild(b);
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "choice choice--pay";
      add.innerHTML = `<span>${methods.length ? "Use a new card" : "Add a card"}</span>`;
      if (selectedPm === "new") { add.classList.add("is-on"); add.setAttribute("aria-pressed", "true"); }
      add.addEventListener("click", async () => {
        selectedPm = "new";
        renderMethods();
        await mountPaymentElement();
      });
      payList.appendChild(add);
    }

    async function ensureStripe() {
      if (stripe) return stripe;
      const config = await api.getClientConfig();
      stripe = await getStripe(config.stripe_publishable_key);
      return stripe;
    }

    async function mountPaymentElement() {
      try {
        stripeBox.hidden = false;
        if (elements) return; // already mounted
        await ensureStripe();
        const setup = await api.createSetupIntent();
        elements = stripe.elements({ clientSecret: setup.client_secret, appearance: STRIPE_APPEARANCE });
        elements.create("payment", { layout: "tabs" }).mount(stripeBox);
      } catch (err) {
        note(status, formatErr(err), true);
      }
    }

    async function loadMethods() {
      try {
        methods = (await api.paymentMethods()) || [];
        const preferred = methods.find((m) => m.is_default) || methods[0];
        selectedPm = preferred ? preferred.payment_method_id : "new";
        renderMethods();
        if (selectedPm === "new") await mountPaymentElement();
      } catch (err) {
        note(status, formatErr(err), true);
      }
    }

    /* A new card becomes a saved payment method BEFORE booking: confirm the
       SetupIntent, then tell the backend about the resulting pm id. */
    async function ensurePaymentMethod() {
      if (selectedPm && selectedPm !== "new") return selectedPm;
      if (!elements) throw new Error("Add a card first.");
      const result = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
        confirmParams: { return_url: window.location.origin + window.location.pathname },
      });
      if (result.error) throw new Error(result.error.message);
      const pmId = typeof result.setupIntent.payment_method === "string"
        ? result.setupIntent.payment_method
        : result.setupIntent.payment_method && result.setupIntent.payment_method.id;
      const saved = await api.addPaymentMethod(pmId);
      // The SetupIntent is consumed now. If booking still fails (say the
      // recurring dup-guard), a retry must reuse the saved card — confirming
      // the spent intent again would error on every attempt after this.
      selectedPm = pmId;
      if (saved && saved.payment_method_id) {
        methods.push(saved);
        stripeBox.hidden = true;
        renderMethods();
      }
      return pmId;
    }

    async function confirmBooking() {
      if (!estimateOk) return note(status, "Hold on — still fetching your price.", true);
      await busy(confirmBtn, "Booking…", async () => {
        try {
          note(status, "");
          // Fully-credited one-time cleans need no card at all — the backend
          // charges nothing. Everything else (incl. every series) collects one.
          const pmId = coveredByCredit ? undefined : await ensurePaymentMethod();
          const notes = (notesEl && notesEl.value.trim()) || undefined;
          const language = (languageEl && languageEl.value) || "English";
          let record;
          if (freq > 0) {
            // A series: no charge now, so no 3DS dance — the chosen card is
            // stored on the series and billed per visit.
            const r = await api.bookRecurring({
              date: state.date,
              start_time: state.slot.start_time,
              hours: state.hours,
              frequency_weeks: freq,
              language,
              payment_method_id: pmId,
              notes,
              address_id: state.address_id,
              preferred_cleaner_id: state.preferred_cleaner_id,
              accept_substitute: preferredBusy || undefined,
            });
            record = {
              id: r.first_booking_id || r.id,
              date: r.start_date || state.date,
              start: state.slot.start_formatted || state.slot.start_time,
              hours: state.hours,
              amount: (flow.read().estimate || {}).total_amount,
              address: formatAddress(state.address),
              recurring: r.frequency_weeks || freq,
              created: Date.now(),
            };
          } else {
            const result = await api.book({
              date: state.date,
              start_time: state.slot.start_time,
              hours: state.hours,
              payment_method_id: pmId,
              language,
              notes,
              address_id: state.address_id,
              preferred_cleaner_id: state.preferred_cleaner_id,
              accept_substitute: preferredBusy || undefined,
            });
            let final = result;
            if (result && result.requires_action) {
              await ensureStripe();
              const { error, paymentIntent } = await stripe.confirmCardPayment(
                result.payment_intent_client_secret, undefined, { handleActions: true });
              if (error) throw new Error(error.message);
              // Manual capture: the charge is authorised now, captured on completion.
              if (paymentIntent && paymentIntent.status !== "requires_capture") {
                throw new Error(`Unexpected payment status: ${paymentIntent.status}`);
              }
              final = await api.confirmPayment(result.booking_id);
            }
            record = {
              id: final.id || result.booking_id,
              date: state.date,
              start: state.slot.start_formatted || state.slot.start_time,
              hours: state.hours,
              amount: (flow.read().estimate || {}).total_amount,
              address: formatAddress(state.address),
              created: Date.now(),
            };
          }
          try {
            const records = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]");
            records.unshift(record);
            localStorage.setItem(RECORDS_KEY, JSON.stringify(records.slice(0, 20)));
          } catch { /* records are a nicety, never fatal */ }
          flow.patch({ booking: record });
          goto("all-set");
        } catch (err) {
          note(status, formatErr(err), true);
        }
      });
    }

    confirmBtn.addEventListener("click", (e) => { e.preventDefault(); confirmBooking(); });

    loadEstimate().catch((err) => note(status, formatErr(err), true));
    loadMethods();
  }

  /* ================================================================
     STEP 6 — say what actually got booked.
     ================================================================ */
  function initStep6() {
    const state = flow.read();
    const sub = $(".subhead");
    if (state.booking && sub) {
      sub.innerHTML = state.booking.recurring
        ? `Your regular clean is booked — <strong>${freqPhrase(state.booking.recurring)}</strong>, starting <strong>${designDate(state.booking.date)}</strong> at <strong>${state.booking.start}</strong>. We've sent the details to your phone.`
        : `Your booking is confirmed. We've sent the details to your phone — your cleaner will be there <strong>${designDate(state.booking.date)}</strong> at <strong>${state.booking.start}</strong>.`;
    }
    // The flow is done; a fresh "Book another lady" starts clean (the JWT and
    // the device's booking records live in localStorage and survive this).
    flow.clear();
  }

  /* ================================================================
     MY BOOKINGS — the public API has no list endpoint, so this page
     shows the bookings made on this device (localStorage).
     ================================================================ */
  function initMyBookings() {
    const list = $(".bookings");
    if (!list) return;
    let records = [];
    try { records = JSON.parse(localStorage.getItem(RECORDS_KEY) || "[]"); } catch { /* noop */ }

    // Shared machines: the session (30 days) and this list live in the
    // browser, so a public computer keeps both for whoever sits down next.
    // One quiet link wipes them — two-press, because the device list is the
    // only copy (there's no server list to restore it from).
    function addSignout() {
      if (!api.getToken() && !records.length) return;
      const wrap = document.createElement("p");
      wrap.className = "booking-signout";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "signout-link";
      link.textContent = "Sign out on this device";
      link.addEventListener("click", () => {
        if (wrap.querySelector(".booking-confirm")) return;
        const strip = document.createElement("span");
        strip.className = "booking-confirm";
        const q = document.createElement("span");
        q.textContent = "Sign out?";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "booking-act booking-act--cancel";
        yes.textContent = "Sign out";
        yes.addEventListener("click", () => {
          api.setToken(null);
          localStorage.removeItem(RECORDS_KEY);
          window.location.reload();
        });
        const no = document.createElement("button");
        no.type = "button";
        no.className = "booking-act";
        no.textContent = "Keep";
        no.addEventListener("click", () => strip.remove());
        strip.append(q, yes, no);
        wrap.appendChild(strip);
      });
      wrap.appendChild(link);
      list.parentElement.appendChild(wrap);
    }

    function rowFor(r) {
      const li = document.createElement("li");
      li.className = "booking";
      const when = document.createElement("span");
      when.className = "booking-when";
      when.innerHTML = `<strong>${shortDate(r.date)}</strong> · ${r.start}`;
      const what = document.createElement("span");
      what.className = "booking-what";
      what.textContent = `Home clean · ${r.hours}h${r.amount ? ` · ${money(r.amount)}` : ""}${r.recurring ? ` · ${freqPhrase(r.recurring)}` : ""}`;
      li.append(when, what);
      return li;
    }

    function renderList(rows, emptyText) {
      list.innerHTML = "";
      if (!rows.length) {
        const li = document.createElement("li");
        li.className = "booking booking--empty";
        li.textContent = emptyText;
        list.appendChild(li);
        return;
      }
      rows.forEach((r) => list.appendChild(rowFor(r)));
    }

    renderList(records, "No bookings on this device yet — your next clean will show up here.");

    /* A future one-time clean can be changed or cancelled right here. The
       backend previews the 24h late fees (cancellation / hour-removal) and
       charges them on apply — the site only ever repeats what it says.
       (Recurring series records don't get actions yet — their this-vs-future
       scope deserves its own flow.) */
    function addActions(li, r) {
      const actions = document.createElement("span");
      actions.className = "booking-actions";
      const change = document.createElement("button");
      change.type = "button";
      change.className = "booking-act";
      change.textContent = "Change";
      change.addEventListener("click", () => {
        flow.clear();
        flow.patch({ edit: { id: r.id, hours: r.hours }, hours: r.hours });
        goto("day");
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "booking-act booking-act--cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", async () => {
        if (actions.querySelector(".booking-confirm")) return;
        let feeLine = "";
        try {
          const p = await api.cancelPreview(r.id);
          if (p && p.fee_applies) feeLine = ` A ${money(p.fee_amount)} late-cancellation fee applies.`;
        } catch { /* previewless confirm still works */ }
        const strip = document.createElement("span");
        strip.className = "booking-confirm";
        const q = document.createElement("span");
        q.textContent = `Cancel this clean?${feeLine}`;
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "booking-act booking-act--cancel";
        yes.textContent = feeLine ? "Yes, cancel & pay the fee" : "Yes, cancel";
        yes.addEventListener("click", async () => {
          yes.disabled = true;
          try {
            await api.cancelBooking(r.id);
            li.classList.add("booking--cancelled");
            const what = li.querySelector(".booking-what");
            if (what) what.textContent += " · cancelled";
            actions.remove();
          } catch (err) {
            q.textContent = formatErr(err);
            yes.disabled = false;
          }
        });
        const no = document.createElement("button");
        no.type = "button";
        no.className = "booking-act";
        no.textContent = "Keep it";
        no.addEventListener("click", () => strip.remove());
        strip.append(q, yes, no);
        actions.appendChild(strip);
      });
      actions.append(change, cancel);
      li.appendChild(actions);
    }

    // Managing a booking needs a live session, and sessions lapse — say so,
    // once, instead of silently going read-only (which reads as "the site is
    // broken"). The button carries ?next= so signing in lands back here.
    function offerSignin() {
      if (list.parentElement.querySelector(".booking-signin")) return;
      const p = document.createElement("p");
      p.className = "formnote booking-signin";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "booking-act";
      btn.textContent = "Sign in";
      btn.addEventListener("click", () => goto("sign-in?next=my-bookings"));
      p.append(records.length
        ? "Sign back in to change or cancel a clean. "
        : "Have cleans booked? Sign in to see them. ", btn);
      list.before(p);
    }

    if (!hasLiveSession()) {
      offerSignin();
      addSignout();
      return;
    }

    // Fallback for when the account list can't be fetched: the device records
    // are all we have, so ask the backend for each one's real status and mark
    // the ones that moved on (an office-side cancellation never reached them).
    function reconcileDeviceRows() {
      records.slice(0, 12).forEach(async (r, i) => {
        try {
          const s = await api.bookingStatus(r.id);
          const li = list.children[i];
          if (!li) return;
          if (s && s.status && s.status !== "scheduled") {
            li.hidden = true;
          } else if (s && s.status === "scheduled" && !r.recurring
            && new Date(`${r.date}T23:59:59`) > new Date()) {
            addActions(li, r);
          }
        } catch (err) {
          if (err && err.status === 401) offerSignin();
        }
      });
    }

    // Signed in, the ACCOUNT is the source of truth: the backend lists every
    // booking tied to this client — made on any device, through the IVR, or by
    // the office — with statuses included, so the device records are only the
    // instant first paint (and the signed-out fallback). Upcoming first, then
    // the recent past.
    (async () => {
      try {
        const server = await api.listBookings();
        const now = new Date();
        const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        // The panel says Upcoming and means it: only scheduled, today-or-
        // future cleans. Cancelled and completed history stays off the list
        // (the office dashboard is the archive).
        const ordered = ((server && server.bookings) || []).map((b) => ({
          id: b.id,
          date: b.date,
          start: b.start_time,
          hours: b.hours,
          amount: b.amount,
          recurring: b.frequency_weeks || 0,
          status: b.status,
        })).filter((r) => r.status === "scheduled" && r.date >= todayKey);
        renderList(ordered, "No upcoming cleans — book your next one below.");
        ordered.forEach((r, i) => {
          const li = list.children[i];
          if (!li) return;
          if (!r.recurring) addActions(li, r);
        });
      } catch (err) {
        if (err && err.status === 401) offerSignin();
        else reconcileDeviceRows();
      }
    })();

    addSignout();
  }

  /* ================================================================
     PURCHASE A GIFT — anonymous. Amounts come from the backend's
     hourly rate; payment is the classic card Element + the
     requires_action confirm loop. Turnstile only if configured.
     ================================================================ */
  function initGift() {
    const form = $("form.panel");
    if (!form) return;
    const amounts = $(".amounts", form);
    const status = $(".formnote", form);
    const payBtn = $(".btn", form);
    const cardBox = $(".stripe-box", form);

    let config = null;
    let stripe = null;
    let card = null;
    let chosenHours = 0;
    let customOn = false;      // the "pick your own" stepper is active
    let customHours = 12;
    let turnstileToken = null;

    const HOUR_CHOICES = [4, 6, 10, 20];
    const hoursBox = $(".gift-hours", form);
    const hoursValue = $("[data-gift-hours]", form);
    const hoursMinus = $(".hours-step--minus", form);
    const hoursPlus = $(".hours-step--plus", form);

    function renderCustom() {
      if (!hoursBox) return;
      hoursBox.hidden = !customOn;
      if (!customOn) return;
      hoursValue.textContent = `${customHours} ${customHours === 1 ? "hour" : "hours"}`;
      hoursMinus.disabled = customHours <= config.min_hours;
      hoursPlus.disabled = customHours >= config.max_hours;
    }

    function renderAmounts() {
      amounts.innerHTML = "";
      HOUR_CHOICES.filter((h) => h >= config.min_hours && h <= config.max_hours).forEach((h) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.innerHTML = `<span>${money(h * config.hourly_rate)}</span><small>${h} hours</small>`;
        if (!customOn && h === chosenHours) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => { customOn = false; chosenHours = h; renderAmounts(); renderCustom(); });
        amounts.appendChild(b);
      });
      // Any amount between the backend's bounds, an hour at a time.
      const custom = document.createElement("button");
      custom.type = "button";
      custom.className = "choice";
      custom.innerHTML = customOn
        ? `<span>${money(chosenHours * config.hourly_rate)}</span><small>${chosenHours} hours</small>`
        : `<span>Pick your own</span><small>${config.min_hours}–${config.max_hours} hours</small>`;
      if (customOn) { custom.classList.add("is-on"); custom.setAttribute("aria-pressed", "true"); }
      custom.addEventListener("click", () => {
        customOn = true;
        chosenHours = customHours;
        renderAmounts();
        renderCustom();
      });
      amounts.appendChild(custom);
    }

    function setCustomHours(next) {
      customHours = Math.min(config.max_hours, Math.max(config.min_hours, next));
      chosenHours = customHours;
      renderAmounts();
      renderCustom();
    }

    if (hoursMinus) hoursMinus.addEventListener("click", () => setCustomHours(customHours - 1));
    if (hoursPlus) hoursPlus.addEventListener("click", () => setCustomHours(customHours + 1));

    async function mountCard() {
      stripe = await getStripe(config.stripe_publishable_key);
      const elements = stripe.elements();
      card = elements.create("card", {
        style: {
          base: {
            color: "#045BA7",
            fontFamily: 'Poppins, "Segoe UI", sans-serif',
            "::placeholder": { color: "rgba(4, 91, 167, .45)" },
          },
          invalid: { color: "#D93A92" },
        },
      });
      card.mount(cardBox);
    }

    // The backend rejects purchases without a Turnstile token whenever it has
    // keys configured, so the widget must render exactly when config says so.
    function mountTurnstile() {
      const box = $("#turnstile", form);
      if (!box || !config.turnstile_site_key) return;
      if (!window.turnstile) return setTimeout(mountTurnstile, 200);
      box.hidden = false;
      window.turnstile.render(box, {
        sitekey: config.turnstile_site_key,
        callback: (t) => { turnstileToken = t; },
        "error-callback": () => { turnstileToken = null; },
        "expired-callback": () => { turnstileToken = null; },
      });
    }

    async function purchase() {
      const recipientName = $("#gift-to", form).value.trim();
      const recipientPhone = $("#gift-phone", form).value;
      const buyerName = $("#buyer-name", form).value.trim();
      const buyerPhone = $("#buyer-phone", form).value;
      if (!chosenHours) return note(status, "Pick an amount first.", true);
      if (!recipientName || digits(recipientPhone).length < 10) return note(status, "We need their name and a full phone number.", true);
      if (digits(buyerPhone).length < 10) return note(status, "We need your phone number too — it goes on the gift.", true);
      if (config.turnstile_site_key && !turnstileToken) return note(status, "One tick left — the security check above the button.", true);

      await busy(payBtn, "Sending…", async () => {
        try {
          note(status, "");
          const pm = await stripe.createPaymentMethod({ type: "card", card });
          if (pm.error) throw new Error(pm.error.message);
          const payload = {
            recipient_name: recipientName,
            recipient_phone: digits(recipientPhone),
            hours: chosenHours,
            buyer_name: buyerName || undefined,
            buyer_phone: digits(buyerPhone),
            turnstile_token: turnstileToken || undefined,
          };
          let res = await api.giftPurchase({ ...payload, payment_method_id: pm.paymentMethod.id });
          if (res && res.requires_action) {
            const conf = await stripe.confirmCardPayment(res.client_secret);
            if (conf.error) throw new Error(conf.error.message);
            res = await api.giftConfirm({ ...payload, payment_intent_id: res.payment_intent_id });
          }
          form.dataset.stage = "done";
          const h2 = $("h2", form);
          const p = $("p", form);
          if (h2) h2.textContent = "Gift sent!";
          if (p) p.innerHTML = `We've texted <strong>${recipientName}</strong> a ${chosenHours}-hour clean (${money(res && res.amount != null ? res.amount : chosenHours * config.hourly_rate)}). You do look thoughtful.`;
        } catch (err) {
          note(status, formatErr(err), true);
          // A Turnstile token is single-use — the failed attempt consumed it.
          if (window.turnstile && config.turnstile_site_key) {
            window.turnstile.reset();
            turnstileToken = null;
          }
        }
      });
    }

    form.addEventListener("submit", (e) => { e.preventDefault(); purchase(); });

    api.giftConfig().then(async (c) => {
      config = c;
      chosenHours = HOUR_CHOICES[1];
      renderAmounts();
      mountTurnstile();
      await mountCard();
    }).catch((err) => note(status, formatErr(err), true));
  }

  /* ---------- dispatch ---------- */

  const inits = {
    "step-1": initStep1,
    "step-2": initStep2,
    "step-3": initStep3,
    "step-4": initStep4,
    "step-5": initStep5,
    "step-6": initStep6,
    "my-bookings": initMyBookings,
    "purchase-a-gift": initGift,
  };

  async function boot() {
    // A magic link can land on any page; steps handle it in their own init.
    if (!inits[page]) { await handleMagicLinkReturn(); return; }
    if (page !== "step-1") await handleMagicLinkReturn();
    inits[page]();
  }

  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
