import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { isBookingId } from "@app/shared";
import { getMyBooking } from "@/features/booking/server";
import { CheckoutPanel } from "./components/checkout-panel";
import { isApiRequestError } from "@/shared/api/api-client";
import { serverNowMs } from "@/shared/lib/clock";

/** The checkout for one booking, read for the logged-in visitor. Dynamic: depends on who asks and on the time. */
export async function CheckoutContent({ bookingId }: { bookingId: string }) {
  await connection(); // the page shows the time left, so it must be made per request
  if (!isBookingId(bookingId)) notFound();
  const booking = await getMyBooking(bookingId).catch((error: unknown) => {
    if (isApiRequestError(error) && error.status === 401) redirect(`/login?next=${encodeURIComponent(`/checkout/${bookingId}`)}`);
    throw error;
  });
  if (!booking) notFound();
  return <CheckoutPanel booking={booking} serverNowMs={serverNowMs()} />;
}
