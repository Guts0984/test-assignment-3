import { expect, test } from "@playwright/test";
import { apiAs, baseURL, logIn, uniqueEmail, users } from "./helpers";

// Event 1 is edited by these tests; the numbers below are set by the tests themselves.
const EVENT = 7;

async function setCapacity(capacity: number) {
  const admin = await apiAs(users.admin);
  const current = await (await admin.get(`/api/events/${EVENT}`)).json();
  const res = await admin.patch(`/api/events/${EVENT}`, { data: { capacity, version: current.version } });
  expect(res.status(), await res.text()).toBe(200);
  await admin.dispose();
}

async function freeSeats(): Promise<number> {
  const res = await fetch(`${baseURL}/api/events/${EVENT}/availability`);
  return ((await res.json()) as { available: number }).available;
}

test("a visitor registers, books tickets and confirms them", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password").fill("Some-Long-Pass-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("user-email")).toBeVisible();

  await page.goto(`/events/${EVENT}`);
  const before = Number(await page.getByTestId("seats-left").innerText());
  await page.locator("#booking-quantity").selectOption("2");
  await page.getByRole("button", { name: "Book" }).click();

  await page.waitForURL(/\/checkout\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("countdown")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("This booking is confirmed")).toBeVisible();

  await page.goto("/me/bookings");
  await expect(page.getByText(/confirmed/i).first()).toBeVisible();
  expect(await freeSeats()).toBeLessThanOrEqual(before - 2);
});

test("booking more seats than are left (stale page) is refused, rolled back and changes nothing", async ({ page }) => {
  // Leave exactly 3 free seats.
  const admin = await apiAs(users.admin);
  const event = await (await admin.get(`/api/events/${EVENT}`)).json();
  const taken = event.capacity - (await freeSeats());
  await admin.dispose();
  await setCapacity(taken + 3);

  await logIn(page, users.alice);
  // Block the live seat updates so this page keeps showing the old number (like a slow connection).
  await page.route("**/api/events/*/stream", (route) => route.abort());
  await page.goto(`/events/${EVENT}`);
  await expect(page.getByTestId("seats-left")).toHaveText("3");

  const bob = await apiAs(users.bob);
  const grab = await bob.post(`/api/events/${EVENT}/bookings`, { data: { quantity: 2 }, headers: { "Idempotency-Key": crypto.randomUUID() } });
  expect(grab.status()).toBe(201);
  await bob.dispose();

  await page.locator("#booking-quantity").selectOption("3");
  await page.getByRole("button", { name: "Book" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/events/${EVENT}$`));
  expect(await freeSeats()).toBe(1);
  await setCapacity(300);
});

test("an event that does not exist gives a real 404", async ({ page }) => {
  const response = await page.goto("/events/999999");
  expect(response?.status()).toBe(404);
  await expect(page.getByText(/not found|no such event|does not exist/i).first()).toBeVisible();
});

test("a booking of one user is invisible to another", async ({ page, browser }) => {
  await logIn(page, users.alice);
  await page.goto(`/events/${EVENT}`);
  await page.getByRole("button", { name: "Book" }).click();
  await page.waitForURL(/\/checkout\/([0-9a-f-]{36})$/);
  const bookingId = page.url().split("/").pop() as string;

  const other = await browser.newContext({ baseURL });
  const bobPage = await other.newPage();
  await logIn(bobPage, users.bob);
  // (The status is 200 because this private page streams; the content is the "not found" page.)
  await bobPage.goto(`/checkout/${bookingId}`);
  await expect(bobPage.getByText("Page not found")).toBeVisible();
  expect((await (await bobPage.request.get(`/api/bookings/${bookingId}`)).status())).toBe(404);
  await bobPage.goto("/me/bookings");
  await expect(bobPage.locator(`a[href="/checkout/${bookingId}"]`)).toHaveCount(0);
  await other.close();
  await page.getByRole("button", { name: "Cancel booking" }).click();
});

test("an administrator's edit shows on the event page and in the list within 5 seconds", async ({ page }) => {
  await logIn(page, users.admin);
  await page.goto(`/admin/events/${EVENT}`);
  const title = `Edited by e2e ${Date.now()}`;
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: /save/i }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // A visitor who is not logged in sees it soon (nginx keeps pages for up to 5 seconds).
  const anon = await page.context().browser()!.newContext({ baseURL });
  const visitor = await anon.newPage();
  await expect(async () => {
    await visitor.goto(`/events/${EVENT}`);
    await expect(visitor.getByRole("heading", { name: title })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 8000, intervals: [500] });
  await anon.close();
});

test("a stale admin form shows the conflict and keeps what was typed", async ({ page }) => {
  await logIn(page, users.admin);
  await page.goto(`/admin/events/${EVENT}`);
  // Someone else saves first.
  const other = await apiAs(users.admin);
  const current = await (await other.get(`/api/events/${EVENT}`)).json();
  const res = await other.patch(`/api/events/${EVENT}`, { data: { title: "Saved by someone else", version: current.version } });
  expect(res.status()).toBe(200);
  await other.dispose();

  await page.getByLabel("Title").fill("My stale edit");
  await page.getByRole("button", { name: /save/i }).click();
  await expect(page.getByText("Someone else saved this event while you were editing")).toBeVisible();
  await expect(page.getByTestId("saved-title")).toHaveText("Saved by someone else");
  await expect(page.getByLabel("Title")).toHaveValue("My stale edit");
});

test("nginx keeps public pages for anonymous visitors only", async ({ request, page }) => {
  const url = `/events/${EVENT}`;
  await request.get(url);
  const second = await request.get(url);
  expect(second.headers()["x-cache-status"]).toBe("HIT");

  await logIn(page, users.alice);
  const res = await page.goto(url);
  expect(res?.headers()["x-cache-status"]).toBe("BYPASS");
});
