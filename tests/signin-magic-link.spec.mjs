// Sign-in regressions: the magic-link return, the connect card it opens for an
// email with no account, and how network failures are worded.
//
// Hermetic by construction: every /api/v1 call is answered here (page.route),
// unmocked API calls get a 404 from the stub (never the network), and any
// request leaving 127.0.0.1 is aborted — the suite cannot touch the real API.
import { test, expect } from "@playwright/test";

const INVALID_LINK =
  "That sign-in link is invalid or has already been used — request a new one below.";
const NETWORK_ON_VERIFY =
  "We couldn't reach Clean Madame to finish signing you in — check your internet connection, then tap the link in your email again.";
const NETWORK_GENERIC =
  "We couldn't reach Clean Madame — check your internet connection and try again.";
const NO_ACCOUNT_NOTE =
  "We couldn't find an account for that email yet. Enter your mobile number and we'll text you a code — we'll connect your bookings if you've cleaned with us before, or finish setting up your account.";

// The site only DECODES tokens (claims drive the UI); signatures are the
// server's job, so unsigned test tokens are enough. Claim shapes mirror
// ClientJwtTokenGenerator: a matched client carries client_id; an email that
// matches no client gets is_new + email_verified and no client_id.
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
  phone: "8455550100",
});
const ACCOUNTLESS_TOKEN = jwt({
  type: "client",
  is_new: "true",
  email_verified: "true",
  email: "new.customer@example.com",
});
// The API's reply to a used, expired or unknown token (DisplayableException → 400).
const INVALID_LINK_BODY = {
  type: "https://tools.ietf.org/html/rfc7231#section-6.5.1",
  title: "Bad Request",
  status: 400,
  message: "Invalid or expired link. Please request a new one.",
};

/** Block the outside world, record every API call, answer from `handlers`
 *  keyed "METHOD /path" (path after /api/v1). */
async function mockApi(page, handlers = {}) {
  const calls = [];
  await page.route(/^(?!http:\/\/127\.0\.0\.1:\d+\/)/, (route) => route.abort());
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace(/^.*\/api\/v1/, "")}`;
    calls.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: req.postDataJSON(),
      authorization: req.headers().authorization,
    });
    const handler = handlers[key];
    if (!handler) return route.fulfill({ status: 404, json: { message: `unmocked ${key}` } });
    return handler(route);
  });
  return calls;
}

const storedToken = (page) => page.evaluate(() => localStorage.getItem("public_client_token"));
const card = (page) => page.locator("form.panel");
const statusLine = (page) => page.locator("form.panel .formnote");
const verifyWith = (reply) => ({ "GET /public/auth/email/verify": reply });
const accountless = (route) => route.fulfill({ json: { access_token: ACCOUNTLESS_TOKEN } });

test.describe("magic link return on /sign-in", () => {
  test("valid link for an existing client signs in and continues to the page that asked", async ({ page }) => {
    const calls = await mockApi(page, {
      ...verifyWith((route) => route.fulfill({ json: { access_token: CLIENT_TOKEN } })),
      "GET /public/bookings": (route) => route.fulfill({ json: { bookings: [] } }),
    });

    await page.goto("/sign-in?next=my-bookings&token=link-for-existing-client");

    await expect(page).toHaveURL(/\/my-bookings$/);
    expect(await storedToken(page)).toBe(CLIENT_TOKEN);
    const verifies = calls.filter((c) => c.key === "GET /public/auth/email/verify");
    expect(verifies).toHaveLength(1);
    expect(verifies[0].query).toEqual({ token: "link-for-existing-client" });
  });

  test("valid link for an email with no account opens the connect card with every way in visible", async ({ page }) => {
    const calls = await mockApi(page, verifyWith(accountless));

    await page.goto("/sign-in?next=my-bookings&token=link-for-new-email");

    await expect(card(page)).toHaveAttribute("data-stage", "connect");
    await expect(page.locator(".panel-lede")).toHaveText("Almost there — what's your phone number?");
    await expect(statusLine(page)).toHaveText(NO_ACCOUNT_NOTE);
    await expect(page.locator("#connect-phone")).toBeVisible();
    // The three alternatives this card exists to offer (display:none before the fix).
    await expect(page.locator("#connect-pin-toggle")).toBeVisible();
    await expect(page.locator("#connect-pin-toggle")).toHaveText("Can't receive texts? Use your PIN instead");
    await expect(page.locator("#connect-no-texts")).toBeVisible();
    await expect(page.locator("#connect-no-texts")).toHaveText("Can’t get texts? We’ll call you with a code");
    await expect(page.locator("#auth-restart")).toBeVisible();
    await expect(page.locator("#auth-restart")).toHaveText("Sign in a different way");
    // Nothing from other stages leaks onto this one.
    await expect(page.locator("#connect-pin")).toBeHidden();
    await expect(page.locator("#code-call-me")).toBeHidden();
    // Security behaviour unchanged: the account-less token is never stored and
    // the one-time token is scrubbed from the address bar (next= survives).
    expect(await storedToken(page)).toBeNull();
    const url = new URL(page.url());
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.searchParams.get("next")).toBe("my-bookings");
    expect(calls.map((c) => c.key)).toEqual(["GET /public/auth/email/verify"]);
  });

  test("expired, used or unknown link still gets the invalid-link message", async ({ page }) => {
    const calls = await mockApi(page, verifyWith((route) => route.fulfill({ status: 400, json: INVALID_LINK_BODY })));

    await page.goto("/sign-in?next=my-bookings&token=spent-link");

    await expect(statusLine(page)).toHaveText(INVALID_LINK);
    await expect(statusLine(page)).toHaveClass(/formnote--err/);
    await expect(page.locator("#signin-phone")).toBeVisible(); // the sign-in form, ready to request a new one
    await expect(page).toHaveURL(/\/sign-in\?next=my-bookings$/);
    expect(await storedToken(page)).toBeNull();
    expect(calls.map((c) => c.key)).toEqual(["GET /public/auth/email/verify"]);
  });

  test("a dead link is reported even when an older session is still stored", async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("public_client_token", t), CLIENT_TOKEN);
    await mockApi(page, verifyWith((route) => route.fulfill({ status: 400, json: INVALID_LINK_BODY })));

    await page.goto("/sign-in?next=my-bookings&token=spent-link");

    await expect(statusLine(page)).toHaveText(INVALID_LINK);
    await expect(page).toHaveURL(/\/sign-in\?next=my-bookings$/); // does not ride the old session onward
  });

  test("network failure while verifying does not call the link invalid or used", async ({ page }) => {
    const calls = await mockApi(page, verifyWith((route) => route.abort("internetdisconnected")));

    await page.goto("/sign-in?next=my-bookings&token=link-during-outage");

    await expect(statusLine(page)).toHaveText(NETWORK_ON_VERIFY);
    await expect(statusLine(page)).toHaveClass(/formnote--err/);
    await expect(statusLine(page)).not.toContainText("invalid");
    await expect(statusLine(page)).not.toContainText("already been used");
    await expect(page.locator("body")).not.toContainText("Failed to fetch");
    await expect(page).toHaveURL(/\/sign-in\?next=my-bookings$/); // token scrubbed as before
    expect(await storedToken(page)).toBeNull();
    expect(calls.map((c) => c.key)).toEqual(["GET /public/auth/email/verify"]);
  });
});

test.describe("connect card alternatives work", () => {
  test("PIN option opens the PIN form, links the account and continues", async ({ page }) => {
    const calls = await mockApi(page, {
      ...verifyWith(accountless),
      "POST /public/clients/link-by-pin": (route) => route.fulfill({ json: { access_token: CLIENT_TOKEN } }),
      "GET /public/bookings": (route) => route.fulfill({ json: { bookings: [] } }),
    });
    await page.goto("/sign-in?next=my-bookings&token=link-for-new-email");

    await page.locator("#connect-pin-toggle").click();

    await expect(card(page)).toHaveAttribute("data-stage", "connectpin");
    await expect(page.locator("#connect-pin")).toBeVisible();
    await expect(page.locator("#connect-pin-toggle")).toBeHidden();
    await expect(page.locator("#connect-no-texts")).toBeHidden();
    await expect(page.locator("#auth-restart")).toBeVisible();

    await page.locator("#connect-phone").fill("8455550100");
    await page.locator("#connect-pin").fill("1234");
    await page.getByRole("button", { name: "Connect my account" }).click();

    await expect(page).toHaveURL(/\/my-bookings$/);
    const link = calls.find((c) => c.key === "POST /public/clients/link-by-pin");
    // Same request the API has always required: the email-proven token as the
    // bearer, plus phone + PIN — the server does the checking.
    expect(link.authorization).toBe(`Bearer ${ACCOUNTLESS_TOKEN}`);
    expect(link.body).toEqual({ phone: "+18455550100", pin: "1234", tos_accepted: true });
    expect(await storedToken(page)).toBe(CLIENT_TOKEN);
  });

  test("'We'll call you with a code' places the verification call and opens the code field", async ({ page }) => {
    const calls = await mockApi(page, {
      ...verifyWith(accountless),
      "POST /public/auth/call/send": (route) => route.fulfill({ json: { attempt_token: "attempt-1" } }),
    });
    await page.goto("/sign-in?token=link-for-new-email");

    await page.locator("#connect-phone").fill("8455550100");
    await page.locator("#connect-no-texts").click();

    await expect(card(page)).toHaveAttribute("data-stage", "code");
    await expect(page.locator("#signin-code")).toBeVisible();
    const call = calls.find((c) => c.key === "POST /public/auth/call/send");
    expect(call.body).toEqual({ phone: "+18455550100" });
  });

  test("'Sign in a different way' returns to the start of sign-in", async ({ page }) => {
    await mockApi(page, verifyWith(accountless));
    await page.goto("/sign-in?token=link-for-new-email");

    await page.locator("#auth-restart").click();

    await expect(card(page)).toHaveAttribute("data-stage", "start");
    await expect(page.locator("#signin-phone")).toBeVisible();
    await expect(page.locator("#connect-phone")).toBeHidden();
    await expect(page.locator("#auth-restart")).toBeHidden(); // back to the start card's own rules
  });
});

test.describe("other sign-in stages are unchanged", () => {
  test("start shows no way-out links; code and sent keep their own", async ({ page }) => {
    await mockApi(page, {
      "POST /public/auth/sms/send": (route) => route.fulfill({ json: { success: true } }),
      "POST /public/auth/email/send": (route) => route.fulfill({ json: { success: true } }),
    });
    await page.goto("/sign-in");
    for (const id of ["#connect-pin-toggle", "#connect-no-texts", "#code-call-me", "#auth-restart"]) {
      await expect(page.locator(id)).toBeHidden();
    }

    // Phone: the code stage keeps "call me" and "use a different number".
    await page.locator("#signin-phone").fill("8455550100");
    await page.getByRole("button", { name: "Text me a sign-in code" }).click();
    await expect(card(page)).toHaveAttribute("data-stage", "code");
    await expect(page.locator("#code-call-me")).toBeVisible();
    await expect(page.locator("#auth-restart")).toHaveText("Use a different number");
    await expect(page.locator("#auth-restart")).toBeVisible();
    await expect(page.locator("#connect-pin-toggle")).toBeHidden();

    // Email: the sent stage keeps "use a different email" only.
    await page.locator("#auth-restart").click();
    await page.locator('label[for="mode-email"]').click();
    await page.locator("#signin-email").fill("customer@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(card(page)).toHaveAttribute("data-stage", "sent");
    await expect(page.locator("#auth-restart")).toHaveText("Use a different email");
    await expect(page.locator("#auth-restart")).toBeVisible();
    await expect(page.locator("#code-call-me")).toBeHidden();
    await expect(page.locator("#connect-no-texts")).toBeHidden();
  });
});

test.describe("network errors on sign-in actions", () => {
  test("'Text me a code' on the connect card shows a friendly message, not the browser's 'Failed to fetch'", async ({ page }) => {
    const calls = await mockApi(page, {
      ...verifyWith(accountless),
      "POST /public/clients/verify-phone": (route) => route.abort("failed"),
    });
    await page.goto("/sign-in?next=my-bookings&token=link-for-new-email");

    await page.locator("#connect-phone").fill("8455550100");
    await page.getByRole("button", { name: "Text me a code" }).click();

    await expect(statusLine(page)).toHaveText(NETWORK_GENERIC);
    await expect(statusLine(page)).toHaveClass(/formnote--err/);
    await expect(page.locator("body")).not.toContainText("Failed to fetch");
    await expect(card(page)).toHaveAttribute("data-stage", "connect"); // still on the card to retry
    expect(calls.map((c) => c.key)).toContain("POST /public/clients/verify-phone");
  });

  test("'Email me a sign-in link' shows the friendly message when the network is down", async ({ page }) => {
    await mockApi(page, { "POST /public/auth/email/send": (route) => route.abort("failed") });
    await page.goto("/sign-in");

    await page.locator('label[for="mode-email"]').click();
    await page.locator("#signin-email").fill("customer@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    await expect(statusLine(page)).toHaveText(NETWORK_GENERIC);
    await expect(page.locator("body")).not.toContainText("Failed to fetch");
  });
});
