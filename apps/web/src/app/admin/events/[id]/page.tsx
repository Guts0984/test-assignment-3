import { Suspense } from "react";
import { AdminEventContent } from "@/features/admin-event/server";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata = { title: "Edit event" };

async function Content(props: PageProps<"/admin/events/[id]">) {
  const { id } = await props.params;
  return <AdminEventContent rawId={id} />;
}

export default function AdminEventPage(props: PageProps<"/admin/events/[id]">) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Edit event</h1>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Content {...props} />
      </Suspense>
    </main>
  );
}
