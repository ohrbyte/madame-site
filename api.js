// Madame booking — public API client.
// Wraps /api/v1/public/* and /api/v1/settings/client-config for the static site.
// Base URL auto-detected by hostname:
//   beta.cleanmadame.com / cleanmadame.com → https://admin.cleanmadame.com/api/v1
//   anywhere else → same-origin, relative to where api.js itself was loaded
//     (works whether the site is mounted at "/" on localhost:8082 or at
//      "/madame/" on twilio-cleaneri.ohrbyte.dev — in both cases the nginx
//      site reverse-proxies "<mount>/api/" to localhost:5000, so the browser
//      stays same-origin with no CORS / Cloudflare Access in the way).
// Override at runtime with `?api=<url>` query or `localStorage.madame_api_base`.

(function (global) {
  const TOKEN_KEY = "public_client_token";
  const scriptSrc = document.currentScript?.src;

  function resolveBase() {
    // Security F3: the `?api=` override points the client at an API origin taken
    // from the URL — a magic-link email carrying `?api=https://evil.tld` would
    // otherwise send the one-time sign-in token there. It's a dev convenience,
    // so honour it ONLY on localhost. On the dev tunnel use the localStorage
    // override below instead (an attacker can't set another origin's storage).
    const onLocalhost =
      location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const fromQuery = onLocalhost
      ? new URLSearchParams(location.search).get("api")
      : null;
    if (fromQuery) return fromQuery.replace(/\/$/, "");
    const fromStorage = localStorage.getItem("madame_api_base");
    if (fromStorage) return fromStorage.replace(/\/$/, "");
    if (location.hostname === "beta.cleanmadame.com" || location.hostname === "cleanmadame.com") {
      return "https://admin.cleanmadame.com/api/v1";
    }
    // Derive from this file's URL: "<…>/api.js" → "<…>/api/v1".
    if (scriptSrc) return new URL("api/v1", scriptSrc).toString().replace(/\/$/, "");
    return `${location.origin}/api/v1`;
  }

  const API_BASE = resolveBase();

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

  function parseTokenClaims(token) {
    if (!token) return null;
    try {
      const payload = token.split(".")[1];
      const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch { return null; }
  }

  async function call(path, { method = "GET", body, auth = false, authToken, query } = {}) {
    const url = new URL(API_BASE + path);
    if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authToken) {
      // Explicit bearer — used by the phone+PIN "connect" flow, which carries the
      // email-proven magic-link token WITHOUT storing it in public_client_token
      // (an account-less session left in storage would look signed-in elsewhere).
      headers.Authorization = `Bearer ${authToken}`;
    } else if (auth) {
      const token = getToken();
      if (!token) throw new ApiError(401, "Not signed in", { code: "MissingToken" });
      headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, e.message || "Network error", { code: "NetworkError" });
    }
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!response.ok) {
      const message = (data && typeof data === "object" && (data.message || data.title)) || response.statusText;
      const code = (data && typeof data === "object" && data.code) || `HTTP_${response.status}`;
      // Some endpoints reject a bad/expired token as 400 InvalidToken rather
      // than 401 — either way the stored session is dead weight: drop it so
      // pages see "signed out" instead of retrying a corpse.
      if (response.status === 401 || code === "InvalidToken") setToken(null);
      throw new ApiError(response.status, message, { code, body: data });
    }
    return data;
  }

  class ApiError extends Error {
    constructor(status, message, { code, body } = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }

  const api = {
    base: API_BASE,
    getToken,
    setToken,
    claims: () => parseTokenClaims(getToken()),
    ApiError,

    // Public client config (Stripe + Maps keys, anonymous).
    getClientConfig: () => call("/settings/client-config"),

    // Auth
    sendSmsOtp: (phone) => call("/public/auth/sms/send", { method: "POST", body: { phone } }),
    verifySmsOtp: (phone, code) => call("/public/auth/sms/verify", { method: "POST", body: { phone, code } }),
    // return_url: the emailed link lands back HERE (this site's sign-in page)
    // instead of the API host's own /book page. Path-aware so sub-path mounts
    // round-trip too. The backend validates the host.
    sendMagicLink: (email) => call("/public/auth/email/send", {
      method: "POST",
      // Keep the query string — ?next=my-bookings must survive the email
      // round-trip or the re-auth lands in the booking flow instead.
      body: { email, return_url: `${location.origin}${location.pathname}${location.search}` },
    }),
    verifyMagicLink: (token) => call("/public/auth/email/verify", { query: { token } }),

    // Registration / profile / address
    register: (data) => call("/public/clients/register", { method: "POST", body: data, auth: true }),
    // Connect an existing phone-booked account to an email-proven session. The
    // email token is passed explicitly (not from storage) — see call()'s authToken.
    linkByPin: (phone, pin, emailToken) => call("/public/clients/link-by-pin", {
      method: "POST", body: { phone, pin, tos_accepted: true }, authToken: emailToken,
    }),
    me: () => call("/public/clients/me", { auth: true }),
    updateAddress: (address) => call("/public/clients/address", { method: "PUT", body: address, auth: true }),
    clientAddresses: () => call("/public/clients/addresses", { auth: true }),
    addClientAddress: (address) => call("/public/clients/addresses", { method: "POST", body: address, auth: true }),
    validateAddress: (address) => call("/public/locations/validate-address", { method: "POST", body: address }),

    // Bookings
    bookingRules: () => call("/public/bookings/rules"),
    availableSlots: (date, hours, language) => call("/public/bookings/available-slots", { query: { date, hours, language: language || undefined }, auth: true }),
    pastCleaners: () => call("/public/bookings/past-cleaners", { auth: true }),
    estimate: (input) => call("/public/bookings/estimate", { method: "POST", body: input, auth: true }),
    book: (input) => call("/public/bookings", { method: "POST", body: input, auth: true }),
    bookRecurring: (input) => call("/public/bookings/recurring", { method: "POST", body: input, auth: true }),
    bookingStatus: (id) => call(`/public/bookings/${encodeURIComponent(id)}`, { auth: true }),
    listBookings: () => call("/public/bookings", { auth: true }),
    modifyPreview: (id, input) => call(`/public/bookings/${encodeURIComponent(id)}/preview`, { method: "POST", body: input, auth: true }),
    modifyBooking: (id, input) => call(`/public/bookings/${encodeURIComponent(id)}/modify`, { method: "PUT", body: input, auth: true }),
    cancelPreview: (id) => call(`/public/bookings/${encodeURIComponent(id)}/cancel-preview`, { method: "POST", auth: true }),
    cancelBooking: (id, scope) => call(`/public/bookings/${encodeURIComponent(id)}/cancel`, { method: "PUT", body: scope ? { recurring_scope: scope } : {}, auth: true }),
    confirmPayment: (bookingId) => call("/public/bookings/confirm-payment", { method: "POST", body: { booking_id: bookingId }, auth: true }),

    // Gift cards (public, unauthenticated purchase)
    giftConfig: () => call("/public/giftcards/config"),
    giftPurchase: (input) => call("/public/giftcards/purchase", { method: "POST", body: input }),
    giftConfirm: (input) => call("/public/giftcards/confirm", { method: "POST", body: input }),

    // Payments
    // The signed-in client's own charges, fees and credits (newest first). The
    // backend scopes it to the token's client and pre-formats each date Eastern.
    paymentHistory: (limit) => call("/public/payments/history", { query: limit ? { limit } : undefined, auth: true }),
    paymentMethods: () => call("/public/payments/methods", { auth: true }),
    createSetupIntent: () => call("/public/payments/setup-intent", { method: "POST", body: {}, auth: true }),
    addPaymentMethod: (paymentMethodId) => call("/public/payments/methods/add", { method: "POST", body: { payment_method_id: paymentMethodId }, auth: true }),
    deletePaymentMethod: (paymentMethodId) => call(`/public/payments/methods/${encodeURIComponent(paymentMethodId)}`, { method: "DELETE", auth: true }),
  };

  global.MadameApi = api;
})(typeof window !== "undefined" ? window : globalThis);
