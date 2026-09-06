/**
 * Webhook subscription registration.
 *
 * The receiver (`app/api/webhooks/[topic]`) has existed since B4, but nothing
 * ever *subscribed* — a custom app cannot use `shopify.app.toml` declarative
 * webhooks, so subscriptions must be created through the GraphQL Admin API,
 * per shop, after install. This module is that missing half.
 *
 * `reconcileWebhooks` is deliberately idempotent and convergent rather than
 * "create once": it reads what Shopify currently has and moves it toward the
 * required set. That shape matters because the callback URL is derived from
 * `APP_URL`, and an app that moves domains (preview → production) must repoint
 * existing subscriptions, not stack new ones next to stale ones.
 *
 * Two things it will never do:
 *
 *   - **Delete subscriptions it does not recognise.** `webhookSubscriptions`
 *     only returns this app's own subscriptions, but an operator may have
 *     registered extras deliberately; leaving them alone is free.
 *   - **Touch GDPR/compliance topics.** `customers/data_request`,
 *     `customers/redact` and `shop/redact` are configured in the Partner
 *     Dashboard, not through this API, and the create mutation would reject
 *     them anyway.
 *
 * Wiring (OAuth callback, sync kickoff) lives with the callers; this module
 * only knows how to converge one shop.
 */

import { createHmac } from 'node:crypto';

import { env } from '../config';
import { AdminGraphqlClient, assertNoUserErrors, type GraphqlUserError } from './client';
import type { ShopCredentials } from './credentials';

/**
 * One required subscription: the API enum, the receiver's URL segment, and the
 * `topic/slash` form the receiver expands the segment back into.
 *
 * The segment convention is load-bearing: the receiver at
 * `app/api/webhooks/[topic]` turns `--` back into `/`, so `orders--create`
 * must round-trip to `orders/create`. Registering any other path would produce
 * webhooks that verify their HMAC and then match no handler.
 */
export interface RequiredWebhookTopic {
  /** GraphQL enum value, e.g. `ORDERS_CREATE`. */
  topic: string;
  /** Slash form as delivered in `X-Shopify-Topic`, e.g. `orders/create`. */
  topicPath: string;
  /** URL segment under `/api/webhooks/`, e.g. `orders--create`. */
  segment: string;
}

export const REQUIRED_WEBHOOK_TOPICS: readonly RequiredWebhookTopic[] = [
  { topic: 'ORDERS_CREATE', topicPath: 'orders/create', segment: 'orders--create' },
  { topic: 'REFUNDS_CREATE', topicPath: 'refunds/create', segment: 'refunds--create' },
  { topic: 'PRODUCTS_UPDATE', topicPath: 'products/update', segment: 'products--update' },
  { topic: 'APP_UNINSTALLED', topicPath: 'app/uninstalled', segment: 'app--uninstalled' },
];

/** A topic/shop-specific capability embedded in its registered callback URL. */
export function webhookTopicToken(secret: string, topicPath: string, shopDomain?: string): string {
  const audience = shopDomain === undefined ? 'partner-config' : shopDomain.trim().toLowerCase();
  return createHmac('sha256', secret)
    .update(`priceflag:webhook-topic:v2:${topicPath}:${audience}`)
    .digest('base64url');
}

/** The exact callback URL a topic's subscription must point at. */
export function webhookCallbackUrl(
  appUrl: string,
  segment: string,
  topicPath: string,
  secret: string,
  shopDomain?: string,
): string {
  const url = new URL(`${appUrl.replace(/\/+$/, '')}/api/webhooks/${segment}`);
  url.searchParams.set('pf_topic_token', webhookTopicToken(secret, topicPath, shopDomain));
  return url.toString();
}

export interface WebhookReconcileResult {
  /** Topics (enum form) that had no subscription and were created. */
  created: string[];
  /** Topics whose subscription existed but pointed at the wrong callback URL. */
  updated: string[];
  /** Topics that were already correct and were left alone. */
  ok: string[];
  /** Duplicate HTTP subscription ids removed to prevent double delivery. */
  deleted: string[];
}

const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query PriceflagWebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes {
        id
        topic
        uri
      }
    }
  }
`;

const WEBHOOK_SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation PriceflagWebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const WEBHOOK_SUBSCRIPTION_UPDATE = /* GraphQL */ `
  mutation PriceflagWebhookSubscriptionUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const WEBHOOK_SUBSCRIPTION_DELETE = /* GraphQL */ `
  mutation PriceflagWebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        field
        message
      }
    }
  }
`;

interface SubscriptionNode {
  id: string;
  topic: string;
  /** HTTPS callback, Pub/Sub URI, or EventBridge ARN. Admin API 2026-07. */
  uri: string;
}

function isHttpWebhookUri(uri: string): boolean {
  return uri.startsWith('https://') || uri.startsWith('http://');
}

/**
 * Converge one shop's webhook subscriptions on the required set.
 *
 * Safe to call on every install and on demand: matching subscriptions are left
 * untouched, so a repeat call against a converged shop is one read and zero
 * writes. Throws (via `assertNoUserErrors` / the client's own error handling)
 * rather than half-reporting — a shop with missing subscriptions silently loses
 * order data, which is the failure mode auto-rollback cannot see.
 */
export async function reconcileWebhooks(
  credentials: ShopCredentials,
  appUrl: string,
  options: { client?: AdminGraphqlClient; webhookSecret?: string } = {},
): Promise<WebhookReconcileResult> {
  const client = options.client ?? new AdminGraphqlClient(credentials);
  const webhookSecret = options.webhookSecret ?? env('SHOPIFY_API_SECRET');
  if (webhookSecret === undefined) {
    throw new Error('SHOPIFY_API_SECRET is required to register topic-bound webhook callbacks');
  }

  const data = await client.request<{
    webhookSubscriptions: { nodes: SubscriptionNode[] };
  }>(WEBHOOK_SUBSCRIPTIONS_QUERY, { first: 50 });

  const existing = data.webhookSubscriptions.nodes;
  const result: WebhookReconcileResult = { created: [], updated: [], ok: [], deleted: [] };

  async function deleteDuplicates(nodes: readonly SubscriptionNode[], keepId: string): Promise<void> {
    for (const duplicate of nodes) {
      if (duplicate.id === keepId || !isHttpWebhookUri(duplicate.uri)) continue;
      const deleted = await client.request<{
        webhookSubscriptionDelete: {
          deletedWebhookSubscriptionId: string | null;
          userErrors: GraphqlUserError[];
        } | null;
      }>(WEBHOOK_SUBSCRIPTION_DELETE, { id: duplicate.id });
      assertNoUserErrors(
        deleted.webhookSubscriptionDelete?.userErrors,
        `webhookSubscriptionDelete(${duplicate.id})`,
      );
      result.deleted.push(duplicate.id);
    }
  }

  for (const required of REQUIRED_WEBHOOK_TOPICS) {
    const expectedUrl = webhookCallbackUrl(
      appUrl,
      required.segment,
      required.topicPath,
      webhookSecret,
      credentials.shopDomain,
    );
    const forTopic = existing.filter((node) => node.topic === required.topic);

    // Already pointing at the right place? Done — zero writes.
    const matching = forTopic.find((node) => isHttpWebhookUri(node.uri) && node.uri === expectedUrl);
    if (matching !== undefined) {
      result.ok.push(required.topic);
      await deleteDuplicates(forTopic, matching.id);
      continue;
    }

    // An HTTP subscription for this topic exists but points elsewhere (an old
    // domain, usually). Repoint it rather than stacking a second subscription —
    // Shopify would happily deliver every event twice.
    const repointable = forTopic.find((node) => isHttpWebhookUri(node.uri));
    if (repointable !== undefined) {
      const updated = await client.request<{
        webhookSubscriptionUpdate: {
          webhookSubscription: { id: string } | null;
          userErrors: GraphqlUserError[];
        } | null;
      }>(WEBHOOK_SUBSCRIPTION_UPDATE, {
        id: repointable.id,
        webhookSubscription: { uri: expectedUrl },
      });
      assertNoUserErrors(updated.webhookSubscriptionUpdate?.userErrors, `webhookSubscriptionUpdate(${required.topic})`);
      result.updated.push(required.topic);
      await deleteDuplicates(forTopic, repointable.id);
      continue;
    }

    // Nothing for this topic (or only non-HTTP endpoints someone else set up,
    // which are left alone): create ours.
    const created = await client.request<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string } | null;
        userErrors: GraphqlUserError[];
      } | null;
    }>(WEBHOOK_SUBSCRIPTION_CREATE, {
      topic: required.topic,
      webhookSubscription: { uri: expectedUrl, format: 'JSON' },
    });
    assertNoUserErrors(created.webhookSubscriptionCreate?.userErrors, `webhookSubscriptionCreate(${required.topic})`);
    result.created.push(required.topic);
  }

  return result;
}
