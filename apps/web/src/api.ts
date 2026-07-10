import type { ApiType } from "@1brc/server";
import { hc } from "hono/client";

export const rpc = hc<ApiType>("/api/v1");

export async function apiJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | T
    | null;
  if (!response.ok) {
    const errorMessage =
      body && typeof body === "object" && "error" in body
        ? body.error?.message
        : undefined;
    throw new Error(errorMessage ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export function formatDuration(nanoseconds: string | null): string {
  if (!nanoseconds) return "—";
  const seconds = Number(nanoseconds) / 1_000_000_000;
  if (seconds < 1) return `${(seconds * 1000).toFixed(2)} ms`;
  return `${seconds.toFixed(3)} s`;
}

export function formatBytes(value: string | number): string {
  const bytes = Number(value);
  const units = ["B", "KiB", "MiB", "GiB"];
  let number = bytes;
  let index = 0;
  while (number >= 1024 && index < units.length - 1) {
    number /= 1024;
    index += 1;
  }
  return `${number.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
