import Link from "next/link";
import { Suspense } from "react";
import { LogoutButton } from "@/features/auth";
import { getSessionUser } from "@/features/auth/server";
import { ActiveBookingsLink } from "@/features/booking";
import { getMyBookings } from "@/features/booking/server";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";

async function UserArea() {
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Log in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/register">Sign up</Link>
        </Button>
      </div>
    );
  }
  // If the count cannot be read, the header still works; it just shows 0.
  const activeCount = await getMyBookings()
    .then((r) => r.activeCount)
    .catch(() => 0);
  return (
    <div className="flex items-center gap-4">
      {user.role === "admin" && (
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Admin
        </span>
      )}
      <ActiveBookingsLink serverCount={activeCount} />
      <span
        className="hidden text-sm text-muted-foreground sm:inline"
        data-testid="user-email"
      >
        {user.email}
      </span>
      <LogoutButton />
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Event Tickets
        </Link>
        <nav aria-label="Account">
          <Suspense fallback={<Skeleton className="h-8 w-48" />}>
            <UserArea />
          </Suspense>
        </nav>
      </div>
    </header>
  );
}
