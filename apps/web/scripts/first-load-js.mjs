// Prints "First Load JS" for every page: the JavaScript (gzip size) a browser downloads on the first visit.
// Next.js 16 no longer prints this itself, so it is worked out here from the files `next build` wrote.
//
//   node scripts/first-load-js.mjs [path to the .next folder]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const nextDir = process.argv[2] ?? ".next";
const buildManifest = JSON.parse(readFileSync(join(nextDir, "build-manifest.json"), "utf8"));
// Files every page needs.
const shared = [...(buildManifest.polyfillFiles ?? []), ...(buildManifest.rootMainFiles ?? [])];

const gzipKb = (file) => gzipSync(readFileSync(join(nextDir, file))).length / 1024;

function manifestsIn(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return manifestsIn(path);
    return name === "page_client-reference-manifest.js" ? [path] : [];
  });
}

const rows = manifestsIn(join(nextDir, "server", "app")).flatMap((path) => {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(readFileSync(path, "utf8"), sandbox);
  return Object.entries(sandbox.globalThis.__RSC_MANIFEST ?? {}).map(([route, manifest]) => {
    const own = Object.values(manifest.entryJSFiles ?? {}).flat();
    const files = [...new Set([...shared, ...own])].map((f) => f.replace(/^\/?(_next\/)?/, "")).filter((f) => f.endsWith(".js"));
    const kb = files.reduce((sum, f) => sum + gzipKb(f), 0);
    return { route: route.replace(/\/page$/, "") || "/", kb, count: files.length, file: relative(nextDir, path) };
  });
});

console.log("Route".padEnd(34), "First Load JS (gzip)", " files");
for (const row of rows.sort((a, b) => a.route.localeCompare(b.route))) {
  console.log(row.route.padEnd(34), `${row.kb.toFixed(1)} kB`.padStart(12).padEnd(20), String(row.count).padStart(5));
}
console.log("Shared by every page:", `${shared.reduce((s, f) => s + gzipKb(f), 0).toFixed(1)} kB`);
