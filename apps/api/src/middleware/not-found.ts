import type { RequestHandler } from "express";
import { notFound } from "../lib/app-error";

export const notFoundHandler: RequestHandler = (req) => {
  throw notFound(`There is no route ${req.method} ${req.path}.`);
};
