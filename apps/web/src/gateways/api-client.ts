import type { paths } from "@1brc/api";
import createClient from "openapi-fetch";

export const apiClient = createClient<paths>({
  baseUrl: window.location.origin,
});

export async function apiResult<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await request;
  if (response.ok) return data as T;
  const detail = error as { error?: { message?: unknown } } | undefined;
  throw new Error(
    typeof detail?.error?.message === "string"
      ? detail.error.message
      : `API request failed (${response.status})`,
  );
}

export function apiUrl(
  pathname: keyof paths,
  query?: Record<string, string | undefined>,
) {
  const url = new URL(pathname, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url;
}
