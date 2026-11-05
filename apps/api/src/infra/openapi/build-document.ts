import { apiErrorSchema } from "@app/shared";
import { z } from "zod";

type HttpMethod = "get" | "post" | "patch" | "put" | "delete";

export interface ResponseDoc {
  description: string;
  schema?: z.ZodType;
}

export interface RouteDoc {
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  request?: {
    params?: z.ZodType;
    query?: z.ZodType;
    headers?: z.ZodType;
    body?: z.ZodType;
  };
  responses: Record<number, ResponseDoc>;
  requiresSession?: boolean;
}

type JsonObject = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as JsonObject;
  return Object.fromEntries(
    Object.entries(json).filter(([key]) => key !== "$schema"),
  );
}

function toParameters(
  schema: z.ZodType | undefined,
  location: "path" | "query" | "header",
): JsonObject[] {
  if (!schema) return [];
  const json = toJsonSchema(schema, "input");
  const properties = (json["properties"] ?? {}) as Record<string, JsonObject>;
  const required = new Set((json["required"] ?? []) as string[]);

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: propertySchema,
  }));
}

function toOperation(route: RouteDoc): JsonObject {
  const { request = {}, responses } = route;
  return {
    summary: route.summary,
    tags: route.tags,
    parameters: [
      ...toParameters(request.params, "path"),
      ...toParameters(request.query, "query"),
      ...toParameters(request.headers, "header"),
    ],
    ...(request.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: toJsonSchema(request.body, "input"),
              },
            },
          },
        }
      : {}),
    ...(route.requiresSession ? { security: [{ sessionCookie: [] }] } : {}),
    responses: Object.fromEntries(
      Object.entries(responses).map(([status, response]) => [
        status,
        {
          description: response.description,
          ...(response.schema
            ? {
                content: {
                  "application/json": {
                    schema: toJsonSchema(response.schema, "output"),
                  },
                },
              }
            : {}),
        },
      ]),
    ),
  };
}

const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

export const errorResponse = (description: string): ResponseDoc => ({
  description,
  schema: apiErrorSchema,
});

export interface DocumentInfo {
  title: string;
  version: string;
  description?: string;
}

export function buildOpenApiDocument(
  info: DocumentInfo,
  routes: readonly RouteDoc[],
): JsonObject {
  const paths = routes.reduce<Record<string, JsonObject>>((acc, route) => {
    const path = toOpenApiPath(route.path);
    return {
      ...acc,
      [path]: { ...acc[path], [route.method]: toOperation(route) },
    };
  }, {});

  return {
    openapi: "3.1.0",
    info,
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "sid",
          description:
            "Leave this empty. The session cookie is set by POST /auth/login and the browser sends it by itself. Log in with that endpoint first.",
        },
      },
    },
  };
}
