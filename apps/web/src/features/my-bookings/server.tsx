import { redirect } from "next/navigation";
import { getMyBookings } from "@/features/booking/server";
import { isApiRequestError } from "@/shared/api/api-client";
import { MyBookingsList } from "./components/my-bookings-list";

export async function MyBookingsContent() {
  const { items } = await getMyBookings().catch((error: unknown) => {
    if (isApiRequestError(error) && error.status === 401) redirect(`/login?next=${encodeURIComponent("/me/bookings")}`);
    throw error;
  });
  return <MyBookingsList items={items} />;
}
