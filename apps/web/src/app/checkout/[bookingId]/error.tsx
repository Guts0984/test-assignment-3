"use client";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";

export default function CheckoutError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-12">
      <Alert variant="destructive" role="alert">
        <AlertTitle>We could not load this booking</AlertTitle>
        <AlertDescription>Please try again. Your seats stay held until the time runs out.</AlertDescription>
      </Alert>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
