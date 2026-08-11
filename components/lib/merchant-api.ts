"use client";

import { authenticatedFetch } from "@/components/lib/shopify-fetch";

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
};

export class MerchantRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MerchantRequestError";
  }
}

/**
 * JSON client for merchant APIs. Authentication still happens in
 * `authenticatedFetch`; this layer makes every component handle the same error
 * shape and never mistake an HTML/login response for a successful mutation.
 */
export async function merchantJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await authenticatedFetch(input, { ...init, headers });
  const body = await readBody(response);
  if (!response.ok) {
    const error = isRecord(body) ? (body as ApiErrorBody).error : undefined;
    throw new MerchantRequestError(
      error?.message ?? `Priceflag could not complete that request (${response.status}).`,
      response.status,
      error?.code,
      error?.retryable,
    );
  }
  return body as T;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) {
      throw new MerchantRequestError(
        `Priceflag returned an unreadable response (${response.status}).`,
        response.status,
      );
    }
    throw new MerchantRequestError("Priceflag returned an unreadable response.", response.status);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
