import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const monorepoRoot = fileURLToPath(new URL("../../", import.meta.url));

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image.
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  // @app/shared exports TypeScript source, so Next has to compile it.
  transpilePackages: ["@app/shared"],
  // Public data is cached with `use cache` + tags (see features/event/queries.ts).
  cacheComponents: true,
  // Must stay false: with it on, a request for a missing event is answered 200 (the page shell is sent
  // before notFound() runs) instead of 404.
  partialPrefetching: false,
  poweredByHeader: false,
};

export default nextConfig;
