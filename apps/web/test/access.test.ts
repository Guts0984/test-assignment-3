import { describe, expect, it } from "vitest";
import { areaOf, decideAccess, loginUrlPath } from "../src/shared/lib/access";

describe("which pages are closed", () => {
  it.each([
    ["/me/bookings", "user"],
    ["/me", "user"],
    ["/checkout/6f1c3a52-0000-4000-8000-000000000000", "user"],
    ["/admin/events/7", "admin"],
    ["/admin", "admin"],
  ])("%s needs %s", (path, area) => expect(areaOf(path)).toBe(area));

  it.each(["/", "/events/7", "/login", "/register", "/mexico", "/administrator", "/checkouts", "/events/admin"])(
    "%s is public",
    (path) => expect(areaOf(path)).toBeUndefined(),
  );
});

describe("what happens to each kind of visitor", () => {
  it("sends a visitor who is not logged in to the login page, remembering where they wanted to go", () => {
    expect(decideAccess("user", "none", "/me/bookings")).toEqual({ kind: "login", next: "/me/bookings" });
    expect(decideAccess("admin", "none", "/admin/events/7")).toEqual({ kind: "login", next: "/admin/events/7" });
  });
  it("refuses an ordinary user on an administrator page with 403, but not on their own pages", () => {
    expect(decideAccess("admin", "user", "/admin/events/7")).toEqual({ kind: "forbidden" });
    expect(decideAccess("user", "user", "/me/bookings")).toEqual({ kind: "allow" });
  });
  it("lets an administrator into both kinds of page", () => {
    expect(decideAccess("admin", "admin", "/admin/events/7")).toEqual({ kind: "allow" });
    expect(decideAccess("user", "admin", "/me/bookings")).toEqual({ kind: "allow" });
  });
  it("never blocks public pages, whoever asks", () => {
    for (const session of ["none", "user", "admin"] as const) expect(decideAccess(undefined, session, "/")).toEqual({ kind: "allow" });
  });
  it("encodes the page to come back to, so it cannot break out of the address", () => {
    expect(loginUrlPath("/admin/events/7?x=1&y=2")).toBe("/login?next=%2Fadmin%2Fevents%2F7%3Fx%3D1%26y%3D2");
  });
});
