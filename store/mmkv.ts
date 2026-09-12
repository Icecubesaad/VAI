import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/**
 * Lazy MMKV with in-memory fallback. `createMMKV` at module scope bricked
 * release boots when the Nitro native module failed to load, and zustand
 * `persist` rehydrates (touches storage) during store-module import — so the
 * throw fired inside the _layout import graph with no boundary to catch it.
 * Creation is now deferred to first use and any failure degrades to a
 * session-scoped Map: data doesn't persist, but the app boots.
 * (Auth tokens stay in SecureStore regardless — never here.)
 */
const memory = new Map<string, string>();

let _mmkv: MMKV | null = null;
let _degraded = false;

/** Never throws — returns null when the native module is unavailable. */
function getMMKV(): MMKV | null {
  if (_mmkv) return _mmkv;
  if (_degraded) return null;
  try {
    _mmkv = createMMKV({ id: 'vai-storage' });
    return _mmkv;
  } catch {
    _degraded = true;
    return null;
  }
}

/** Single MMKV instance for all zustand persisted stores. Lazily created; safe to import. */
export const mmkv: MMKV = new Proxy({} as MMKV, {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    const inst = getMMKV();
    if (!inst) {
      if (prop === 'getString') return (key: string) => memory.get(key) ?? undefined;
      if (prop === 'set') {
        return (key: string, value: string) => {
          memory.set(key, value);
        };
      }
      if (prop === 'remove') return (key: string) => memory.delete(key);
      if (prop === 'getAllKeys') return () => [...memory.keys()];
      if (prop === 'contains') return (key: string) => memory.has(key);
      if (prop === 'clearAll') {
        return () => {
          memory.clear();
        };
      }
      if (prop === 'id') return 'vai-storage-memory';
      return undefined;
    }
    const value = (inst as unknown as Record<string, unknown>)[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(inst)
      : value;
  },
});

export const mmkvStorage: StateStorage = {
  setItem: (key: string, value: string) => {
    try {
      const inst = getMMKV();
      if (inst) inst.set(key, value);
      else memory.set(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  getItem: (key: string) => {
    try {
      return getMMKV()?.getString(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  removeItem: (key: string) => {
    try {
      getMMKV()?.remove(key);
    } catch {
      /* degraded — fall through to memory */
    }
    memory.delete(key);
  },
};
