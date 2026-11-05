"use client";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";

/** Shown when a whole page fails. A failure in one block of a page is handled inside that block instead. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-12">
      <Alert variant="destructive" role="alert">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>We could not load this page. Please try again in a moment.</AlertDescription>
      </Alert>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
