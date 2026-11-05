import { Suspense } from "react";
import { MyBookingsContent } from "@/features/my-bookings/server";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata = { title: "My bookings" };

export default function MyBookingsPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">My bookings</h1>
      <Suspense fallback={<MyBookingsSkeleton />}>
        <MyBookingsContent />
      </Suspense>
    </main>
  );
}

function MyBookingsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading your bookings">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-20" />
      ))}
    </div>
  );
}
