import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { runWithRequestId } from "../infra/request-context";

export const REQUEST_ID_HEADER = "x-request-id";

const acceptableId = /^[A-Za-z0-9._-]{8,128}$/;

/** Uses the id nginx (or web) sent if it looks sane, otherwise makes a new one. */
export function pickRequestId(incoming: string | undefined): string {
  return incoming && acceptableId.test(incoming) ? incoming : randomUUID();
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = pickRequestId(req.header(REQUEST_ID_HEADER));
  res.setHeader(REQUEST_ID_HEADER, id);
  runWithRequestId(id, next);
};
