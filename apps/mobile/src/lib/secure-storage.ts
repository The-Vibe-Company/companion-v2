import * as SecureStore from "expo-secure-store";

const chunkSize = 1_800;
const indexKey = (key: string) => `${key}__chunks`;
const chunkKey = (key: string, index: number) => `${key}__${index}`;

async function readCount(key: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(indexKey(key));
  const count = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function clearChunks(key: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await SecureStore.deleteItemAsync(chunkKey(key, index));
  }
  await SecureStore.deleteItemAsync(indexKey(key));
}

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    const count = await readCount(key);
    if (count === 0) return null;
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const part = await SecureStore.getItemAsync(chunkKey(key, index));
      if (part === null) {
        await clearChunks(key, count);
        return null;
      }
      parts.push(part);
    }
    return parts.join("");
  },

  async setItem(key: string, value: string): Promise<void> {
    await clearChunks(key, await readCount(key));
    const chunks = Array.from(
      { length: Math.ceil(value.length / chunkSize) },
      (_, index) => value.slice(index * chunkSize, (index + 1) * chunkSize),
    );
    for (const [index, chunk] of chunks.entries()) {
      await SecureStore.setItemAsync(chunkKey(key, index), chunk);
    }
    await SecureStore.setItemAsync(indexKey(key), String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    await clearChunks(key, await readCount(key));
  },
};
