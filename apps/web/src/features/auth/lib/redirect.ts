/** Where to go after logging in. Only a path on this site is accepted, never another address. */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.includes("\n") || raw.includes("\r")) return "/";
  return raw;
}
