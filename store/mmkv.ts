import { createMMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/** Single MMKV instance for all zustand persisted stores (auth tokens stay in SecureStore). */
export const mmkv = createMMKV({ id: 'vai-storage' });

export const mmkvStorage: StateStorage = {
  setItem: (key: string, value: string) => {
    mmkv.set(key, value);
  },
  getItem: (key: string) => mmkv.getString(key) ?? null,
  removeItem: (key: string) => {
    mmkv.remove(key);
  },
};
