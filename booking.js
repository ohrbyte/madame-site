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
  if (!api) {
    // api.js failed to load: every guard, availability check and payment call
    // below is gone, but the static pages still walk a convincing-looking
    // flow. Say so loudly instead of letting anyone "book" into the void.
    const warn = () => {
      const b = document.createElement("p");
      b.className = "formnote";
      b.setAttribute("role", "alert");
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;margin:0;padding:.6em 1em;background:#8c2440;color:#fff;text-align:center;font-size:.95em;";
      b.textContent = "We couldn't load the booking system — please refresh the page. If it keeps happening, call 845-212-4444 to book.";
      document.body.prepend(b);
    };
    if (document.readyState !== "loading") warn();
    else document.addEventListener("DOMContentLoaded", warn);
    return;
  }
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

  // American date voice ("Friday, July 17"), built from fixed name tables — NO
  // Intl locale, deliberately: relying on an installed locale's format() is
  // exactly what broke the Upcoming filter on browsers missing en-CA data.
  // A dateKey is always "yyyy-mm-dd", so the weekday comes from a noon-UTC
  // Date (never crosses a day boundary) and month/day are read straight off.
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dowOf(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  }

  // "Friday, July 17"
  function designDate(dateKey) {
    const [, m, d] = dateKey.split("-").map(Number);
    return `${WEEKDAYS[dowOf(dateKey)]}, ${MONTHS[m - 1]} ${d}`;
  }

  // "Fri, Jul 17"
  function shortDate(dateKey) {
    const [, m, d] = dateKey.split("-").map(Number);
    return `${WEEKDAYS_SHORT[dowOf(dateKey)]}, ${MONTHS_SHORT[m - 1]} ${d}`;
  }

  function weekdayName(dateKey) {
    return WEEKDAYS[dowOf(dateKey)];
  }

  // Business-day "today" as yyyy-mm-dd, built from NAMED date parts. Never
  // derive this from a locale's format() string: on browsers missing the
  // requested locale data (Samsung Internet, Gmail's in-app WebView), the
  // en-CA one-liner fell back to M/D/YYYY, every `date >= todayKey` compare
  // went false, and the Upcoming list rendered empty on those phones.
  function easternTodayKey() {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const m = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    return `${m.year}-${m.month}-${m.day}`;
  }

  // Cadence in prose: 1 → "every week", 2 → "every 2 weeks".
  function freqPhrase(weeks) {
    return weeks === 1 ? "every week" : `every ${weeks} weeks`;
  }

  function formatErr(e) {
    return (e && (e.message || (e.status ? `Error ${e.status}` : ""))) || "Something went wrong.";
  }

  /* The office's number, in one place. Shown whenever the site has to hand the
     customer back to a person — during the fixed-shift pilot that is the whole
     escape hatch, so it has to be tappable rather than read out inside a note()
     (which sets textContent and would render the markup as literal text). */
  const OFFICE_TEL = "+18452124444";
  const OFFICE_TEL_TEXT = "845-212-4444";

  /* Puts a "call the office" line just after `afterEl`, replacing any previous
     one. Passing no message removes it — the flows below call this on every
     refresh, so it can't linger once the reason for it is gone. */
  function callOffice(afterEl, message) {
    if (!afterEl) return;
    const existing = afterEl.parentNode && afterEl.parentNode.querySelector(".call-office");
    if (existing) existing.remove();
    if (!message) return;

    const p = document.createElement("p");
    p.className = "call-office";
    p.append(document.createTextNode(message + " "));
    const a = document.createElement("a");
    a.className = "inkline";
    a.href = "tel:" + OFFICE_TEL;
    a.textContent = OFFICE_TEL_TEXT;
    p.append(a);
    afterEl.after(p);
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

  /* "4 hours" for a whole one, "4h 15m" for a shift. Whole hours keep the
     long form so ordinary bookings read exactly as they always have. */
  function durationText(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    if (!m) return `${h} ${h === 1 ? "hour" : "hours"}`;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

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
     Returns "ok" (signed in), "failed" (link dead — say so), "no-account"
     (link valid but the email matches no client), or false. */
  let magicLinkNoAccount = false;
  // The email-proven magic-link token for an account-less session, kept in memory
  // (never stored) so the phone+PIN connect stage can link an existing account to it.
  let connectToken = null;
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
    // A verified link whose email matches no client mints a session that can
    // reach nothing (every account call 401s). Riding it looks signed-in
    // while showing zero bookings — the M Gluck trap. Drop it and steer to
    // phone sign-in instead.
    if (!failed) {
      const c = api.claims();
      if (c && c.type === "client" && !c.client_id) {
        magicLinkNoAccount = true;
        // Keep the proven-email token in memory for the connect stage, but drop
        // the stored session so no other page rides an account-less token.
        connectToken = api.getToken();
        api.setToken(null);
        return "no-account";
      }
    }
    // "ok" only when THIS link signed us in — a failed verify with an old
    // token still stored must report the failure, not ride the corpse.
    return failed ? "failed" : (api.getToken() ? "ok" : false);
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
      colorPrimary: "#DB3694",
      colorBackground: "#EDE3C7",
      colorText: "#175AAA",
      colorDanger: "#DB3694",
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
    // Entering here means a FRESH flow ("Click to hire" / "Book another
    // clean") — an abandoned Change's edit state must not leak into it, or
    // the new booking silently MOVES the old one.
    if (flow.read().edit) flow.patch({ edit: undefined });
    const lede = $(".panel-lede", form);
    const authnote = $(".authnote", form);
    // The restart link ("Use a different email/number"). Selected by id, NOT
    // by .authalt: the connect-PIN feature added #connect-pin-toggle and
    // #connect-no-texts, which also carry .authalt, so a bare $(".authalt")
    // bound this handler to the (hidden) PIN toggle and left the visible
    // restart link dead.
    const authalt = $("#auth-restart", form);
    const authresend = $(".authresend", form);
    const phoneField = $("#signin-phone", form);
    const emailField = $("#signin-email", form);
    const codeField = $("#signin-code", form);
    const nameField = $("#signin-name", form);
    const optEmailField = $("#signin-optemail", form);
    const authfieldsBox = $(".authfields", form);
    const connectBox = $(".authconnect", form);
    const connectPhone = $("#connect-phone", form);
    const connectPin = $("#connect-pin", form);
    const connectPinToggle = $("#connect-pin-toggle", form);
    const connectNoTexts = $("#connect-no-texts", form);
    const codeCallMe = $("#code-call-me", form);
    const smsOptInRow = $("#signin-smsoptin-row", form);
    const smsOptInBox = $("#signin-smsoptin", form);
    const status = $(".formnote", form);

    let pendingPhone = "";
    // The new client's name + PIN, held across the name -> PIN -> (optional) email
    // stages so they all land in one register() call.
    let pendingName = "";
    // True while the code stage is verifying a phone for the email-first CONNECT
    // flow (rather than a plain SMS sign-in) — the confirm endpoint differs.
    let connectOtpMode = false;
    let callMeMode = false;          // "call me instead": phone proven by an answered call, PIN chosen on it
    let callAttemptToken = "";       // opaque handle from /call/send, polled then sent to register
    // The consent that register() sends. Read at submit time (not when the row
    // was shown): only counts when the box is visible-eligible — a phone the
    // token proves by texted code — and actually checked.
    const smsOptedIn = () =>
      !!smsOptInBox && smsOptInBox.checked
      && !callMeMode && !!((api.claims() || {}).phone);
    // Remembers the code that just auto-submitted, so a completed six digits
    // can't fire the verify twice (re-armed only when the field is edited back
    // below six — see the code field's input handler).
    let autoSubmittedCode = "";

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
      if (st === "addemail") return true; // email is optional — Finish works blank or filled
      if (st === "connect")
        return !!connectPhone && digits(connectPhone.value).replace(/^1/, "").length === 10;
      if (st === "connectpin")
        return !!connectPhone && !!connectPin
          && digits(connectPhone.value).replace(/^1/, "").length === 10
          && digits(connectPin.value).length >= 4;
      return false; // "sent" — the inbox is the next step, not this card
    }

    function refreshSubmit() {
      if (!submitBtn) return;
      const st = form.dataset.stage || "start";
      submitBtn.textContent =
        st === "code" ? "Sign in"
        : st === "name" ? "Continue"
        : st === "addemail" ? "Finish"
        : st === "connect" ? "Text me a code"
        : st === "connectpin" ? "Connect my account"
        : emailMode() ? "Email me a sign-in link"
        : "Text me a sign-in code";
      submitBtn.hidden = !stageValid();
    }

    function stage(name) {
      form.dataset.stage = name;
      form.dataset.sent = name === "code" || name === "sent" ? "true" : "false";
      const inStart = name === "start";
      // Two stages share the .authconnect box: `connect` (phone only — text me a
      // code) and `connectpin` (phone + PIN, for customers who booked by phone and
      // can't receive texts). PINs are a voice-channel credential now, so the PIN
      // route is the secondary one behind a disclosure.
      const inConnect = name === "connect" || name === "connectpin";
      if (phoneField) phoneField.hidden = !inStart;
      if (emailField) emailField.hidden = !inStart;
      if (codeField) codeField.hidden = name !== "code";
      if (nameField) nameField.hidden = name !== "name";
      // The texts opt-in rides the two finish-signup stages, but ONLY when the
      // phone was proven by a texted code (the token carries it) — a no-texts
      // signup can't receive them, and the backend enforces the same rule.
      if (smsOptInRow)
        smsOptInRow.hidden = (name !== "name" && name !== "addemail")
          || callMeMode
          || !((api.claims() || {}).phone);
      if (optEmailField) optEmailField.hidden = name !== "addemail";
      if (authswap) authswap.hidden = !inStart;
      if (authfieldsBox) authfieldsBox.hidden = inConnect;
      if (connectBox) connectBox.hidden = !inConnect;
      // Autofill hygiene. Because the card shares one <form> with a password
      // field (#connect-pin), Safari treats the whole thing as a login and
      // offers a SAVED EMAIL on the name field ("what should we call you?").
      // Disable every input not in the current stage: browsers skip disabled
      // fields for autofill, they can't be submitted or focused off-stage, and
      // their .value is still readable in code. So on the name stage nothing
      // login-shaped remains and the browser stops suggesting an email.
      if (phoneField) phoneField.disabled = !inStart;
      if (emailField) emailField.disabled = !inStart;
      if (codeField) codeField.disabled = name !== "code";
      if (nameField) nameField.disabled = name !== "name";
      if (optEmailField) optEmailField.disabled = name !== "addemail";
      if (connectPhone) connectPhone.disabled = !inConnect;
      // The PIN field only exists on the connectpin stage — keeping it enabled on
      // `connect` would put a login-shaped field back on the card and revive the
      // Safari autofill problem the disable pass exists to prevent.
      if (connectPin) connectPin.hidden = name !== "connectpin";
      if (connectPin) connectPin.disabled = name !== "connectpin";
      if (connectPinToggle) connectPinToggle.hidden = name !== "connect";
      if (connectNoTexts) connectNoTexts.hidden = name !== "connect";
      // Phone-first twin of connect-no-texts: only on the plain sign-in code
      // stage — the email-first connect flow offered call-me one screen back.
      if (codeCallMe) codeCallMe.hidden = name !== "code" || connectOtpMode;
      // The call-me intent (and its attempt token) only survives connect -> name.
      // Any other stage change (back to start, etc.) drops it.
      if (name !== "connect" && name !== "name") { callMeMode = false; callAttemptToken = ""; }
      note(status, "");
      refreshSubmit();
      const focus = { start: null, code: codeField, name: nameField, addemail: optEmailField, connect: connectPhone, connectpin: connectPin }[name];
      if (focus) focus.focus();
    }

    [emailField, nameField].forEach((el) => {
      if (el) el.addEventListener("input", refreshSubmit);
    });

    // The verification code submits itself the moment all six digits are in —
    // typed or autofilled from the SMS text — so there's no separate press.
    // Double-verify is prevented two ways: the just-fired code is remembered
    // (autoSubmittedCode) and re-arms only when the field is edited back below
    // six; and the submit still runs through the form-level busy() lock, which
    // refuses re-entry while a verify is in flight (a stray Enter, a second
    // autofill, a fast double keystroke).
    if (codeField) codeField.addEventListener("input", () => {
      const code = digits(codeField.value).slice(0, 6);
      if (codeField.value !== code) codeField.value = code; // keep it to digits
      refreshSubmit();
      if ((form.dataset.stage || "start") !== "code") return;
      if (code.length < 6) { autoSubmittedCode = ""; return; }
      if (code === autoSubmittedCode) return;
      autoSubmittedCode = code;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    form.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.addEventListener("change", refreshSubmit);
    });

    /* Where signing in lands you. Booking is the default; pages that sent the
       visitor here to re-authenticate (my-bookings after the session lapsed)
       say so with ?next= — allowlisted, never echoed blindly. */
    function authDestination() {
      const next = new URLSearchParams(window.location.search).get("next");
      // Mid-flow pages bounce here when a session dies; flow state survives
      // in sessionStorage, so landing back on the same step just works.
      return ["my-bookings", "payments", "day", "time", "review"].includes(next) ? next : "address";
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

    // The connect stage's own phone field wears the same live mask; the PIN is
    // clamped to digits. Both gate the submit button.
    if (connectPhone) connectPhone.addEventListener("input", () => {
      const d = digits(connectPhone.value).replace(/^1/, "").slice(0, 10);
      connectPhone.value =
        d.length > 6 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
        : d.length > 3 ? `(${d.slice(0, 3)}) ${d.slice(3)}`
        : d.length > 0 ? `(${d}`
        : "";
      refreshSubmit();
    });
    if (connectPin) connectPin.addEventListener("input", () => {
      const p = digits(connectPin.value).slice(0, 8);
      if (connectPin.value !== p) connectPin.value = p;
      refreshSubmit();
    });

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    // Came back via a magic link — walk straight on (or say the link is dead).
    handleMagicLinkReturn().then((result) => {
      if (result === "failed") {
        note(status, "That sign-in link is invalid or has already been used — request a new one below.", true);
        return;
      }
      if (result === "no-account") {
        // Email proven but on no account yet. If they've booked by phone before,
        // let them connect that account with phone + PIN (email stays primary).
        if (connectBox && connectToken) {
          if (lede) lede.textContent = "Connect your account";
          if (authnote) authnote.hidden = true;
          if (lede) lede.textContent = "Almost there — what's your phone number?";
          stage("connect");
          // Deliberately covers BOTH outcomes: we don't yet know (and must not
          // reveal, before they prove the number is theirs) whether an account
          // already exists for it.
          note(status, "We couldn't find an account for that email yet. Enter your mobile number and we'll text you a code — we'll connect your bookings if you've cleaned with us before, or finish setting up your account.");
          if (authalt) { authalt.textContent = "Sign in a different way"; authalt.hidden = false; }
        } else {
          note(status, "That email isn't linked to any account yet — sign in with the phone number you used when booking.", true);
        }
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
            if (authresend) authresend.hidden = false;
            stage("code");
            if (lede) lede.textContent = "Almost there — enter the code we texted you.";
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

          if (connectOtpMode) {
            // Email-first: this code proves the phone. The server decides what it
            // means — an existing account gets our verified email attached and we
            // are signed in; no account means we carry on and create one.
            const res = await submitBusy(null, () => api.confirmPhoneOtp(pendingPhone, code, connectToken, true));
            if (!res) return;
            if (res.access_token) api.setToken(res.access_token);
            connectToken = null;
            connectOtpMode = false;
            callAttemptToken = "";
            if (res.linked) {
              magicLinkNoAccount = false;
              return goto(authDestination());
            }
            // No account owned that number — the refreshed token now carries the
            // proven email AND phone, so registration can finish without asking
            // for either again.
            if (lede) lede.textContent = "Lovely to meet you — what should we call you?";
            if (authnote) authnote.hidden = true;
            if (authresend) authresend.hidden = true;
            return stage("name");
          }

          // Same field, same six digits — only the delivery differs. The call-me
          // branch swaps in the voice endpoint; everything after is identical,
          // because a code read down the phone proves exactly what a texted one
          // does.
          if (callAttemptToken) {
            const spoken = await submitBusy(null, () => api.verifyCallCode(callAttemptToken, code));
            if (!spoken) return;
            // callAttemptToken is deliberately kept: register consumes it as the
            // phone's proof, and consuming is what spends the row.
            if (spoken.token) api.setToken(spoken.token);
            const c = api.claims() || {};
            if (c.client_id) {
              // The number already has an account — this was a sign-in.
              callMeMode = false;
              callAttemptToken = "";
              return goto(authDestination());
            }
            callMeMode = true;
            note(status, "");
            if (lede) lede.textContent = "Lovely to meet you — what should we call you?";
            if (authnote) authnote.hidden = true;
            if (authresend) authresend.hidden = true;
            return stage("name");
          }

          const res = await submitBusy(null, () => api.verifySmsOtp(pendingPhone, code));
          // undefined = a second press while the first verify is in flight
          // (busy() refuses re-entry). Walking on regardless navigated away
          // mid-verify, aborting the fetch AFTER the server consumed the
          // code — the customer typed the right code and still got dumped.
          if (!res) return;
          if (res.access_token) api.setToken(res.access_token);
          callAttemptToken = ""; // a texted code that raced the call-me poll won
          await afterAuth();
        } else if (st === "name") {
          const name = nameField.value.trim();
          if (!name) return note(status, "We do need something to call you.", true);
          pendingName = name;

          // "Call me instead" new customer: email already proven (magic link) and
          // the phone proven by the code we read down it. Register consumes the
          // attempt token as that proof and creates the account. No PIN is set
          // here — it stays a voice credential, and the IVR offers to create one
          // the first time they call, which is where it can actually be used.
          if (callMeMode) {
            // register requires a bearer either way — the attempt token only
            // proves the phone. Email-first arrives with the email-proven
            // connectToken (storage was deliberately cleared at magic-link
            // time); phone-first registers with the phone-proven session the
            // answered call issued, which the poll put in storage.
            const res = await submitBusy(null, () => api.register({
              name: pendingName,
              phone: pendingPhone,
              call_attempt_token: callAttemptToken,
              tos_accepted: true,
            }, connectToken || undefined));
            if (!res) {
              return; // busy refused, OR a handled error (e.g. expired verification)
            }
            if (res.access_token) api.setToken(res.access_token);
            callMeMode = false;
            callAttemptToken = "";
            connectToken = null;
            magicLinkNoAccount = false;
            return goto(authDestination());
          }

          // No PIN step: the SMS code already proved this phone. PINs are a
          // voice-channel credential now, created during a call.
          // If the token carries a magic-link-PROVEN email we already have it —
          // don't ask again, just create the account.
          if ((api.claims() || {}).email) {
            const res = await submitBusy(null, () => api.register({
              name: pendingName, phone: (api.claims() || {}).phone || undefined, tos_accepted: true,
              sms_opt_in: smsOptedIn(),
            }));
            if (!res) return;
            if (res.access_token) api.setToken(res.access_token);
            magicLinkNoAccount = false;
            return goto(authDestination());
          }
          if (lede) lede.textContent = "Want to add your email? You'll be able to sign in with it too — optional.";
          stage("addemail");
        } else if (st === "addemail") {
          const optEmail = (optEmailField.value || "").trim();
          if (optEmail && !EMAIL_RE.test(optEmail))
            return note(status, "That doesn't look like an email — leave it blank to skip.", true);
          const claims = api.claims() || {};
          const res = await submitBusy(null, () => api.register({
            name: pendingName,
            email: optEmail || claims.email || undefined,
            phone: claims.phone || undefined, tos_accepted: true,
            sms_opt_in: smsOptedIn(),
          }));
          if (!res) return;
          if (res.access_token) api.setToken(res.access_token);
          goto(authDestination());
        } else if (st === "connect") {
          // Email proven, no account yet: text a code to the number they give us.
          // Whether an account already owns it is decided AFTER the code checks
          // out — never before, or this would answer "does X have an account?".
          const phone = toE164(connectPhone.value);
          if (digits(phone).length !== 11) return note(status, "That phone number doesn't look complete — we need all ten digits.", true);
          if (!connectToken) return note(status, "Your sign-in link expired — request a new one to connect your account.", true);
          const res = await submitBusy(null, () => api.sendPhoneOtp(phone, connectToken));
          if (!res) return; // busy() refused re-entry
          pendingPhone = phone;
          connectOtpMode = true;
          stage("code");
          if (lede) lede.textContent = "Almost there — enter the code we texted you.";
          // stage() wipes the status line and both of these are hidden on the
          // connect arrival — re-show them AFTER it or the caller gets no
          // "we sent a code" line and, worse, no resend link, which strands
          // anyone whose text never arrives or whose code expires.
          if (authnote) {
            authnote.textContent = `We sent a code to ${connectPhone.value.trim()}.`;
            authnote.hidden = false;
          }
          if (authresend) authresend.hidden = false;
        } else if (st === "connectpin") {
          const phone = toE164(connectPhone.value);
          if (digits(phone).length !== 11) return note(status, "That phone number doesn't look complete — we need all ten digits.", true);
          const pin = digits(connectPin.value);
          if (pin.length < 4) return note(status, "Enter the PIN you use when you call us.", true);
          if (!connectToken) return note(status, "Your sign-in link expired — request a new one to connect your account.", true);
          const res = await submitBusy(null, () => api.linkByPin(phone, pin, connectToken));
          if (!res) return; // busy() refused re-entry — a link is already in flight
          if (res.access_token) api.setToken(res.access_token);
          connectToken = null;
          magicLinkNoAccount = false;
          goto(authDestination());
        }
      } catch (err) {
        const code = err && err.code;   // ApiError exposes .code directly (api.js)
        // LinkBlocked / EmailInUse are terminal for this attempt: the OTP was
        // already consumed server-side, so retyping the code can only fail and
        // resending burns the per-phone cap. Get them off the code stage and
        // point at the way out instead of looping.
        if (code === "LinkBlocked" || code === "EmailInUse") {
          connectOtpMode = false;
          if (authresend) authresend.hidden = true;
          if (authnote) authnote.hidden = true;
          if (lede) lede.textContent = "Let's try that another way.";
          stage("connect");
          note(status, formatErr(err), true);
          if (authalt) { authalt.textContent = "Sign in a different way"; authalt.hidden = false; }
          return;
        }
        // Couldn't text that number (landline / unreachable): offer the phone
        // route rather than dead-ending, and reveal the PIN option.
        if (code === "SmsSendFailed" || code === "InvalidPhone") {
          if (connectPinToggle) connectPinToggle.hidden = false;
          note(status, "We couldn't text that number. If it can't receive texts, call us and we'll book you by phone — or if you've booked with us before, connect with your PIN.", true);
          return;
        }
        note(status, formatErr(err), true);
      }
    });

    // "Can't receive texts?" — reveal the PIN route for phone-booked customers.
    if (connectPinToggle) connectPinToggle.addEventListener("click", (e) => {
      e.preventDefault();
      if (lede) lede.textContent = "Connect your account";
      stage("connectpin");
      note(status, "Enter the phone number you booked with and the PIN you use when you call us.");
    });

    // "Can't get texts? We'll call you" — ring the number and READ a code out,
    // which lands on the same code stage the texted one uses. It used to be the
    // other way round (the caller chose a PIN and merely answering was the whole
    // proof), which handed the session to whoever STARTED the call rather than
    // whoever picked up the phone.
    function awaitSpokenCode() {
      callMeMode = true;
      if (authnote) {
        authnote.hidden = false;
        authnote.innerHTML = "We're calling you now — answer and we'll read out a 6-digit code.";
      }
      if (authresend) authresend.hidden = true;
      stage("code");
    }

    if (connectNoTexts) connectNoTexts.addEventListener("click", async (e) => {
      e.preventDefault();
      const phone = toE164(connectPhone.value);
      if (digits(phone).length !== 11)
        return note(status, "First enter the phone number we should call — all ten digits.", true);
      if (!connectToken)
        return note(status, "Your sign-in link expired — request a new one to set up your account.", true);
      const res = await busy(form, null, () => api.startCallVerification(phone).catch(() => null));
      if (!res || !res.attempt_token)
        return note(status, "We couldn't place the call just now. Please try again in a moment.", true);
      pendingPhone = phone;
      callAttemptToken = res.attempt_token;
      note(status, `Calling ${connectPhone.value.trim()} now — answer and we'll read out a 6-digit code.`);
      awaitSpokenCode();
    });

    // Phone-first "call me": the customer asked for a texted code that will
    // never arrive (landline, no-SMS VoIP). Same verification call as the
    // connect-stage link, landing on the same code field the text would have.
    if (codeCallMe) codeCallMe.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!pendingPhone) return;
      const res = await busy(form, null, () => api.startCallVerification(pendingPhone).catch(() => null));
      if (!res || !res.attempt_token)
        return note(status, "We couldn't place the call just now. Please try again in a moment.", true);
      callAttemptToken = res.attempt_token;
      note(status, `Calling ${phoneField.value.trim() || pendingPhone} now — answer and we'll read out a 6-digit code.`);
      awaitSpokenCode();
    });

    if (authalt) authalt.addEventListener("click", (e) => {
      e.preventDefault();
      pendingPhone = "";
      if (codeField) codeField.value = "";
      autoSubmittedCode = "";
      if (authresend) authresend.hidden = true;
      // Reset any connect-stage chrome back to the default sign-in card.
      if (connectPin) connectPin.value = "";
      if (optEmailField) optEmailField.value = "";
      pendingName = "";
      connectOtpMode = false;
      if (lede) lede.textContent = "Sign in or create an account to get started.";
      if (authnote) authnote.hidden = false;
      authalt.textContent = "Use a different email";
      stage("start");
    });

    // SMS can lag or vanish; a fresh code is one tap, not a restart. A short
    // client-side cooldown keeps tap-tap-tap from burning the server's
    // send cap (3 codes per 10 minutes) — and only the NEWEST code verifies,
    // which the confirmation line says out loud.
    let lastResendAt = 0;
    if (authresend) authresend.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!pendingPhone) return;
      if (Date.now() - lastResendAt < 30 * 1000) {
        return note(status, "A new code is already on its way — give it a few more seconds.", false);
      }
      await busy(authresend, "Sending…", async () => {
        try {
          if (connectOtpMode) await api.sendPhoneOtp(pendingPhone, connectToken);
          else await api.sendSmsOtp(pendingPhone);
          lastResendAt = Date.now();
          if (codeField) codeField.value = "";
          autoSubmittedCode = "";
          refreshSubmit();
          note(status, "New code sent — use the newest text.", false);
        } catch (err) {
          note(status, formatErr(err), true);
        }
      });
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
    // Same stale-edit guard as step-1: the address page is never part of a
    // Change (edits go day → time → review), so arriving here means a fresh
    // booking flow.
    if (flow.read().edit) flow.patch({ edit: undefined });
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
    }).catch((err) => {
      // A dead session here used to fall back silently to the bare manual
      // form — which reads as "my addresses are gone". A 401 means the token
      // died server-side (api.js just cleared it): go sign in; that flow
      // returns here with the account loaded. Anything else (offline, older
      // backend) keeps the manual fields as the graceful floor.
      if (err && (err.status === 401 || err.code === "InvalidToken")) return goto("sign-in");
    });

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

    if (flow.read().edit) note(status, "Changing your cleaning — pick the new day.");
    const prevBtn = $(".cal-nav-prev", panel);
    const nextBtn = $(".cal-nav-next", panel);

    const today = avail.todayKey();
    let [year, month] = today.split("-").map(Number);
    let selected = flow.read().date || "";
    // Blackout dates from booking rules, filled after the first paint. `bookableFrom`
    // is the earliest open day (yyyy-mm-dd) — days before it are disabled and the
    // calendar opens on its month. `blockedRanges` are the office's closed spans
    // ({start,end} inclusive); any day inside one is disabled too.
    let bookableFrom = "";
    let blockedRanges = [];
    const isBlocked = (k) => blockedRanges.some((r) => r.start <= k && k <= r.end);
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
        // Blackout — days before the earliest bookable date, or inside a closed
        // range, are unpickable.
        if (bookableFrom && cell.dateKey < bookableFrom) b.disabled = true;
        if (isBlocked(cell.dateKey)) b.disabled = true;
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

    // Blackout: pull the closed ranges + earliest bookable date from booking rules,
    // disable those days, drop a now-invalid selection, and open on the first
    // bookable month so the calendar doesn't land on a month with nothing to pick.
    api.bookingRules().then((r) => {
      if (!r) return;
      blockedRanges = Array.isArray(r.blocked_dates)
        ? r.blocked_dates.filter((x) => x && x.start && x.end)
        : [];
      // min_bookable_date is the general-feature field; bookable_from is its alias
      // for older responses.
      const bf = r.min_bookable_date || r.bookable_from;
      if (bf) {
        bookableFrom = bf;
        if (bf.slice(0, 7) > `${year}-${String(month).padStart(2, "0")}`) {
          [year, month] = bf.split("-").slice(0, 2).map(Number);
        }
      }
      // Drop a selection that's now before the floor or inside a closed range.
      if (selected && ((bookableFrom && selected < bookableFrom) || isBlocked(selected))) {
        selected = "";
        flow.patch({ date: "" });
      }
      render();
    }).catch(() => {});
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
    // Both the question and the -/+ control carry the marker: querySelector
    // would take only the first, which is how the stepper stayed on screen
    // under the pilot while its label disappeared.
    const hoursLine = panel.querySelectorAll("[data-hours-line]");
    const hoursValue = $("[data-hours-value]", panel);
    // Language filters WHO counts as free — changing it refetches the slots.
    // While EDITING, the picker only counts once the customer actually touches
    // it: the flow default (English) says nothing about what language the
    // booking was made in, and sending it unasked could swap a Spanish-speaking
    // lady off a booking made by phone. A deliberate pick, though, rides the
    // modify body so the backend reassigns the visit to a speaker.
    let editLanguageChosen = null;
    const languageEl = $("#booking-language", panel);
    if (languageEl) {
      languageEl.value = flow.read().language || "English";
      flow.patch({ language: languageEl.value });
      languageEl.addEventListener("change", () => {
        flow.patch({ language: languageEl.value });
        if (editing) {
          editLanguageChosen = languageEl.value;
          // The language rides the modify body, so a pending "Confirm change"
          // must not apply a body the customer never previewed — same rule as
          // the slot click and the hours stepper.
          invalidatePreview();
        }
        refreshSlots();
      });
    }
    // Draws the eye to the picker when the no-availability note names it —
    // the note exists precisely because people didn't know the picker did.
    function nudgeLanguagePicker() {
      const field = languageEl && languageEl.closest(".field");
      if (!field) return;
      field.classList.remove("field--look-here");
      void field.offsetWidth; // restart the pulse when the note repeats
      field.classList.add("field--look-here");
    }
    // …and comes OFF whenever the note stops naming it. The animated pulse
    // self-expires, but the reduced-motion fallback is a static marker that
    // would otherwise stay pinned to the select for the rest of the session.
    function clearLanguageNudge() {
      const field = languageEl && languageEl.closest(".field");
      if (field) field.classList.remove("field--look-here");
    }
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

    /* Fixed-shift days (the full-day / half-day pilot) come back from the API as
       whole shifts rather than start times: each slot carries the office's name
       for it and its own exact length. The length is the SHIFT's, not the
       stepper's — a half day is 4h15m, which the stepper cannot even express —
       so a shift click overrides both. */
    function shiftMode() {
      return slots.some((s) => s.shift_label);
    }

    /* Is the chosen day under the pilot at all? `shiftMode()` reads the slots,
       which is no help when every shift is already taken — an empty grid then
       has to say "they're all booked", not "nobody works that day". The rules
       payload answers it independently of who's free. */
    function isShiftDate(dateStr) {
      const windows = (rules && rules.fixed_shifts) || [];
      if (!windows.length || !dateStr) return false;
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
        new Date(dateStr + "T12:00:00").getDay()
      ];
      return windows.some((w) =>
        dateStr >= w.start_date &&
        dateStr <= w.end_date &&
        (!w.days_of_week || !w.days_of_week.length || w.days_of_week.includes(day)));
    }

    /* The stepper picks a length; a shift already has one. Showing "4 hours"
       next to a 4h15m half day would just be wrong, so the whole line goes. */
    function applyShiftChrome() {
      const shifts = shiftMode() || isShiftDate(state.date);
      hoursLine.forEach((el) => { el.hidden = shifts; });
      return shifts;
    }

    function renderSlots() {
      grid.innerHTML = "";
      const shifts = shiftMode();
      slots.forEach((slot) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = shifts ? "choice choice--shift" : "choice";
        if (shifts) {
          const name = document.createElement("span");
          name.className = "choice__label";
          name.textContent = slot.shift_label;
          const when = document.createElement("span");
          when.className = "choice__when";
          when.textContent = `${slot.start_formatted || slot.start_time} – ${slot.end_formatted || slot.end_time}`;
          b.append(name, when);
        } else {
          b.textContent = slot.start_formatted || slot.start_time;
        }
        if (slot.start_time === selectedStart) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          selectedStart = slot.start_time;
          // On a shift day the booking's length comes off the slot. `hours` is
          // kept in step so anything still reading it (the estimate line, the
          // saved record) stays honest, but `minutes` is what gets sent.
          if (slot.duration_minutes) {
            hours = Math.round(slot.duration_minutes / 60);
            renderHours();
          }
          flow.patch({
            slot,
            hours,
            minutes: slot.duration_minutes || null,
          });
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
        const lang = (languageEl && languageEl.value) || "English";
        const fresh = (await api.availableSlots(state.date, hours, lang)) || [];
        if (req !== slotsReq) return;
        slots = fresh;
        const onShiftDay = applyShiftChrome();

        // The pilot: this day is sold as whole shifts, so say what's on offer
        // and give anyone who wants other hours a number to ring. The office
        // books those by hand — this is the only route to them.
        if (onShiftDay) {
          clearLanguageNudge();
          const stale = $(".slots-day-link", panel || document);
          if (stale) stale.remove();
          note(status, slots.length
            ? "That day we're booking full and half days only — pick one."
            : "Every shift that day is taken.", !slots.length);
          callOffice(grid, slots.length
            ? "Need different hours?"
            : "For another day, or different hours, call us on");
          if (!slots.some((s) => s.start_time === selectedStart)) {
            selectedStart = "";
            flow.patch({ slot: null, minutes: null });
          }
          renderSlots();
          return;
        }
        callOffice(grid, "");

        if (!slots.length) {
          // The dead-end an empty grid used to hide: with the picker sitting
          // on its English default, a day covered only by Spanish speakers
          // read as "no one is free" — and nobody connects that to a language
          // dropdown they never touched. Probe each OTHER offered language
          // (the IVR's language fallback makes the same move) so the advice
          // can name a pick that provably works. Per-language on purpose: an
          // unfiltered query also counts ladies with no language recorded,
          // which would promise a switch no picker option can deliver.
          // Applies while editing too: a deliberate pick rides the modify
          // body (editLanguageChosen), so the advice is actionable there.
          let betterLanguages = [];
          if (languageEl && languageEl.options.length > 1) {
            const others = Array.from(languageEl.options, (o) => o.value)
              .filter((v) => v !== lang);
            const found = await Promise.all(others.map((other) =>
              api.availableSlots(state.date, hours, other)
                .then((s) => ((s || []).length ? other : null))
                .catch(() => null)));
            if (req !== slotsReq) return;
            betterLanguages = found.filter(Boolean);
          }
          // Say only things this page can actually do: another language when
          // that provably helps; fewer hours when the stepper isn't at
          // minimum; another day means /day.
          if (betterLanguages.length) {
            note(status, `No ${lang}-speaking lady is free that day — but a lady who speaks ${betterLanguages.join(" or ")} is. Choose a different language under “Your lady speaks”, or pick another day.`, true);
            nudgeLanguagePicker();
          } else {
            clearLanguageNudge();
            const who = lang === "English" ? "No one" : `No one who speaks ${lang}`;
            note(status, hours > rules.min_hours
              ? `${who} is free that day for that long — try fewer hours, or pick another day.`
              : `${who} is free that day — pick another day.`, true);
          }
          if (!$(".slots-day-link", panel || document)) {
            const back = document.createElement("button");
            back.type = "button";
            back.className = "choice slots-day-link";
            back.textContent = "Pick another day";
            back.addEventListener("click", () => goto("day"));
            grid.after(back);
          }
        } else {
          note(status, "");
          clearLanguageNudge();
          const stale = $(".slots-day-link", panel || document);
          if (stale) stale.remove();
        }
        if (!slots.some((s) => s.start_time === selectedStart)) { selectedStart = ""; flow.patch({ slot: null }); }
        renderSlots();
      } catch (err) {
        if (err && err.status === 401) return goto("sign-in?next=time");
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
        // Moving a booking onto a fixed-shift day means taking a whole shift —
        // send its exact minutes, not the stepper's whole hours.
        if (st.minutes) body.duration_minutes = st.minutes;
        // A booking made by phone can be a half-hour length the stepper can't
        // express — keep its EXACT minutes unless the customer deliberately
        // changed the hours (then whole hours are what they chose).
        if (editing.minutes && editing.minutes !== editing.hours * 60 && hours === editing.hours) {
          body.duration_minutes = editing.minutes;
        }
        if (editing.recurring) body.recurring_scope = "selected_only";
        if (editLanguageChosen) body.language = editLanguageChosen;
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
              else if (p.cleaner_language_mismatch) bits.push(`Your usual lady doesn't speak ${editLanguageChosen} — if a lady who does is free, she'll take this visit.`);
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
      // Cleaner languages are configured in the dashboard, so the picker is
      // built from what the API reports rather than a list shipped here that
      // would drift the moment the office added one.
      if (languageEl && r && Array.isArray(r.languages) && r.languages.length) {
        const chosen = flow.read().language;
        languageEl.innerHTML = "";
        r.languages.forEach((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          languageEl.appendChild(opt);
        });
        // Keep the customer's pick if it's still offered, else fall to the first.
        languageEl.value = r.languages.includes(chosen) ? chosen : r.languages[0];
        flow.patch({ language: languageEl.value });
      }
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

    /* Back from all-set restores this page from the back-forward cache: the
       DOM, `state` and an armed Confirm all return exactly as they were, and
       initStep5 does NOT re-run — so the guard above never fires. all-set has
       cleared the flow by then, so a press re-sent the identical booking and
       the customer met an overlap warning about a clash with their OWN
       booking, with nothing anywhere saying the first one had worked
       (2026-08-09). Answer the question they actually have. */
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      const live = flow.read();
      if (live.date && live.slot && live.hours) return;
      if (confirmBtn) {
        confirmBtn.setAttribute("aria-disabled", "true");
        
        confirmBtn.textContent = "Already booked";
      }
      note(status, "This booking is already confirmed — you don't need to send it again.", true);
      callOffice(status, "Something not right? Call us on");
    });
    const payList = $(".paylist", panel);
    const stripeBox = $(".stripe-box", panel);
    const notesEl = $("#booking-notes", panel);
    const freq = state.frequency_weeks || 0;

    // Special instructions and language ride the flow state so
    // back-navigation keeps them.
    if (notesEl) {
      notesEl.value = state.notes || "";
      notesEl.addEventListener("input", () => flow.patch({ notes: notesEl.value }));
    }


    if (freq > 0) {
      // A series never charges at confirm — each visit is billed to the chosen
      // card as its date approaches. Say so where the card is picked.
      const payNote = document.createElement("p");
      payNote.className = "paynote";
      payNote.textContent = "Nothing is charged today — each visit is billed to this card around the time of the cleaning.";
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

    // The credit choice — two pick-cells under the summary. Default: spend
    // credit first (what nearly everyone wants); the alternative keeps the
    // balance untouched and bills the card in full.
    function renderCreditChoice() {
      let box = $(".creditpick", panel);
      if (!box) {
        const line = document.createElement("p");
        line.className = "creditpick-line";
        line.textContent = "Your gift credit:";
        box = document.createElement("div");
        box.className = "creditpick";
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", "Use gift credit");
        review.after(line, box);
      }
      box.innerHTML = "";
      [{ on: true, label: freq > 0 ? "Use it toward visits" : "Use it now" },
       { on: false, label: "Save it for later" }].forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = c.label;
        if (useCredit === c.on) { b.classList.add("is-on"); b.setAttribute("aria-pressed", "true"); }
        b.addEventListener("click", () => {
          if (useCredit === c.on) return;
          useCredit = c.on;
          loadEstimate().catch(onEstimateError);
        });
        box.appendChild(b);
      });
    }

    async function loadEstimate() {
      // Re-pricing means something about the booking moved (time, length, credit,
      // cleaner). Whatever was confirmed a moment ago was confirmed about the OLD
      // booking, so the confirmation doesn't carry over.
      disarmDoubleBooking();
      const est = await api.estimate({ date: state.date, start_time: state.slot.start_time, hours: state.hours, duration_minutes: state.minutes || undefined, address_id: state.address_id, preferred_cleaner_id: state.preferred_cleaner_id, use_credit: useCredit, language: state.language || undefined });
      review.innerHTML = "";
      review.removeAttribute("aria-busy");
      // Remember the credit available even after toggling it off (the estimate
      // reports 0 then) so the choice row stays visible.
      if (est.credit_applied > 0) creditAvailable = est.credit_applied;
      reviewRow("When", `${designDate(state.date)}, ${state.slot.start_formatted || state.slot.start_time}`);
      if (freq > 0) reviewRow("Repeats", freq === 1 ? `Every ${weekdayName(state.date)}` : `Every ${freq} weeks on ${weekdayName(state.date)}s`);
      if (state.preferred_cleaner_name) reviewRow("Your lady", state.preferred_cleaner_name);
      reviewRow("Where", formatAddress(state.address) || "Your saved address");
      // A fixed shift is 4h15m or 4h30m, and `hours` is a whole number — it
      // rounded the morning DOWN to "4 hours" and the afternoon UP to "5",
      // describing a booking the customer was not making. Minutes are the
      // truth; the total was always the backend's and stays untouched.
      reviewRow("What", `Home cleaning · ${durationText(state.minutes || (est.hours || state.hours) * 60)} (${money(est.rate_per_hour)}/hr)`);
      if (state.language && state.language !== "English") reviewRow("She speaks", state.language);
      if (est.taxi_fee > 0) reviewRow("Travel fee", money(est.taxi_fee));
      // Gift credit spends before the card BY DEFAULT — one-time cleans at
      // create, recurring visits at each charge — unless the customer flips
      // the choice below. The bold number is what the card REALLY pays.
      if (est.credit_applied > 0) {
        reviewRow("Total", money(est.total_amount));
        reviewRow("Gift credit", `−${money(est.credit_applied)}${freq > 0 ? " per visit while it lasts" : ""}`);
        reviewRow("Your card pays", money(est.amount_due), "review-total");
      } else {
        reviewRow(freq > 0 ? "Total per visit" : "Total", money(est.total_amount), "review-total");
      }
      if (creditAvailable > 0) renderCreditChoice();
      coveredByCredit = freq === 0 && useCredit && est.credit_applied > 0 && est.amount_due === 0;
      // This runs on every estimate reload (the credit toggle re-estimates),
      // so both directions must be handled: hiding the payment section when
      // credit covers everything AND bringing it back when the customer
      // flips to "save it for later" — leaving it hidden dead-ended new
      // customers on an invisible card form.
      const payTitle = $(".pay-title", panel);
      const coveredNote = $(".paynote", panel);
      if (coveredByCredit) {
        if (payTitle) payTitle.hidden = true;
        payList.hidden = true;
        stripeBox.hidden = true;
        if (!coveredNote) {
          const covered = document.createElement("p");
          covered.className = "paynote";
          covered.textContent = "No card needed — your gift credit covers this cleaning.";
          payList.before(covered);
        }
      } else {
        if (payTitle) payTitle.hidden = false;
        payList.hidden = false;
        stripeBox.hidden = selectedPm !== "new";
        if (coveredNote) coveredNote.remove();
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
        // One failed fetch used to permanently brick Confirm behind "Add a
        // card first" with NO card UI on screen — always leave a way back in.
        if (err && err.status === 401) return goto("sign-in?next=review");
        note(status, formatErr(err), true);
        payList.innerHTML = "";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "choice choice--pay";
        retry.innerHTML = "<span>Couldn't load your cards — tap to try again</span>";
        retry.addEventListener("click", () => { note(status, ""); loadMethods(); });
        payList.appendChild(retry);
      }
    }

    /* A new card becomes a saved payment method BEFORE booking: confirm the
       SetupIntent, then tell the backend about the resulting pm id. */
    // A card that passed Stripe's confirmSetup but whose save-to-account call
    // failed. The SetupIntent is spent, so re-confirming it errors forever —
    // the retry must re-attempt ONLY the save, with the same pm id.
    let pendingSavePmId = null;

    async function ensurePaymentMethod() {
      if (selectedPm && selectedPm !== "new") return selectedPm;
      if (pendingSavePmId) {
        const pmId = pendingSavePmId;
        const saved = await api.addPaymentMethod(pmId);
        pendingSavePmId = null;
        selectedPm = pmId;
        if (saved && saved.payment_method_id) {
          methods.push(saved);
          stripeBox.hidden = true;
          renderMethods();
        }
        return pmId;
      }
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
      let saved;
      try {
        saved = await api.addPaymentMethod(pmId);
      } catch (err) {
        pendingSavePmId = pmId;
        throw new Error("Your card was verified but we couldn't finish adding it — press Confirm again to continue.");
      }
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
      // The flow is cleared the moment a booking lands (all-set does it), so an
      // empty one here means this page is a back-navigation onto a booking that
      // already exists. Checked in the handler, not just on the button: the
      // button is an <a>, so `disabled` does nothing and the click listener
      // fires regardless of how it looks.
      const live = flow.read();
      if (!live.date || !live.slot || !live.hours) {
        note(status, "This booking is already confirmed — you don't need to send it again.", true);
        return;
      }
      if (!estimateOk) return note(status, "Hold on — still fetching your price.", true);
      await busy(confirmBtn, "Booking…", async () => {
        try {
          note(status, "");
          // Fully-credited one-time cleans need no card at all — the backend
          // charges nothing. Everything else (incl. every series) collects one.
          const pmId = coveredByCredit ? undefined : await ensurePaymentMethod();
          const notes = (notesEl && notesEl.value.trim()) || undefined;
          const language = state.language || "English";
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
              allow_overlap: overlapOk || undefined,
              use_credit: useCredit,
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
            // Resume-first: if an earlier press already CREATED a booking and
            // entered the 3-D Secure dance, finish THAT one — re-running
            // api.book would mint a second booking (and the overlap warning's
            // "book it anyway" would then talk the customer into confirming
            // the duplicate).
            let pendingConfirm = null;
            try { pendingConfirm = JSON.parse(sessionStorage.getItem(PENDING_CONFIRM_KEY) || "null"); } catch { /* noop */ }
            let final = null;
            let bookedId = null;
            if (pendingConfirm && pendingConfirm.booking_id) {
              bookedId = pendingConfirm.booking_id;
              final = await finishThreeDs(pendingConfirm.booking_id, pendingConfirm.client_secret);
              if (!final) return; // message shown; the pending marker decides the next press
            } else {
              const result = await api.book({
                date: state.date,
                start_time: state.slot.start_time,
                hours: state.hours,
                // A fixed shift is an exact window (a half day is 4h15m), so its
                // minutes are what count — `hours` alone would book the wrong end.
                duration_minutes: state.minutes || undefined,
                payment_method_id: pmId,
                language,
                notes,
                address_id: state.address_id,
                preferred_cleaner_id: state.preferred_cleaner_id,
                accept_substitute: preferredBusy || undefined,
                allow_overlap: overlapOk || undefined,
                use_credit: useCredit,
              });
              bookedId = result.booking_id;
              final = result;
              if (result && result.requires_action) {
                sessionStorage.setItem(PENDING_CONFIRM_KEY, JSON.stringify({
                  booking_id: result.booking_id,
                  client_secret: result.payment_intent_client_secret,
                }));
                final = await finishThreeDs(result.booking_id, result.payment_intent_client_secret);
                if (!final) return;
              }
            }
            record = {
              id: final.id || bookedId,
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
          // The same-client overlap gate: surface the clash and arm a second
          // press to book anyway (mirrors the busy-cleaner heads-up).
          if (err && err.code === "ClientBookingOverlap" && !overlapOk) {
            armDoubleBooking(err.message);
            return;
          }
          // The fixed-shift pilot. Reaching here means the hours stopped being
          // sellable between picking them and confirming — the office changed
          // the shifts, or the tab sat open through the change. The backend's
          // message lists what IS on offer; the only way to the rest is a phone
          // call, so give them a number they can press.
          if (err && err.code === "FixedShiftRequired") {
            note(status, err.message, true);
            callOffice(status, "To book other hours, call us on");
            return;
          }
          note(status, formatErr(err), true);
        }
      });
    }

    let overlapOk = false;

    /* Booking on top of a cleaning you already have is legitimate — two cleaners
       at once is a real thing people want — but it is never what someone means by
       accident, so it takes a second, deliberate press.

       The confirmation lives on the BUTTON, not only in a line of text. A status
       note under the control is easy to skim past on a phone, and the earlier
       wording ("press again to book it anyway") asked for a second press without
       ever saying what the first one had run into. Relabelling the action states
       the unusual thing it is about to do, right where the thumb is going. */
    const confirmLabel = confirmBtn ? confirmBtn.textContent : "";

    function armDoubleBooking(clash) {
      overlapOk = true;
      if (confirmBtn) {
        confirmBtn.textContent = "Yes — send both";
        confirmBtn.classList.add("btn--confirm-double");
      }
      // Says the consequence in the customer's terms — two cleaners in their
      // home — rather than the system's word for it ("overlap").
      note(status, `${clash} Booking this one means two cleaners at your home at the same time.`, true);
    }

    /* Any change to WHAT is being booked disarms it. Otherwise a customer who
       armed the confirmation, then went back and moved the time, would silently
       double-book the new slot without ever being asked about it. */
    function disarmDoubleBooking() {
      if (!overlapOk) return;
      overlapOk = false;
      if (confirmBtn) {
        confirmBtn.textContent = confirmLabel;
        confirmBtn.classList.remove("btn--confirm-double");
      }
      note(status, "");
    }
    let useCredit = true;
    let creditAvailable = 0;

    // Survives a failed press: the booking id + client secret of a 3-D Secure
    // attempt that hasn't reached confirmed yet. Cleared only on success or a
    // definitive card decline — anything in between resumes instead of
    // creating a second booking.
    const PENDING_CONFIRM_KEY = "madame_pending_confirm";

    // The 3-D Secure tail. Returns the confirmed booking, or null after
    // showing the customer what to do next. The pending marker is the
    // contract: while it exists, the next Confirm press finishes THIS
    // attempt; once cleared, the next press starts fresh.
    async function finishThreeDs(bookingId, clientSecret) {
      if (clientSecret) {
        await ensureStripe();
        const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, undefined, { handleActions: true });
        // A replayed secret whose challenge already finished comes back as an
        // "unexpected state" error carrying the (authorised) intent — that's
        // success for us, so judge by the intent, not the error.
        const pi = paymentIntent || (error && error.payment_intent);
        const authorised = pi && (pi.status === "requires_capture" || pi.status === "succeeded");
        if ((error && !authorised) || (!error && pi && !authorised)) {
          sessionStorage.removeItem(PENDING_CONFIRM_KEY);
          note(status, `${(error && error.message) || "Your bank didn't approve the payment."} That attempt is set aside and won't be charged — press Confirm to try again (you can pick a different card).`, true);
          return null;
        }
      }
      try {
        const final = await api.confirmPayment(bookingId);
        sessionStorage.removeItem(PENDING_CONFIRM_KEY);
        return final;
      } catch (err) {
        // The money side is done (authorised); only our confirm call failed.
        // Keep the marker so the next press retries JUST this step — the
        // backend replays it idempotently, so pressing again can't double-book
        // or double-charge.
        note(status, "Your payment went through, but we couldn't finish confirming the booking — press Confirm once more to complete it. You won't be charged twice.", true);
        return null;
      }
    }
    confirmBtn.addEventListener("click", (e) => { e.preventDefault(); confirmBooking(); });

    // A failed estimate used to leave the static placeholder review on screen
    // and Confirm permanently answering "still fetching your price" — no
    // retry, no way forward. Clear the fake rows, say what happened, offer
    // the way back in; a dead session goes to sign-in instead (flow state
    // survives in sessionStorage, so they land right back here).
    function onEstimateError(err) {
      if (err && err.status === 401) return goto("sign-in?next=review");
      review.innerHTML = "";
      note(status, `${formatErr(err)} Your price couldn't be loaded.`, true);
      if (!$(".estimate-retry", panel)) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "choice estimate-retry";
        retry.textContent = "Tap to load your price again";
        retry.addEventListener("click", () => {
          retry.remove();
          note(status, "");
          loadEstimate().catch(onEstimateError);
        });
        review.after(retry);
      }
    }

    // A redirect-based payment method (bank wallets and friends) leaves the
    // page during confirmSetup and comes BACK here with the result in the
    // URL. Finish what the redirect started — dropping it silently forced
    // the customer to re-enter a method that had already verified.
    async function handleSetupRedirect() {
      const params = new URLSearchParams(location.search);
      const secret = params.get("setup_intent_client_secret");
      if (!secret) return;
      ["setup_intent", "setup_intent_client_secret", "redirect_status"].forEach((k) => params.delete(k));
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      try {
        await ensureStripe();
        const { setupIntent } = await stripe.retrieveSetupIntent(secret);
        if (!setupIntent || setupIntent.status !== "succeeded") {
          if (setupIntent && setupIntent.status === "requires_payment_method")
            note(status, "That payment method didn't go through — pick a card below and try again.", true);
          return;
        }
        const pmId = typeof setupIntent.payment_method === "string"
          ? setupIntent.payment_method
          : setupIntent.payment_method && setupIntent.payment_method.id;
        if (!pmId) return;
        try {
          const saved = await api.addPaymentMethod(pmId);
          selectedPm = pmId;
          if (saved && saved.payment_method_id) methods.push(saved);
          stripeBox.hidden = true;
          renderMethods();
          note(status, "Payment method added — press Confirm to book.", false);
        } catch {
          // Same resume rule as a failed save after confirmSetup: the intent
          // is spent, so the next Confirm retries ONLY the save.
          pendingSavePmId = pmId;
          note(status, "Your payment method was verified — press Confirm to finish.", false);
        }
      } catch { /* leave the normal pay UI in charge */ }
    }

    loadEstimate().catch(onEstimateError);
    loadMethods().then(handleSetupRedirect);
  }

  /* ================================================================
     STEP 6 — say what actually got booked.
     ================================================================ */
  function initStep6() {
    const state = flow.read();
    const sub = $(".subhead");
    if (state.booking && sub) {
      sub.innerHTML = state.booking.recurring
        ? `Your regular cleaning is booked — <strong>${freqPhrase(state.booking.recurring)}</strong>, starting <strong>${designDate(state.booking.date)}</strong> at <strong>${state.booking.start}</strong>. We've sent the details to your phone.`
        : `Your booking is confirmed. We've sent the details to your phone — your cleaner will be there <strong>${designDate(state.booking.date)}</strong> at <strong>${state.booking.start}</strong>.`;
    } else if (sub) {
      // Landed here without a just-completed flow (direct visit, stale tab)
      // — the static "pulling up your details" line would read as a hung
      // confirmation, so point at the real list instead.
      sub.innerHTML = `Nothing was just booked on this device. <a class="inkline" href="my-bookings">See my bookings</a> for what's scheduled.`;
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
    function rowFor(r) {
      const li = document.createElement("li");
      li.className = "booking";
      const when = document.createElement("span");
      when.className = "booking-when";
      when.innerHTML = `<strong>${shortDate(r.date)}</strong> · ${r.start}`;
      const what = document.createElement("span");
      what.className = "booking-what";
      const lenH = r.minutes ? (r.minutes % 60 ? (r.minutes / 60).toFixed(1).replace(/\.0$/, "") : r.minutes / 60) : r.hours;
      what.textContent = `Home cleaning · ${lenH}h${r.amount ? ` · ${money(r.amount)}` : ""}${r.recurring ? ` · ${freqPhrase(r.recurring)}` : ""}`;
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

    // First paint / signed-out fallback shows only rows that can still be
    // "Upcoming" — past-dated device records were rendering under that
    // heading until (or unless) the reconcile hid them.
    const localTodayKey = easternTodayKey();
    records = records.filter((r) => r.date >= localTodayKey);
    renderList(records, "No bookings on this device yet — your next cleaning will show up here.");

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
        flow.patch({ edit: { id: r.id, hours: r.hours, minutes: r.minutes || r.hours * 60, recurring: !!r.recurring }, hours: r.hours });
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
        } catch (err) {
          // The preview is the ONLY place the late-cancellation fee is
          // disclosed, and the backend charges it regardless of what was
          // shown — cancelling blind can cost $25 with zero warning. Stop
          // here instead of proceeding without the number.
          if (err && err.status === 401) { offerSignin(); return; }
          const warn = document.createElement("span");
          warn.className = "booking-confirm";
          warn.textContent = "Couldn't check whether a cancellation fee applies — nothing was cancelled. Please try again in a moment.";
          actions.appendChild(warn);
          setTimeout(() => warn.remove(), 7000);
          return;
        }
        const strip = document.createElement("span");
        strip.className = "booking-confirm";
        const q = document.createElement("span");
        q.textContent = r.recurring
          ? `Cancel just this visit, or the whole series from here?${feeLine}`
          : `Cancel this cleaning?${feeLine}`;

        // One cancel per press: the chosen scope goes to the backend, which
        // owns the semantics (selected_only = exception on that date;
        // selected_and_future = the series ends at that visit).
        const cancelButtons = [];
        function cancelBtn(label, scope) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "booking-act booking-act--cancel";
          b.textContent = label;
          b.addEventListener("click", async () => {
            cancelButtons.forEach((x) => { x.disabled = true; });
            try {
              await api.cancelBooking(r.id, scope);
              if (scope === "selected_and_future") {
                // Sibling visits of this series must vanish too — refetch.
                window.location.reload();
                return;
              }
              li.classList.add("booking--cancelled");
              const what = li.querySelector(".booking-what");
              if (what) what.textContent += " · cancelled";
              actions.remove();
            } catch (err) {
              q.textContent = formatErr(err);
              cancelButtons.forEach((x) => { x.disabled = false; });
            }
          });
          cancelButtons.push(b);
          return b;
        }

        const no = document.createElement("button");
        no.type = "button";
        no.className = "booking-act";
        no.textContent = "Keep it";
        // "Keep it" closes the prompt and brings the trigger back. (Inline style,
        // not [hidden], because .booking-act is display:inline-flex under 760px,
        // which would beat the hidden attribute.)
        no.addEventListener("click", () => { strip.remove(); cancel.style.display = ""; });

        if (r.recurring) {
          strip.append(q,
            cancelBtn("Just this visit", undefined),
            cancelBtn("This + all future visits", "selected_and_future"),
            no);
        } else {
          strip.append(q,
            cancelBtn(feeLine ? "Yes, cancel & pay the fee" : "Yes, cancel", undefined),
            no);
        }
        // Tuck the trigger "Cancel" away while its own confirmation is open — a
        // second "Cancel" sitting next to "Yes, cancel" is dead (this handler
        // no-ops once the strip exists) and reads as a duplicate.
        cancel.style.display = "none";
        actions.appendChild(strip);
        strip.scrollIntoView({ block: "nearest" });
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
      btn.addEventListener("click", () => goto("sign-in?next=my-bookings"));
      // The sentence IS the link — a trailing "Sign in" button next to a line
      // that already says "Sign in to see them" is the same action twice. Only
      // the actionable clause is clickable; the lead-in stays plain text.
      const [lead, act] = magicLinkNoAccount
        ? ["That email isn't linked to any account yet — ", "sign in with the phone number you used when booking."]
        : records.length
          ? ["", "Sign back in to change or cancel a cleaning."]
          : ["Have cleanings booked? ", "Sign in to see them."];
      btn.textContent = act;
      p.append(lead, btn);
      list.before(p);
    }

    if (!hasLiveSession()) {
      offerSignin();
      return;
    }

    // Signed in — reveal the quiet link through to the full payment history
    // (its own /payments page, so this panel stays about upcoming cleans).
    const payLink = $(".paylink");
    if (payLink) payLink.hidden = false;

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
        // "Today" is the business's day (Eastern), not the browser's — a
        // customer checking from another timezone must see the same cutoff
        // the fees and the backend use.
        const todayKey = easternTodayKey();
        // The panel says Upcoming and means it: only scheduled, today-or-
        // future cleans. Cancelled and completed history stays off the list
        // (the office dashboard is the archive).
        const ordered = ((server && server.bookings) || []).map((b) => ({
          id: b.id,
          date: b.date,
          start: b.start_time,
          hours: b.hours,
          minutes: b.duration_minutes || (b.hours * 60),
          amount: b.amount,
          recurring: b.frequency_weeks || 0,
          status: b.status,
        })).filter((r) => r.status === "scheduled" && r.date >= todayKey);
        renderList(ordered, "No upcoming cleanings — book your next one below.");
        // Every row is ONE visit, so per-row actions are unambiguous: a
        // recurring row's Change/Cancel touches that visit only (the backend
        // scopes synthetic ids to selected_only) — the series itself stays.
        ordered.forEach((r, i) => {
          const li = list.children[i];
          if (li) addActions(li, r);
        });
      } catch (err) {
        if (err && err.status === 401) offerSignin();
        else {
          // A silent non-401 failure left the page confidently claiming the
          // customer has no bookings. Own the failure, then let the device
          // records stand in as clearly-labelled second best.
          const p = document.createElement("p");
          p.className = "formnote formnote--err";
          p.textContent = "We couldn't load your account's bookings just now — showing what was booked on this device. Reload the page to try again.";
          list.before(p);
          reconcileDeviceRows();
        }
      }
    })();

  }

  /* ================================================================
     PAYMENTS — the account's own charges, fees and credits, newest
     first, on their own page (linked from my-bookings so that panel
     stays about upcoming cleans). Signed-in only: a direct hit while
     signed out bounces to sign-in and returns here. The backend scopes
     the list to the token's client and pre-formats each date Eastern,
     so nothing here parses a timestamp (the bug that once blanked a
     date-filtered list).
     ================================================================ */
  function initPayments() {
    const list = $(".payments");
    if (!list) return;

    // Money needs a live session; without one, sign in and come back here.
    if (!hasLiveSession()) { goto("sign-in?next=payments"); return; }

    function paymentRow(p) {
      const li = document.createElement("li");
      li.className = "payment";
      // A credit (gift balance applied) or a refund is money in the customer's
      // favour — mark it, and read the amount as coming back to them.
      const inFavour = p.type === "credit" || p.type === "refund";

      const when = document.createElement("span");
      when.className = "payment-when";
      when.textContent = p.date;

      const amt = document.createElement("span");
      amt.className = "payment-amt" + (inFavour ? " payment-amt--credit" : "");
      // abs() so the sign is driven only by type — a stray negative can never
      // double-negate into "−$-25".
      amt.textContent = (inFavour ? "−" : "") + money(Math.abs(Number(p.amount)));
      if (inFavour) amt.title = p.type === "refund" ? "Refunded to your card" : "Account credit";

      const what = document.createElement("span");
      what.className = "payment-what";
      what.textContent = p.description || (inFavour ? "Account credit" : "Payment");

      li.append(when, amt, what);

      if (p.card_last4) {
        const card = document.createElement("span");
        card.className = "payment-card";
        const brand = p.card_brand
          ? p.card_brand.charAt(0).toUpperCase() + p.card_brand.slice(1)
          : "Card";
        card.textContent = `${brand} ••${p.card_last4}`;
        li.append(card);
      }
      return li;
    }

    function message(cls, text) {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "payment payment--empty" + (cls ? ` ${cls}` : "");
      li.textContent = text;
      list.appendChild(li);
    }

    (async () => {
      let payments = [];
      try {
        const resp = await api.paymentHistory(50);
        payments = (resp && resp.payments) || [];
      } catch (err) {
        if (err && err.status === 401) { goto("sign-in?next=payments"); return; }
        message("payment--err", "We couldn't load your payments just now — reload the page to try again.");
        return;
      }
      if (!payments.length) {
        message("", "No payments yet — your charges will show up here after your first cleaning.");
        return;
      }
      list.innerHTML = "";
      payments.forEach((p) => list.appendChild(paymentRow(p)));
      // Honest about the cap: a very active account has more than we show.
      if (payments.length >= 50) {
        const note = document.createElement("li");
        note.className = "payments-note";
        note.textContent = "Showing your 50 most recent payments.";
        list.appendChild(note);
      }
    })();
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
    // A captured-but-unrecorded 3-D Secure gift charge; while this exists,
    // Send resumes the recording step instead of charging again.
    const PENDING_GIFT_KEY = "madame_pending_gift";

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
      amounts.removeAttribute("aria-busy");
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
            color: "#175AAA",
            fontFamily: 'Poppins, "Segoe UI", sans-serif',
            "::placeholder": { color: "rgba(23, 90, 170, .45)" },
          },
          invalid: { color: "#DB3694" },
        },
      });
      card.mount(cardBox);
    }

    // The backend rejects purchases without a Turnstile token whenever it has
    // keys configured, so the widget must render exactly when config says so.
    let turnstileWait = 0;
    function mountTurnstile() {
      const box = $("#turnstile", form);
      if (!box || !config.turnstile_site_key) return;
      if (!window.turnstile) {
        // The challenge script can be blocked (ad-blocker, network). After a
        // grace period stop pointing at a widget that will never appear.
        turnstileWait += 200;
        if (turnstileWait > 8000) {
          note(status, "The security check couldn't load — refresh the page to try again, or call 845-212-4444 to order by phone.", true);
          return;
        }
        return setTimeout(mountTurnstile, 200);
      }
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
          // Resume-first: a 3-D Secure gift charge is CAPTURED the moment the
          // bank challenge finishes — if our confirm call then failed, the
          // buyer's money is already taken. Retrying must finish THAT charge
          // (the backend replays it idempotently), never run a fresh one.
          let pendingGift = null;
          try { pendingGift = JSON.parse(sessionStorage.getItem(PENDING_GIFT_KEY) || "null"); } catch { /* noop */ }
          let res;
          if (pendingGift && pendingGift.payment_intent_id) {
            try {
              res = await api.giftConfirm({ ...pendingGift.payload, payment_intent_id: pendingGift.payment_intent_id });
              sessionStorage.removeItem(PENDING_GIFT_KEY);
            } catch (err) {
              throw new Error("Your card was charged but the gift isn\'t recorded yet — press Send again to finish it. You won\'t be charged twice.");
            }
          } else {
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
            res = await api.giftPurchase({ ...payload, payment_method_id: pm.paymentMethod.id });
            if (res && res.requires_action) {
              const conf = await stripe.confirmCardPayment(res.client_secret);
              if (conf.error) throw new Error(conf.error.message);
              // From here the money is captured — remember the intent until
              // the gift is recorded, so a confirm failure can be resumed.
              sessionStorage.setItem(PENDING_GIFT_KEY, JSON.stringify({
                payment_intent_id: res.payment_intent_id,
                payload,
              }));
              try {
                res = await api.giftConfirm({ ...payload, payment_intent_id: res.payment_intent_id });
                sessionStorage.removeItem(PENDING_GIFT_KEY);
              } catch (err) {
                throw new Error("Your card was charged but the gift isn\'t recorded yet — press Send again to finish it. You won\'t be charged twice.");
              }
            }
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

  /* ---------- stale-tab self-heal ---------- */

  // Mobile browsers restore backgrounded tabs from memory for days, so a tab
  // keeps RUNNING old code while fetching fresh data — that's how an
  // already-fixed bug kept "reproducing" on one phone for a whole evening.
  // On every wake after a real absence, compare the version this file was
  // built as with the served one; if behind, reload once. The sessionStorage
  // guard means a mis-bumped version file costs one reload per wake, never a
  // loop. scripts/bump-version.sh keeps the three markers in step.
  const SITE_VERSION = "85";
  let hiddenAt = 0;
  async function healIfStale() {
    try {
      const lastHeal = Number(sessionStorage.getItem("madame_heal_at") || 0);
      if (Date.now() - lastHeal < 10 * 60 * 1000) return;
      const res = await fetch("version.txt", { cache: "no-store" });
      if (!res.ok) return;
      const live = (await res.text()).trim();
      if (live && live !== SITE_VERSION) {
        sessionStorage.setItem("madame_heal_at", String(Date.now()));
        window.location.reload();
      }
    } catch { /* offline wake — leave the page alone */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    // Only after a real absence — flicking between apps shouldn't reload.
    if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) healIfStale();
  });
  // A back/forward-cache restore IS the stale-tab case — check immediately.
  window.addEventListener("pageshow", (e) => { if (e.persisted) healIfStale(); });

  /* ---------- session sign-out, on every page ---------- */

  // Masked session identity — enough to recognise WHOSE account this device
  // is in, never worth reading off a shared screen. Account-less (is_new)
  // sessions show nothing.
  function sessionIdentity() {
    const c = api.getToken() && api.claims();
    if (!c || !c.client_id) return null;
    if (c.phone && /\d{4}$/.test(c.phone)) return `•••-${c.phone.slice(-4)}`;
    if (c.email && c.email.includes("@")) {
      const [u, d] = c.email.split("@");
      return `${u.slice(0, 1)}•••@${d}`;
    }
    return null;
  }

  // Sessions last 30 days and public computers keep them — every page must
  // offer the way out, not just my-bookings (which mounts its own richer
  // version that also covers device records).
  function mountSignout() {
    if (!api.getToken()) return;
    if (document.querySelector(".signout-link")) return;
    const who = sessionIdentity();
    const link = document.createElement("button");
    link.type = "button";
    link.className = "signout-link";
    link.textContent = "Sign out";
    // Who this device is signed in as, on hover — the masked id is kept out
    // of the compact top-right label but not lost.
    if (who) link.title = `Signed in as ${who}`;
    // One press, no confirm strip: a public-computer session is exactly what
    // this exists to end, so it shouldn't take two taps.
    link.addEventListener("click", () => {
      api.setToken(null);
      localStorage.removeItem(RECORDS_KEY);
      sessionStorage.removeItem("madame_pending_confirm");
      sessionStorage.removeItem("madame_pending_gift");
      flow.clear();
      window.location.reload();
    });
    // Top-right: into the topbar's right-hand nav if there is one (landing),
    // else straight onto the topbar (space-between pushes it to the corner),
    // else a fixed corner as a last resort.
    const bar = document.querySelector(".topbar");
    const host = bar ? (bar.querySelector(".utility") || bar) : document.body;
    host.appendChild(link);
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
    "payments": initPayments,
    "purchase-a-gift": initGift,
  };

  async function boot() {
    // A magic link can land on any page; steps handle it in their own init.
    if (!inits[page]) { await handleMagicLinkReturn(); mountSignout(); return; }
    if (page !== "step-1") await handleMagicLinkReturn();
    inits[page]();
    mountSignout();
  }

  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
