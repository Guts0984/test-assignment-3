import "server-only";
import { publicUserSchema, type PublicUser } from "@app/shared";
import { apiCall, isApiRequestError } from "@/shared/api/api-client";
import { getRequestContext } from "@/shared/api/request-context";

/** The logged-in visitor, or null. Reads the visitor's cookie, so it only works inside Suspense. */
export async function getSessionUser(): Promise<PublicUser | null> {
  const context = await getRequestContext();
  if (!context.cookie) return null;
  try {
    return await apiCall("/me", publicUserSchema, context);
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return null;
    throw error;
  }
}
