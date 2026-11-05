import "server-only";
import { myBookingSchema, myBookingsResponseSchema } from "@app/shared";
import { apiCall, apiCallOrNull } from "@/shared/api/api-client";
import { getRequestContext } from "@/shared/api/request-context";

/** Your bookings and how many are active. Per visitor: never cached. */
export async function getMyBookings() {
  const context = await getRequestContext();
  return apiCall("/me/bookings", myBookingsResponseSchema, context);
}

/** One of your bookings, or null if it does not exist or is not yours. */
export async function getMyBooking(id: string) {
  const context = await getRequestContext();
  return apiCallOrNull(`/bookings/${encodeURIComponent(id)}`, myBookingSchema, context);
}
