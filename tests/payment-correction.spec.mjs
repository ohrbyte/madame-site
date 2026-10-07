// The payment-correction panel on /my-bookings: an amount the office asked this
// customer to repay for one past visit, which they may agree to and pay with a
// saved card (3-D Secure in the browser).
//
// Hermetic like the sign-in suite: every /api/v1 call is answered here, anything
// leaving 127.0.0.1 is aborted, and Stripe.js is a stand-in served in its place —
// no test can reach the real API or Stripe, and none moves money.
import { test, expect } from "@playwright/test";

function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp, ...claims })}.test-signature`;
}
const CLIENT_TOKEN = jwt({
  type: "client",
  is_new: "false",
  client_id: "00000000-0000-0000-0000-000000000001",
  name: "Test Client",
});

const BOOKING = "01a074e1-70e5-738b-a685-aed246f2d96b";
const CONSENT_V1 =
  "I agree to pay $74.42 as a payment correction for my cleaning visit on September 7, 2026. This is a new, one-time charge to the card I choose, separate from my original payment for that visit.";

function correction(over = {}) {
  return {
    id: "c0000000-0000-0000-0000-000000000001",
    booking_id: BOOKING,
    amount: 74.42,
    currency: "usd",
    reason: "On Sep 23 we refunded $74.42 more than your visit's clocked time came to.",
    status: "requested",
    expires_at: "2026-10-20T16:00:00Z",
    expired: false,
    visit_start: "2026-09-07T14:15:00",
    consent_text: CONSENT_V1,
    consent_version: "2026-10-06.1",
    payment_method_id: null,
    collected_at: null,
    ...over,
  };
}

const VISA = { payment_method_id: "pm_visa", type: "card", brand: "visa", last4: "4242", exp_month: 4, exp_year: 2029, is_default: true };
const AMEX = { payment_method_id: "pm_amex", type: "card", brand: "amex", last4: "0005", exp_month: 1, exp_year: 2030, is_default: false };
const BANK = { payment_method_id: "pm_bank", type: "usbankaccount", brand: null, last4: "6789", is_default: false };

const PAY = `POST /public/portal/bookings/${BOOKING}/correction/pay`;
const CONFIRM = `POST /public/portal/bookings/${BOOKING}/correction/confirm`;
const LIST = "GET /public/portal/payment-corrections";

const json = (body, status = 200) => (route) => route.fulfill({ status, json: body });

/** Block the outside world, serve a stand-in Stripe.js, record every API call. */
async function mockApi(page, handlers = {}) {
  const calls = [];
  const stripeLoads = [];
  await page.route(/^(?!http:\/\/127\.0\.0\.1:\d+\/)/, (route) => route.abort());
  await page.route("https://js.stripe.com/v3/", (route) => {
    stripeLoads.push(route.request().url());
    return route.fulfill({
      contentType: "text/javascript",
      body: `window.__stripeCalls = [];
        window.Stripe = function (key) {
          window.__stripeKey = key;
          return {
            confirmCardPayment: async function (secret, data, opts) {
              window.__stripeCalls.push({ secret: secret, handleActions: !!(opts && opts.handleActions) });
              var mode = window.__stripeMode || "approve";
              if (mode === "decline") return { error: { message: "Your card was declined." } };
              if (mode === "already") return { error: { message: "unexpected state", payment_intent: { id: "pi_x", status: "requires_capture" } } };
              return { paymentIntent: { id: "pi_x", status: "requires_capture" } };
            },
          };
        };`,
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace(/^.*\/api\/v1/, "")}`;
    calls.push({ key, body: req.postDataJSON(), authorization: req.headers().authorization });
    const handler = handlers[key];
    if (!handler) return route.fulfill({ status: 404, json: { message: `unmocked ${key}` } });
    return handler(route);
  });
  return { calls, stripeLoads };
}

/** Handlers for a signed-in customer with one open correction and the given cards. */
function account(over = {}) {
  return {
    "GET /public/bookings": json({ bookings: [] }),
    "GET /public/payments/methods": json([VISA, AMEX]),
    "GET /settings/client-config": json({ stripe_publishable_key: "pk_test_stand_in" }),
    [LIST]: json([correction()]),
    ...over,
  };
}

async function signedIn(page, stripeMode) {
  await page.addInitScript(([token, mode]) => {
    localStorage.setItem("public_client_token", token);
    if (mode) window.__stripeMode = mode;
  }, [CLIENT_TOKEN, stripeMode || null]);
}

const box = (page) => page.locator("section.correction");
const payButton = (page) => box(page).locator("button.correction-pay");
const consentBox = (page) => box(page).locator('input[type="checkbox"]');
const statusLine = (page) => box(page).locator(".formnote");
const keys = (calls) => calls.map((c) => c.key);
// The visit's own payment endpoints — the panel must never reach them.
const BOOKING_PAYMENT_ROUTES = /\/public\/portal\/bookings\/[^/]+\/(pay|pay\/confirm|payment|payment\/confirm)$|\/public\/bookings\/confirm-payment$/;

test.describe("payment correction on /my-bookings", () => {
  test("no correction: nothing is added and no card check runs", async ({ page }) => {
    await signedIn(page);
    const { calls } = await mockApi(page, account({ [LIST]: json([]) }));

    await page.goto("/my-bookings");

    await expect(page.locator(".bookings .booking--empty")).toContainText("No upcoming cleanings");
    await expect.poll(() => keys(calls)).toContain(LIST);
    await expect(box(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__stripeCalls || [])).toEqual([]);
    expect(keys(calls).filter((k) => k === PAY || k === CONFIRM)).toEqual([]);
  });

  test("signed out: the corrections list is never asked for", async ({ page }) => {
    const { calls } = await mockApi(page, account());

    await page.goto("/my-bookings");

    await expect(page.locator(".booking-signin")).toBeVisible();
    expect(keys(calls)).not.toContain(LIST);
    await expect(box(page)).toHaveCount(0);
  });

  test("shows the server's explanation and fixed amount, with an unticked agreement and no amount to edit", async ({ page }) => {
    await signedIn(page);
    await mockApi(page, account());

    await page.goto("/my-bookings");

    await expect(box(page)).toBeVisible();
    await expect(box(page).locator("h2")).toHaveText("Payment correction");
    await expect(box(page).locator(".correction-visit")).toHaveText("For your cleaning on Monday, September 7");
    await expect(box(page).locator(".correction-reason")).toHaveText(correction().reason);
    await expect(box(page).locator(".correction-amount")).toHaveText("Amount: $74.42");
    await expect(box(page).locator(".correction-new")).toContainText("new, one-time charge");
    await expect(box(page).locator(".correction-consent")).toHaveText(CONSENT_V1);
    await expect(consentBox(page)).not.toBeChecked();
    // Nothing to type: no amount field of any kind.
    await expect(box(page).locator("input:not([type=checkbox]), textarea, select")).toHaveCount(0);
    await expect(payButton(page)).toHaveText("Pay $74.42");
    // The saved cards are offered (the payment step's card cell), the default picked.
    await expect(box(page).locator(".choice span")).toHaveText(["VISA ·· 4242", "AMEX ·· 0005"]);
    await expect(box(page).locator(".choice small")).toHaveText(["exp 4/29", "exp 1/30"]);
    await expect(box(page).locator(".choice.is-on span")).toHaveText("VISA ·· 4242");
    // Pay waits for the customer's own tick.
    await expect(payButton(page)).toBeDisabled();
    await consentBox(page).check();
    await expect(payButton(page)).toBeEnabled();
    await consentBox(page).uncheck();
    await expect(payButton(page)).toBeDisabled();
  });

  test("only cards are offered — never a bank account", async ({ page }) => {
    await signedIn(page);
    await mockApi(page, account({ "GET /public/payments/methods": json([BANK, AMEX]) }));

    await page.goto("/my-bookings");

    await expect(box(page).locator(".choice span")).toHaveText(["AMEX ·· 0005"]);
    await expect(box(page).locator(".choice.is-on span")).toHaveText("AMEX ·· 0005");
  });

  test("no card on file: explains, offers the office, and cannot pay", async ({ page }) => {
    await signedIn(page);
    await mockApi(page, account({ "GET /public/payments/methods": json([BANK]) }));

    await page.goto("/my-bookings");

    await expect(statusLine(page)).toHaveText("There's no card saved on your account. Please call us and we'll help you settle this.");
    await expect(box(page).locator(".call-office a")).toHaveAttribute("href", "tel:+18452124444");
    await consentBox(page).check();
    await expect(payButton(page)).toBeDisabled();
  });

  test("pays with 3-D Secure in the browser, then the server completes it — and the visit's payment is never touched", async ({ page }) => {
    await signedIn(page);
    const { calls, stripeLoads } = await mockApi(page, account({
      [PAY]: json({ correction: correction({ status: "payment_pending", payment_method_id: "pm_amex" }), client_secret: "pi_corr_1_secret_abc", payment_state: "action", requires_action: true }),
      [CONFIRM]: json({ correction: correction({ status: "collected", collected_at: "2026-10-07T15:00:00Z" }), payment_state: "collected" }),
    }));

    await page.goto("/my-bookings");
    await box(page).locator(".choice", { hasText: "AMEX" }).click();
    await consentBox(page).check();
    await payButton(page).click();

    await expect(box(page).locator(".correction-paid")).toHaveText("Paid — thank you. We received your $74.42 payment correction.");
    await expect(box(page).locator("button.correction-pay")).toHaveCount(0);
    await expect(box(page).locator('input[type="checkbox"]')).toHaveCount(0);

    const pay = calls.filter((c) => c.key === PAY);
    expect(pay).toHaveLength(1);
    // The customer's agreement and card — and no amount: the server owns it.
    expect(pay[0].body).toEqual({ payment_method_id: "pm_amex", consent: true, consent_version: "2026-10-06.1" });
    expect(pay[0].authorization).toBe(`Bearer ${CLIENT_TOKEN}`);
    expect(stripeLoads).toHaveLength(1);
    expect(await page.evaluate(() => window.__stripeKey)).toBe("pk_test_stand_in");
    expect(await page.evaluate(() => window.__stripeCalls)).toEqual([{ secret: "pi_corr_1_secret_abc", handleActions: true }]);
    expect(calls.filter((c) => c.key === CONFIRM)).toHaveLength(1);
    // Order: agree+start, bank check, complete.
    const order = keys(calls).filter((k) => k === PAY || k === CONFIRM);
    expect(order).toEqual([PAY, CONFIRM]);
    expect(calls.filter((c) => BOOKING_PAYMENT_ROUTES.test(c.key))).toEqual([]);
  });

  test("a double press sends one payment request", async ({ page }) => {
    await signedIn(page);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const { calls } = await mockApi(page, account({
      [PAY]: async (route) => {
        await held;
        return route.fulfill({ json: { correction: correction({ status: "payment_pending" }), payment_state: "authorized" } });
      },
      [CONFIRM]: json({ correction: correction({ status: "collected" }), payment_state: "collected" }),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).dblclick();
    await payButton(page).click({ force: true }).catch(() => {});
    await expect(payButton(page)).toHaveAttribute("aria-busy", "true");
    release();

    await expect(box(page).locator(".correction-paid")).toBeVisible();
    expect(calls.filter((c) => c.key === PAY)).toHaveLength(1);
    expect(calls.filter((c) => c.key === CONFIRM)).toHaveLength(1);
  });

  test("a declined card confirms nothing, says nothing was charged, and can be retried", async ({ page }) => {
    await signedIn(page, "decline");
    const { calls } = await mockApi(page, account({
      [PAY]: json({ correction: correction({ status: "payment_pending" }), client_secret: "pi_corr_1_secret_abc", payment_state: "action", requires_action: true }),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(statusLine(page)).toHaveText("Your card was declined. Nothing was charged — you can try again or choose another card.");
    expect(keys(calls)).not.toContain(CONFIRM);
    await expect(payButton(page)).toBeEnabled();
    await expect(payButton(page)).toHaveText("Pay $74.42");
  });

  test("an approval that already happened (returning to a pending payment) still completes", async ({ page }) => {
    await signedIn(page, "already");
    const { calls } = await mockApi(page, account({
      [LIST]: json([correction({ status: "payment_pending", payment_method_id: "pm_amex" })]),
      [PAY]: json({ correction: correction({ status: "payment_pending" }), client_secret: "pi_corr_1_secret_abc", payment_state: "action", requires_action: true }),
      [CONFIRM]: json({ correction: correction({ status: "collected" }), payment_state: "collected" }),
    }));

    await page.goto("/my-bookings");
    // The card the open attempt is for is preselected, so resuming reuses it.
    await expect(box(page).locator(".choice.is-on span")).toHaveText("AMEX ·· 0005");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(box(page).locator(".correction-paid")).toBeVisible();
    expect(calls.filter((c) => c.key === PAY)[0].body.payment_method_id).toBe("pm_amex");
    expect(calls.filter((c) => c.key === CONFIRM)).toHaveLength(1);
  });

  test("an authorization already in place skips Stripe and goes straight to completing", async ({ page }) => {
    await signedIn(page);
    const { calls } = await mockApi(page, account({
      [PAY]: json({ correction: correction({ status: "payment_pending" }), payment_state: "authorized" }),
      [CONFIRM]: json({ correction: correction({ status: "collected" }), payment_state: "collected" }),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(box(page).locator(".correction-paid")).toBeVisible();
    expect(await page.evaluate(() => window.__stripeCalls || [])).toEqual([]);
    expect(keys(calls).filter((k) => k === PAY || k === CONFIRM)).toEqual([PAY, CONFIRM]);
  });

  test("when the bank can't say yet, it never claims success — Check again finishes it", async ({ page }) => {
    await signedIn(page);
    let confirms = 0;
    const { calls } = await mockApi(page, account({
      [PAY]: json({ correction: correction({ status: "payment_pending" }), payment_state: "authorized" }),
      [CONFIRM]: (route) => (++confirms === 1
        ? route.fulfill({ status: 503, json: { code: "StripeUnavailable", message: "We're confirming your payment with the bank — please refresh in a minute." } })
        : route.fulfill({ json: { correction: correction({ status: "collected" }), payment_state: "collected" } })),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(statusLine(page)).toHaveText("We're confirming your payment with the bank — please refresh in a minute.");
    await expect(box(page).locator(".correction-paid")).toHaveCount(0);
    await box(page).locator("button.correction-check").click();
    await expect(box(page).locator(".correction-paid")).toBeVisible();
    expect(calls.filter((c) => c.key === PAY)).toHaveLength(1);
    expect(calls.filter((c) => c.key === CONFIRM)).toHaveLength(2);
  });

  test("withdrawn or expired meanwhile: says nothing was charged", async ({ page }) => {
    await signedIn(page);
    await mockApi(page, account({
      [PAY]: json({ code: "NotFound", message: "There's no payment correction for you on this visit." }, 404),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(page.locator(".correction--gone")).toHaveText("This payment correction is no longer open — nothing was charged.");
    await expect(page.locator("button.correction-pay")).toHaveCount(0);
  });

  test("already being paid in another tab: the server's word is shown, nothing else happens", async ({ page }) => {
    await signedIn(page);
    const { calls } = await mockApi(page, account({
      [PAY]: json({ code: "CorrectionInProgress", message: "This payment is already being processed. Please wait a moment and refresh." }, 409),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(statusLine(page)).toHaveText("This payment is already being processed. Please wait a moment and refresh.");
    expect(keys(calls)).not.toContain(CONFIRM);
  });

  test("changed wording: shows the new words and asks for a fresh tick", async ({ page }) => {
    await signedIn(page);
    const V2 = "I agree to pay $74.42 — updated wording.";
    let lists = 0;
    const { calls } = await mockApi(page, account({
      [LIST]: (route) => route.fulfill({
        json: [++lists === 1 ? correction() : correction({ consent_text: V2, consent_version: "2026-10-07.1" })],
      }),
      [PAY]: json({ code: "ConsentRequired", message: "Please read the correction and tick the box to agree before paying." }, 400),
    }));

    await page.goto("/my-bookings");
    await consentBox(page).check();
    await payButton(page).click();

    await expect(box(page).locator(".correction-consent")).toHaveText(V2);
    await expect(box(page)).toHaveCount(1);
    await expect(consentBox(page)).not.toBeChecked();
    await expect(statusLine(page)).toHaveText("Please read the updated wording and tick the box again.");
    await expect(payButton(page)).toBeDisabled();
    expect(calls.filter((c) => c.key === PAY)).toHaveLength(1);
  });

  test("a paid correction shows as paid, with nothing to press", async ({ page }) => {
    await signedIn(page);
    await mockApi(page, account({ [LIST]: json([correction({ status: "collected", collected_at: "2026-10-07T15:00:00Z" })]) }));

    await page.goto("/my-bookings");

    await expect(box(page).locator(".correction-paid")).toHaveText("Paid — thank you. We received your $74.42 payment correction.");
    await expect(box(page).locator("button, input")).toHaveCount(0);
  });

  test("the corrections endpoint failing leaves My Bookings working", async ({ page }) => {
    await signedIn(page);
    await mockApi(page, account({
      [LIST]: json({ message: "boom" }, 500),
      "GET /public/bookings": json({ bookings: [{ id: "b1", date: "2099-01-05", start_time: "9:00 AM", hours: 3, duration_minutes: 180, amount: 57, status: "scheduled" }] }),
    }));

    await page.goto("/my-bookings");

    await expect(page.locator(".bookings .booking-when")).toContainText("9:00 AM");
    await expect(box(page)).toHaveCount(0);
  });
});
