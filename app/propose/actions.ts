"use server";

import { getAdapter } from "@/lib/adapters";
import { buildForecast } from "@/lib/engine/forecast";
import { CONTRACT_VERSION, type ForecastResult, type Guardrails } from "@/lib/contracts";
import { exclusionReasonFor } from "@/lib/types";
import type { Rounding } from "@/lib/money";
import { DEMO_NOW, getDemoStore, getProductsByGid } from "@/components/demo/store";

/**
 * The forecast and create calls, as server actions.
 *
 * These stand in for `POST /api/forecast` and `POST /api/rollouts`
 * (contracts/api.md), which land in B3 and B4. The request and reply shapes here
 * are the contract's, so swapping in a `fetch` later is a body change and
 * nothing else. Running the engine on the server also keeps 180 days × 14
 * variants of order history out of the browser bundle.
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

export async function requestForecast(input: ForecastRequest): Promise<ForecastReply> {
  const store = getDemoStore();
  const products = getProductsByGid(input.variant_gids);

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
    // Lane C's fits, via the adapter (B6). Without these every forecast is
    // `assumption` with no range, which is what REQ-A-006 was about — the
    // forecast card's fitted band was unreachable because this call never asked
    // for them. A store with no fits still works: absent entries fall back to
    // bracket math, per the contract's fallback chain.
    const fits = await getAdapter().getLatestFits(
      store.shop.id,
      products.map((product) => product.variant_gid),
    );

    const forecast = buildForecast({
      shop: { currency: store.shop.currency, timezone: store.shop.timezone },
      products,
      orderDays: store.orderDays,
      change: input.change,
      horizonDays: input.horizon_days,
      now: DEMO_NOW,
      fits,
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
 * real store, so demo mode says exactly that rather than pretending.
 */
export async function createRollout(input: CreateRolloutRequest): Promise<CreateRolloutReply> {
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
      "This is the demo store, so no prices were changed and nothing was sent to Shopify. On a connected store this would create the change as a draft, freeze today's prices as the ones to roll back to, and wait for you to start it.",
  };
}
