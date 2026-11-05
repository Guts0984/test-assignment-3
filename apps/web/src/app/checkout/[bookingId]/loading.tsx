import { Skeleton } from "@/shared/ui/skeleton";

export default function Loading() {
  return (
    <main className="px-4 py-10" aria-busy="true" aria-label="Loading checkout">
      <Skeleton className="mx-auto h-64 w-full max-w-lg" />
    </main>
  );
}
