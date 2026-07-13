import type { ApiType } from "@1brc/server";
import {
  DetailedError,
  hc,
  parseResponse,
  type ClientResponse,
} from "hono/client";

export const rpc = hc<ApiType>(new URL("/api/v1", window.location.origin).href);

export async function rpcResult<T extends ClientResponse<unknown>>(
  response: T | Promise<T>,
) {
  try {
    return await parseResponse(response);
  } catch (error) {
    if (error instanceof DetailedError) {
      const message = error.detail?.data?.error?.message;
      if (typeof message === "string") throw new Error(message);
    }
    throw error;
  }
}
