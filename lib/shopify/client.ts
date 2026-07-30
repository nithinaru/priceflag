/**
 * Admin GraphQL client.
 *
 * Shopify throttles on **query cost**, not request count: every response carries
 * a leaky-bucket balance, and a naive client discovers the limit by being
 * rejected. That matters here more than in most apps — a sync that gets throttled
 * halfway through leaves a half-built catalog, and a *price write* that gets
 * throttled halfway through leaves a rollout partially applied. So this client:
 *
 *   - reads `extensions.cost.throttleStatus` and waits *before* it would overdraw
 *   - retries `THROTTLED`, 429 and 5xx with exponential backoff plus jitter,
 *     honouring `Retry-After` when Shopify sends one
 *   - never retries a 4xx that is not a throttle, because replaying a rejected
 *     mutation is how you write a price twice
 *
 * Server-only.
 */

import { adminGraphqlUrl } from './oauth';
import type { ShopCredentials } from './credentials';

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ThrottleStatus;
}

export interface GraphqlUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export class ShopifyApiError extends Error {
  constructor(
    readonly code: 'throttled' | 'graphql_errors' | 'http_error' | 'network' | 'user_errors',
    message: string,
    readonly details?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

export interface AdminClientOptions {
  fetchImpl?: typeof fetch;
  /** Injected in tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** Wait when the remaining bucket would drop below this multiple of the last cost. */
  headroomMultiplier?: number;
  onCost?: (cost: QueryCost) => void;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_HEADROOM = 2;

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AdminGraphqlClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly headroom: number;
  private readonly onCost: ((cost: QueryCost) => void) | undefined;

  /** Last observed throttle state, for progress reporting and tests. */
  lastCost: QueryCost | null = null;
  requestCount = 0;

  constructor(credentials: ShopCredentials, options: AdminClientOptions = {}) {
    this.endpoint = adminGraphqlUrl(credentials.shopDomain, credentials.apiVersion);
    this.token = credentials.accessToken;
    this.doFetch = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? sleepReal;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.headroom = options.headroomMultiplier ?? DEFAULT_HEADROOM;
    this.onCost = options.onCost;
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    await this.waitForHeadroom();

    let lastError: ShopifyApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(backoffMs(attempt, lastError));

      let response: Response;
      try {
        this.requestCount += 1;
        response = await this.doFetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': this.token,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (cause) {
        // Transport failure: worth retrying, but only so many times.
        lastError = new ShopifyApiError('network', cause instanceof Error ? cause.message : String(cause));
        continue;
      }

      if (response.status === 429) {
        lastError = new ShopifyApiError('throttled', 'Shopify throttled the request', retryAfterMs(response), 429);
        continue;
      }
      if (response.status >= 500) {
        lastError = new ShopifyApiError('http_error', `Shopify returned HTTP ${response.status}`, undefined, response.status);
        continue;
      }
      if (!response.ok) {
        // 4xx that is not a throttle: the request itself is wrong (bad token,
        // removed scope, malformed query). Retrying cannot fix it, and replaying
        // a mutation that may have partially applied is worse than failing.
        throw new ShopifyApiError(
          'http_error',
          `Shopify rejected the request with HTTP ${response.status}. ` +
            (response.status === 401 || response.status === 403
              ? 'The Admin API token is invalid or is missing a required scope.'
              : ''),
          undefined,
          response.status,
        );
      }

      const payload = (await response.json()) as {
        data?: T;
        errors?: { message: string; extensions?: { code?: string } }[];
        extensions?: { cost?: QueryCost };
      };

      if (payload.extensions?.cost) {
        this.lastCost = payload.extensions.cost;
        this.onCost?.(payload.extensions.cost);
      }

      if (payload.errors && payload.errors.length > 0) {
        const throttled = payload.errors.some((error) => error.extensions?.code === 'THROTTLED');
        if (throttled) {
          lastError = new ShopifyApiError('throttled', 'Shopify throttled the query', payload.errors);
          // A GraphQL-level throttle means the bucket is empty; wait for it to
          // refill rather than immediately burning another attempt.
          await this.waitForRestore();
          continue;
        }
        throw new ShopifyApiError(
          'graphql_errors',
          payload.errors.map((error) => error.message).join('; '),
          payload.errors,
        );
      }

      if (payload.data === undefined) {
        throw new ShopifyApiError('graphql_errors', 'Shopify returned no data and no errors');
      }
      return payload.data;
    }

    throw lastError ?? new ShopifyApiError('network', 'request failed with no further detail');
  }

  /** Sleep if the next query would likely overdraw the leaky bucket. */
  private async waitForHeadroom(): Promise<void> {
    const cost = this.lastCost;
    if (cost === null) return;

    const needed = (cost.actualQueryCost ?? cost.requestedQueryCost) * this.headroom;
    const { currentlyAvailable, restoreRate } = cost.throttleStatus;
    if (currentlyAvailable >= needed || restoreRate <= 0) return;

    const deficit = needed - currentlyAvailable;
    await this.sleep(Math.ceil((deficit / restoreRate) * 1000));
  }

  /** Wait for the bucket to refill to roughly half after a hard throttle. */
  private async waitForRestore(): Promise<void> {
    const status = this.lastCost?.throttleStatus;
    if (!status || status.restoreRate <= 0) {
      await this.sleep(1000);
      return;
    }
    const target = status.maximumAvailable / 2;
    const deficit = Math.max(0, target - status.currentlyAvailable);
    await this.sleep(Math.ceil((deficit / status.restoreRate) * 1000) || 1000);
  }
}

/** Exponential backoff with jitter; honours a `Retry-After` when we were given one. */
function backoffMs(attempt: number, lastError: ShopifyApiError | null): number {
  if (lastError?.code === 'throttled' && typeof lastError.details === 'number') {
    return lastError.details;
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 16_000);
  // Jitter matters when a sync and the evaluator retry at the same moment:
  // without it they resynchronise and keep colliding.
  return base + Math.floor(Math.random() * 250);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

/**
 * Shopify mutations report business-rule failures in `userErrors` with HTTP 200.
 * Treating that as success is the single easiest way to believe a price was
 * written when it was not.
 */
export function assertNoUserErrors(userErrors: readonly GraphqlUserError[] | undefined, context: string): void {
  if (!userErrors || userErrors.length === 0) return;
  throw new ShopifyApiError(
    'user_errors',
    `${context}: ${userErrors.map((error) => `${(error.field ?? []).join('.')} ${error.message}`.trim()).join('; ')}`,
    userErrors,
  );
}
