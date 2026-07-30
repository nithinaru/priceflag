"use server";

import { getProduct } from "@/components/demo/store";

/**
 * Setting a unit cost — `PATCH /api/products/[variantId]/cogs` (B3).
 *
 * Cost is the one number the merchant is expected to supply, and it gates every
 * profit figure in the app (R3), so it has to be editable from wherever they
 * noticed it was missing. Shape mirrors the contract so this becomes a `fetch`.
 *
 * A cost **above** the price is allowed: loss leaders are real. The UI warns and
 * saves rather than refusing.
 */

export type SaveCostReply =
  | { ok: true; cogs_cents: number | null; persisted: boolean }
  | { ok: false; message: string };

export async function saveCost(
  variantGid: string,
  cogsCents: number | null,
): Promise<SaveCostReply> {
  const product = getProduct(variantGid);
  if (!product) {
    return { ok: false, message: "We could not find that product. It may have been removed." };
  }
  if (cogsCents !== null && (!Number.isFinite(cogsCents) || cogsCents < 0)) {
    return { ok: false, message: "A cost cannot be negative." };
  }
  if (cogsCents !== null && !Number.isInteger(cogsCents)) {
    return { ok: false, message: "That cost is not a whole number of cents." };
  }

  // Demo mode has no writable store: the golden store is regenerated
  // deterministically on every request, so a write here would vanish and a
  // "saved" message would be a lie. Say what actually happened instead.
  return { ok: true, cogs_cents: cogsCents, persisted: false };
}
