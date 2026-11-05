import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface StreamMessage {
  event: string;
  data: unknown;
}

export interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  messages: StreamMessage[];
  comments: string[];
  /** The raw text received so far. */
  raw: () => string;
  ended: () => boolean;
  /** Resolves when `check` is true (looked at every 10 ms), or fails after `ms`. */
  waitFor: (check: () => boolean, ms?: number, what?: string) => Promise<void>;
  close: () => void;
}

export interface ListeningApp {
  port: number;
  open: (path: string, headers?: Record<string, string>) => Promise<OpenStream>;
  stop: () => Promise<void>;
}

/** Puts an app on a real port, so streams can stay open (supertest would wait for the end). */
export async function listen(app: Express): Promise<ListeningApp> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const streams: OpenStream[] = [];

  return {
    port,
    open: async (path, headers = {}) => {
      const stream = await openStream(port, path, headers);
      streams.push(stream);
      return stream;
    },
    stop: async () => {
      for (const stream of streams) stream.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function openStream(port: number, path: string, headers: Record<string, string> = {}): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path, headers, agent: false }, (response) => {
      let text = "";
      let finished = false;
      const messages: StreamMessage[] = [];
      const comments: string[] = [];

      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        for (const block of text.split("\n\n").slice(0, -1)) {
          const lines = block.split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (event !== undefined && data !== undefined) messages.push({ event, data: JSON.parse(data) });
          for (const line of lines) if (line.startsWith(":")) comments.push(line);
        }
        text = text.slice(text.lastIndexOf("\n\n") + 2);
      });
      response.on("end", () => {
        finished = true;
      });
      response.on("error", () => {
        finished = true;
      });

      let raw = "";
      response.on("data", (chunk: string) => {
        raw += chunk;
      });

      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        messages,
        comments,
        raw: () => raw,
        ended: () => finished,
        waitFor: async (check, ms = 2000, what = "the expected message") => {
          const until = Date.now() + ms;
          while (!check()) {
            if (Date.now() > until) throw new Error(`timed out waiting for ${what}. Received: ${JSON.stringify(messages)}`);
            await new Promise((r) => setTimeout(r, 10));
          }
        },
        close: () => {
          request.destroy();
        },
      });
    });
    request.on("error", reject);
  });
}
