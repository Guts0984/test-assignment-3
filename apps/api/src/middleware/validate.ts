import { issuesToFieldErrors } from "@app/shared";
import type { Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { validationFailed } from "../lib/app-error";

interface Schemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

type Input<S extends Schemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

const sources = ["params", "query", "body"] as const;

export function validated<S extends Schemas>(
  schemas: S,
  handler: (
    input: Input<S>,
    req: Request,
    res: Response,
  ) => Promise<void> | void,
): RequestHandler {
  return async (req, res) => {
    const parsed: Partial<Record<(typeof sources)[number], unknown>> = {};
    let fields: Record<string, string[]> = {};

    for (const source of sources) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (result.success) {
        parsed[source] = result.data;
      } else {
        fields = {
          ...fields,
          ...issuesToFieldErrors(result.error.issues, source),
        };
      }
    }

    if (Object.keys(fields).length > 0) throw validationFailed(fields);

    await handler(parsed as Input<S>, req, res);
  };
}
