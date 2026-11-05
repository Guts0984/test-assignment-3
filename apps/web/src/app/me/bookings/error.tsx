"use client";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";

export default function MyBookingsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-12">
      <Alert variant="destructive" role="alert">
        <AlertTitle>We could not load your bookings</AlertTitle>
        <AlertDescription>Please try again in a moment.</AlertDescription>
      </Alert>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
