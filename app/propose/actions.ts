import "server-only";

import { isDemoMode } from "@/lib/config";
import { buildForecast } from "@/lib/engine/forecast";
import { CONTRACT_VERSION, type ForecastResult, type Guardrails } from "@/lib/contracts";
import { exclusionReasonFor, type OrderDay, type Product } from "@/lib/types";
import type { Rounding } from "@/lib/money";
import { DEMO_NOW, getDemoStore, getProductsByGid } from "@/components/demo/store";

/**
 * Demo-only server actions. A connected store never uses these public action
 * endpoints: the client calls the merchant APIs with a fresh App Bridge session
 * token instead. Keeping the deterministic demo engine server-side avoids
 * shipping its order history to the browser.
 */

export type ForecastRequest = {
  variant_gids: string[];
  change: {
    type: "percent" | "absolute";
    percent?: number;
    absolute_cents?: number;
    rounding?: Rounding;
  };
  horizon_days?: number;
};

export type ForecastReply =
  | { ok: true; forecast: ForecastResult }
  | { ok: false; code: string; message: string };

const DEMO_ONLY: { ok: false; code: string; message: string } = {
  ok: false,
  code: "demo_only",
  message: "This demo action is unavailable for connected stores. Reload Priceflag from Shopify admin.",
};

export async function requestDemoForecast(input: ForecastRequest): Promise<ForecastReply> {
  if (!isDemoMode()) return DEMO_ONLY;
  const store = getDemoStore();
  const products = getProductsByGid(input.variant_gids);
  return forecastFor(products, input, {
    currency: store.shop.currency,
    timezone: store.shop.timezone,
    orderDays: () => Promise.resolve(store.orderDays),
    now: DEMO_NOW,
  });
}

/** The engine call itself — identical in both modes, only the data source differs. */
async function forecastFor(
  products: Product[],
  input: ForecastRequest,
  source: {
    currency: string;
    timezone: string;
    orderDays: () => Promise<OrderDay[]>;
    now: Date;
  },
): Promise<ForecastReply> {
  if (products.length === 0) {
    return {
      ok: false,
      code: "not_found",
      message: "We could not find those products. They may have been removed from your store.",
    };
  }

  if (products.every((product) => exclusionReasonFor(product) !== null)) {
    // 422 in the HTTP contract: well-formed, but impossible.
    return {
      ok: false,
      code: "no_eligible_variants",
      message:
        "Every product you picked is a gift card or a subscription product, which Priceflag never reprices.",
    };
  }

  try {
    const forecast = buildForecast({
      shop: { currency: source.currency, timezone: source.timezone },
      products,
      orderDays: await source.orderDays(),
      change: input.change,
      horizonDays: input.horizon_days,
      now: source.now,
      fits: new Map(),
    });
    return { ok: true, forecast };
  } catch (error) {
    return {
      ok: false,
      code: "forecast_failed",
      message:
        error instanceof Error && error.message
          ? error.message
          : "We could not work out a forecast for that change.",
    };
  }
}

export type CreateRolloutRequest = {
  name: string;
  variant_gids: string[];
  change: ForecastRequest["change"];
  guardrails: Guardrails;
};

export type CreateRolloutReply =
  | { ok: true; rollout_id: string | null; message: string }
  | { ok: false; code: string; message: string };

/**
 * Creating the rollout is `POST /api/rollouts` (B4), which freezes the baseline
 * prices that make rollback correct — that has to happen server-side against a
 * real store, so demo mode says exactly that rather than pretending. Real mode
 * routes through that authenticated API when it lands; this action never writes
 * a rollout via the adapter directly, because the API is where baselines are
 * frozen and journalled.
 */
export async function createDemoRollout(input: CreateRolloutRequest): Promise<CreateRolloutReply> {
  if (input.guardrails.contract_version !== CONTRACT_VERSION) {
    return {
      ok: false,
      code: "bad_request",
      message: "Those safety settings are from an older version of Priceflag. Reload and try again.",
    };
  }
  if (input.guardrails.rules.length === 0) {
    return {
      ok: false,
      code: "bad_request",
      message: "Set at least one limit before starting a price change.",
    };
  }

  if (!isDemoMode()) return DEMO_ONLY;
  const eligible = getProductsByGid(input.variant_gids).filter(
    (product) => exclusionReasonFor(product) === null,
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      code: "no_eligible_variants",
      message: "None of those products can be repriced, so there is nothing to start.",
    };
  }

  return {
    ok: true,
    rollout_id: null,
    message:
      "This is the demo store, so no draft was stored and nothing was sent to Shopify. On a connected store, Priceflag would freeze today's prices in a draft and wait for a separate confirmation before writing anything.",
  };
}
