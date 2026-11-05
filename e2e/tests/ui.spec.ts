import { expect, test, type Page } from "@playwright/test";
import { apiAs, logIn, uniqueEmail, users } from "./helpers";

const EVENT = 9;

/** A held booking of one ticket for `user`, made through the api. */
async function holdTicket(user: typeof users.alice): Promise<string> {
  const api = await apiAs(user);
  const res = await api.post(`/api/events/${EVENT}/bookings`, { data: { quantity: 1 }, headers: { "Idempotency-Key": crypto.randomUUID() } });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await api.dispose();
  return id;
}

async function cancelQuietly(user: typeof users.alice, bookingId: string) {
  const api = await apiAs(user);
  await api.delete(`/api/bookings/${bookingId}`);
  await api.dispose();
}

const activeCount = async (page: Page) => Number(await page.getByTestId("active-bookings").innerText());

test("a wrong password shows an error and nobody is logged in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password").fill("not-the-password-1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator('[data-slot="alert"]')).toContainText("The email or password is not correct.");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId("user-email")).toHaveCount(0);
});

test("the admin page sends visitors and ordinary users to the login page", async ({ page }) => {
  await page.goto(`/admin/events/${EVENT}`);
  await expect(page).toHaveURL(/\/login\?next=/);

  await logIn(page, users.alice);
  await page.goto(`/admin/events/${EVENT}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByLabel("Title")).toHaveCount(0);
});

test("when the time is up the checkout page says so and cannot confirm", async ({ page }) => {
  await logIn(page, users.alice);
  const bookingId = await holdTicket(users.alice);
  try {
    await page.clock.install();
    await page.goto(`/checkout/${bookingId}`);
    await expect(page.getByTestId("countdown")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled();

    await page.clock.fastForward("11:00"); // ten minutes of holding plus one
    await expect(page.getByText("The time to confirm has run out")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();
    await expect(page.getByTestId("countdown")).toHaveCount(0);
  } finally {
    await cancelQuietly(users.alice, bookingId);
  }
});

test("a second tab sees the free seats change without reloading", async ({ page, context }) => {
  await logIn(page, users.alice);
  const watcher = await context.newPage();
  await watcher.goto(`/events/${EVENT}?watch=1`);
  const seats = watcher.getByTestId("seats-left");
  await expect(seats).toBeVisible();
  const before = Number(await seats.innerText());

  const bookingId = await holdTicket(users.alice);
  try {
    await expect(seats).toHaveText(String(before - 1), { timeout: 5000 });
  } finally {
    await cancelQuietly(users.alice, bookingId);
  }
  await expect(seats).toHaveText(String(before), { timeout: 5000 });
});

test("cancelling a booking removes it and lowers the header counter at once; a refusal puts it back", async ({ page }) => {
  await logIn(page, users.alice);
  const first = await holdTicket(users.alice);
  const second = await holdTicket(users.alice);
  try {
    await page.goto("/me/bookings");
    const rowOf = (id: string) => page.locator("li", { has: page.locator(`a[href="/checkout/${id}"]`) });
    await expect(rowOf(first)).toHaveCount(1);
    await expect(rowOf(second)).toHaveCount(1);
    const startCount = await activeCount(page);
    expect(startCount).toBeGreaterThanOrEqual(2);

    // The server refuses: the row comes back, the counter too, and a message explains.
    await page.route("**/api/bookings/*", (route) => (route.request().method() === "DELETE" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL", message: "Something went wrong." }) }) : route.continue()));
    await rowOf(first).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "was not cancelled" })).toBeVisible();
    await expect(rowOf(first)).toHaveCount(1);
    await expect(page.getByTestId("active-bookings")).toHaveText(String(startCount));
    await page.unroute("**/api/bookings/*");

    // The server agrees: the row is gone and the counter went down by one, also after a reload.
    await rowOf(first).getByRole("button", { name: "Cancel" }).click();
    await expect(rowOf(first)).toHaveCount(0);
    await expect(page.getByTestId("active-bookings")).toHaveText(String(startCount - 1));
    await expect(rowOf(second)).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("active-bookings")).toHaveText(String(startCount - 1));
    await expect(rowOf(first)).toHaveCount(0);
  } finally {
    await cancelQuietly(users.alice, first);
    await cancelQuietly(users.alice, second);
  }
});

test("the sign-up form works with the keyboard and ties its errors to the field", async ({ page }) => {
  await page.goto("/register");
  // Wait until the page has finished loading its scripts, or a re-render could take the focus away.
  await page.waitForLoadState("networkidle");
  const focusUntil = async (isTarget: () => Promise<boolean>) => {
    for (let i = 0; i < 25 && !(await isTarget()); i++) await page.keyboard.press("Tab");
    expect(await isTarget()).toBe(true);
  };
  const focusedId = () => page.evaluate(() => document.activeElement?.id ?? "");

  await focusUntil(async () => (await focusedId()) === "auth-email");
  await page.keyboard.type(uniqueEmail());
  await page.keyboard.press("Tab");
  expect(await focusedId()).toBe("auth-password");
  await page.keyboard.type("abc"); // too short
  await page.keyboard.press("Enter");

  const password = page.locator("#auth-password");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  const describedBy = await password.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const errorText = await page.locator(`#${describedBy!.split(" ")[0]}`).innerText();
  expect(errorText.length).toBeGreaterThan(3);
  expect(errorText).not.toMatch(/ZodError|invalid_type|\[object/);

  // Now with a good password, again with the keyboard only.
  await page.locator("#auth-password").fill("Some-Long-Pass-123");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-email")).toBeVisible();
});

test("booking works with the keyboard", async ({ page }) => {
  await logIn(page, users.bob);
  await page.goto(`/events/${EVENT}?kb=1`);
  await expect(page.getByTestId("seats-left")).toBeVisible();
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Book") break;
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/checkout\/([0-9a-f-]{36})$/);
  const bookingId = page.url().split("/").pop() as string;
  await cancelQuietly(users.bob, bookingId);
});

test("coming back to the list with an in-app link shows an edit made meanwhile", async ({ page }) => {
  await page.goto("/");
  const firstLink = page.locator('a[href^="/events/"]').first();
  const id = Number((await firstLink.getAttribute("href"))!.split("/").pop());
  await firstLink.click();
  await page.waitForURL(/\/events\//);

  const admin = await apiAs(users.admin);
  const current = (await (await admin.get(`/api/events/${id}`)).json()) as { version: number; title: string };
  const title = `Edited while away ${Date.now()}`;
  try {
    const res = await admin.patch(`/api/events/${id}`, { data: { title, version: current.version } });
    expect(res.status()).toBe(200);
    // Wait out the page cache (5 s), then use only links inside the site, no reload.
    await page.waitForTimeout(6000);
    await page.getByRole("link", { name: "← All events" }).click();
    await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
    await page.locator(`a[href="/events/${id}"]`).first().click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 5000 });
  } finally {
    const latest = (await (await admin.get(`/api/events/${id}`)).json()) as { version: number };
    await admin.patch(`/api/events/${id}`, { data: { title: current.title, version: latest.version } });
    await admin.dispose();
  }
});

test("an administrator sees an Edit link on the event page and it opens the form; others do not", async ({ page, browser, baseURL: base }) => {
  // Not logged in: no link.
  await page.goto(`/events/${EVENT}?edit=anon`);
  await expect(page.getByTestId("seats-left")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit event" })).toHaveCount(0);

  // An ordinary user: no link.
  const userContext = await browser.newContext({ baseURL: base });
  const userPage = await userContext.newPage();
  await logIn(userPage, users.alice);
  await userPage.goto(`/events/${EVENT}?edit=user`);
  await expect(userPage.getByTestId("seats-left")).toBeVisible();
  await expect(userPage.getByRole("link", { name: "Edit event" })).toHaveCount(0);
  await userContext.close();

  // The administrator: the link is there and leads to the form.
  await logIn(page, users.admin);
  await page.goto(`/events/${EVENT}?edit=admin`);
  await page.getByRole("link", { name: "Edit event" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/events/${EVENT}$`));
  await expect(page.getByLabel("Title")).toBeVisible();

  // An anonymous visitor asking again right away must not get the administrator's page from the nginx copy.
  const again = await page.context().browser()!.newContext({ baseURL: base });
  const anon = await again.newPage();
  await anon.goto(`/events/${EVENT}?edit=admin`);
  await expect(anon.getByTestId("seats-left")).toBeVisible();
  await expect(anon.getByRole("link", { name: "Edit event" })).toHaveCount(0);
  await again.close();
});
