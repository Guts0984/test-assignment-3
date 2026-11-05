import { expect, type APIRequestContext, type Page, request } from "@playwright/test";

export const baseURL = process.env["BASE_URL"] ?? "http://localhost:8080";

export const users = {
  admin: { email: "admin@example.com", password: process.env["SEED_ADMIN_PASSWORD"] ?? "Admin-Demo-Pass-1" },
  alice: { email: "alice@example.com", password: process.env["SEED_ALICE_PASSWORD"] ?? "Alice-Demo-Pass-1" },
  bob: { email: "bob@example.com", password: process.env["SEED_BOB_PASSWORD"] ?? "Bob-Demo-Pass-1" },
};

type Credentials = { email: string; password: string };

// Logging in is rate limited (that is a requirement), so each user logs in once per test run and the
// session cookie is reused. The login form itself is covered by the "registers" test and the api tests.
const sessions = new Map<string, Promise<string>>();

function sessionFor(user: Credentials): Promise<string> {
  const known = sessions.get(user.email);
  if (known) return known;
  const created = (async () => {
    const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const res = await api.post("/api/auth/login", { data: user });
    expect(res.status(), await res.text()).toBe(200);
    const cookie = (await api.storageState()).cookies.find((c) => c.name === "sid");
    await api.dispose();
    if (!cookie) throw new Error("login did not set the sid cookie");
    return cookie.value;
  })();
  sessions.set(user.email, created);
  return created;
}

export async function logIn(page: Page, user: Credentials) {
  const value = await sessionFor(user);
  await page.context().addCookies([{ name: "sid", value, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/");
  await expect(page.getByTestId("user-email")).toHaveText(user.email);
}

/** A logged-in API client (own cookie jar) for preparing data and for checks that bypass the UI. */
export async function apiAs(user: Credentials): Promise<APIRequestContext> {
  const value = await sessionFor(user);
  return request.newContext({
    baseURL,
    extraHTTPHeaders: { Origin: baseURL, Cookie: `sid=${value}` },
  });
}

export const uniqueEmail = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
