import { verifyInternalRequest } from "@app/shared/internal";
import type { RequestHandler, Response } from "express";

export interface ClientIdentity {
  /** The visitor's address, as far as we can trust it. */
  ip: string;
  /** A call from our own web server or worker that is not on behalf of a visitor (e.g. cached page data). */
  internal: boolean;
}

/**
 * Works out who is really calling:
 *  1. A signed call from our web server says which visitor it speaks for. The signature needs the
 *     shared secret, so a browser cannot fake it.
 *  2. Otherwise the address nginx saw (Express reads it from X-Forwarded-For, trusting exactly one
 *     proxy hop, and nginx overwrites that header, so a value sent by the browser is discarded).
 *  3. Otherwise the connection's own address.
 * Headers a browser might send to claim an address (X-End-User-IP without a valid signature) are ignored.
 */
export function createClientIdentity(internalSecret: string): RequestHandler {
  return (req, res, next) => {
    const check = verifyInternalRequest(internalSecret, req.headers);
    const identity: ClientIdentity = check.trusted
      ? { ip: check.ip ?? "internal", internal: check.ip === undefined }
      : { ip: req.ip ?? req.socket.remoteAddress ?? "unknown", internal: false };
    res.locals["client"] = identity;
    next();
  };
}

export function getClient(res: Response): ClientIdentity {
  const value: unknown = res.locals["client"];
  if (typeof value === "object" && value !== null && "ip" in value && "internal" in value) {
    return value as ClientIdentity;
  }
  return { ip: "unknown", internal: false };
}
