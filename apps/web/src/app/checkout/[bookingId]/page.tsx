import { Suspense } from "react";
import { CheckoutContent } from "@/features/checkout/server";
import { Skeleton } from "@/shared/ui/skeleton";

export const metadata = { title: "Checkout" };

async function Checkout(props: PageProps<"/checkout/[bookingId]">) {
  const { bookingId } = await props.params;
  return <CheckoutContent bookingId={bookingId} />;
}

export default function CheckoutPage(props: PageProps<"/checkout/[bookingId]">) {
  return (
    <main className="px-4 py-10">
      <Suspense fallback={<Skeleton className="mx-auto h-64 w-full max-w-lg" />}>
        <Checkout {...props} />
      </Suspense>
    </main>
  );
}
