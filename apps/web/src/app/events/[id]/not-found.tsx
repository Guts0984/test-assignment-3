import Link from "next/link";
import { Button } from "@/shared/ui/button";

export default function EventNotFound() {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-12 text-center">
      <h1 className="text-3xl font-semibold">Event not found</h1>
      <p className="text-muted-foreground">This event does not exist, or it was removed.</p>
      <Button asChild>
        <Link href="/">See all events</Link>
      </Button>
    </main>
  );
}
