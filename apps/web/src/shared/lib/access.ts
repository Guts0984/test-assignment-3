/**
 * Who may open which pages. Pure rules, no network, so they are easy to test.
 * The proxy (src/proxy.ts) applies them before any page is sent, which is what makes the status code real
 * (a page that decides while it is being streamed has already said "200").
 */
export type Area = "user" | "admin";
export type Session = "none" | "user" | "admin";
export type Access = { kind: "allow" } | { kind: "login"; next: string } | { kind: "forbidden" };

const segmentOf = (pathname: string): string => pathname.split("/")[1] ?? "";

/** The pages that need a login (`user`) or an administrator (`admin`); everything else is public. */
export function areaOf(pathname: string): Area | undefined {
  const first = segmentOf(pathname);
  if (first === "admin") return "admin";
  if (first === "me" || first === "checkout") return "user";
  return undefined;
}

export function decideAccess(area: Area | undefined, session: Session, wanted: string): Access {
  if (area === undefined) return { kind: "allow" };
  if (session === "none") return { kind: "login", next: wanted };
  if (area === "admin" && session !== "admin") return { kind: "forbidden" };
  return { kind: "allow" };
}

/** The login page, with the page to come back to after logging in. */
export const loginUrlPath = (next: string): string => `/login?next=${encodeURIComponent(next)}`;
