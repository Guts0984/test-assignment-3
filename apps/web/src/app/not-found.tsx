import Link from "next/link";
import { Button } from "@/shared/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-12 text-center">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Button asChild>
        <Link href="/">See all events</Link>
      </Button>
    </main>
  );
}
