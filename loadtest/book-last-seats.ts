// Load test: 300 requests fight for the last 20 seats of one event.
// Expected result: exactly 20 answers "201 booked", 280 answers "409 sold out", and the database holds
// exactly 20 held seats (never more).
//
// Run it against a running stack (see the README):  pnpm loadtest
import { randomUUID } from "node:crypto";
import autocannon from "autocannon";

const baseUrl = process.env["BASE_URL"] ?? "http://localhost:8080";
const eventId = Number(process.env["EVENT_ID"] ?? 50);
const requests = Number(process.env["REQUESTS"] ?? 300);
const seats = Number(process.env["SEATS"] ?? 20);
const connections = Number(process.env["CONNECTIONS"] ?? 50);

const email = process.env["LOADTEST_EMAIL"] ?? "alice@example.com";
const password = process.env["SEED_ALICE_PASSWORD"] ?? "Alice-Demo-Pass-1";
const adminPassword = process.env["SEED_ADMIN_PASSWORD"] ?? "Admin-Demo-Pass-1";

const json = { "content-type": "application/json", origin: baseUrl };

async function login(who: string, pass: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: who, password: pass }) });
  if (!res.ok) throw new Error(`login of ${who} failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c?.startsWith("sid="));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

// The free-seat number may be up to 1 second old (that is the cache rule), so wait before trusting it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

/** Leaves exactly `seats` free seats: capacity = seats already taken + seats. */
async function prepareEvent(adminCookie: string): Promise<void> {
  await settle();
  const event = await getJson<{ capacity: number; version: number }>(`/api/events/${eventId}`);
  const free = await getJson<{ available: number }>(`/api/events/${eventId}/availability`);
  const taken = event.capacity - free.available;
  const res = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: "PATCH",
    headers: { ...json, cookie: adminCookie },
    body: JSON.stringify({ capacity: taken + seats, version: event.version }),
  });
  if (!res.ok) throw new Error(`could not prepare the event: ${res.status} ${await res.text()}`);
  await settle();
}

const adminCookie = await login("admin@example.com", adminPassword);
const userCookie = await login(email, password);
await prepareEvent(adminCookie);
const before = await getJson<{ available: number }>(`/api/events/${eventId}/availability`);
console.log(`Event ${eventId}: ${before.available} free seats, sending ${requests} booking requests (${connections} at a time)...`);

const result = await autocannon({
  url: `${baseUrl}/api/events/${eventId}/bookings`,
  method: "POST",
  connections,
  amount: requests,
  headers: { ...json, cookie: userCookie },
  requests: [
    {
      // A new Idempotency-Key for every request: these are 300 different attempts, not retries.
      setupRequest: (req) => ({ ...req, headers: { ...(req.headers as Record<string, string>), "idempotency-key": randomUUID() }, body: JSON.stringify({ quantity: 1 }) }),
    },
  ],
});

const stats: Record<string, { count?: number }> = result.statusCodeStats ?? {};
const count = (code: number) => stats[String(code)]?.count ?? 0;
const other = result.requests.total - count(201) - count(409);
const after = await getJson<{ available: number }>(`/api/events/${eventId}/availability`);

console.log("");
console.log(`  requests sent:        ${result.requests.total}`);
console.log(`  201 booked:           ${count(201)}`);
console.log(`  409 sold out:         ${count(409)}`);
console.log(`  anything else:        ${other}   (non-2xx total: ${result.non2xx})`);
console.log(`  free seats afterwards: ${after.available}`);
console.log(`  latency p50 / p97.5 / p99: ${result.latency.p50} / ${result.latency.p97_5} / ${result.latency.p99} ms`);
console.log(`  throughput:           ${result.requests.average} requests per second (average)`);

const ok = count(201) === seats && count(409) === requests - seats && after.available === 0 && other === 0;
console.log(ok ? "\nPASS: exactly the free seats were sold, nothing more." : "\nFAIL: the numbers above are not what was expected.");
process.exit(ok ? 0 : 1);
