import { expect, test } from "@playwright/test";
import { baseURL } from "./helpers";

// This file runs last: it uses up the request limit of this machine's address on purpose, then waits for it to end.
test("when the api refuses the seat count (429), the rest of the event card still shows", async ({ page, request }) => {
  let refused = false;
  for (let round = 0; round < 20 && !refused; round++) {
    const batch = await Promise.all(Array.from({ length: 60 }, () => request.get("/api/cities")));
    refused = batch.some((r) => r.status() === 429);
  }
  expect(refused, "the limit was never reached").toBe(true);

  try {
    await page.route("**/api/events/*/stream", (route) => route.abort());
    const response = await page.goto(`/events/5?limit=1`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("The number of free seats is not available right now")).toBeVisible();
    await expect(page.getByText("The rest of the page still works.")).toBeVisible();
  } finally {
    // Leave the limit window before the next program (the load test) starts.
    await expect(async () => {
      const res = await fetch(`${baseURL}/api/cities`);
      expect(res.status).toBe(200);
    }).toPass({ timeout: 90_000, intervals: [2000] });
  }
});
