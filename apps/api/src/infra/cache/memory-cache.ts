export interface MemoryCache<V> {
  /** The stored value (even `null`), or undefined if absent or expired. */
  get: (key: string) => { value: V } | undefined;
  set: (key: string, value: V, ttlMs: number) => void;
  delete: (key: string) => void;
  clear: () => void;
  size: () => number;
}

export interface MemoryCacheOptions {
  /** When full, the entry that was used least recently is dropped. */
  maxEntries: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** Level 1: lives in this process only. A Map remembers insertion order, which gives us LRU. */
export function createMemoryCache<V>({ maxEntries, now = Date.now }: MemoryCacheOptions): MemoryCache<V> {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be at least 1");
  const entries = new Map<string, Entry<V>>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= now()) return undefined;
      entries.set(key, entry); // re-insert: now the most recently used
      return { value: entry.value };
    },

    set(key, value, ttlMs) {
      if (ttlMs <= 0) return;
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },

    delete: (key) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}
