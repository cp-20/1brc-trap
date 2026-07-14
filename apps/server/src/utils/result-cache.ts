import { ResultAsync, type Result } from "neverthrow";

export function createResultCache<T, E>(ttlMs: number) {
  const entries = new Map<
    string,
    { expiresAt: number; promise: Promise<Result<T, E>> }
  >();

  return (key: string, load: () => ResultAsync<T, E>) => {
    const now = Date.now();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now) {
      return new ResultAsync(cached.promise);
    }

    const promise = Promise.resolve(load());
    entries.set(key, { expiresAt: now + ttlMs, promise });
    setTimeout(() => {
      if (entries.get(key)?.promise === promise) entries.delete(key);
    }, ttlMs).unref?.();
    return new ResultAsync(promise);
  };
}
