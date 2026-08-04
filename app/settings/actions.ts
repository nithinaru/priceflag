"use server";

import { getAdapter } from "@/lib/adapters";
import { isDemoMode } from "@/lib/config";
import { resolveShopForSession } from "@/app/lib/shop-context";

/**
 * `PATCH /api/shop` — notification addresses (B5).
 *
 * Kept to the one thing A5 needs: who gets told when a price change starts,
 * advances, breaches, or is undone. The kill switch lives on the overview, not
 * buried in settings, because it is an emergency control (R21).
 *
 * In real mode the addresses land on `shops.notify_emails` via the adapter,
 * scoped to the cookie-resolved shop — never to anything the client names.
 */

export type SaveNotificationsReply =
  | { ok: true; emails: string[]; persisted: boolean }
  | { ok: false; message: string };

export async function saveNotificationEmails(
  emails: string[],
): Promise<SaveNotificationsReply> {
  const cleaned = emails.map((email) => email.trim()).filter((email) => email !== "");

  const invalid = cleaned.find((email) => !isEmail(email));
  if (invalid) {
    return { ok: false, message: `"${invalid}" does not look like an email address.` };
  }
  if (cleaned.length > 5) {
    return { ok: false, message: "Five addresses is the most we will email about one store." };
  }

  if (isDemoMode()) {
    return { ok: true, emails: cleaned, persisted: false };
  }

  const ctx = await resolveShopForSession();
  const shop = ctx.mode === "real" ? ctx.shop : null;
  if (shop === null) {
    return {
      ok: false,
      message:
        "We could not tell which store this is. Open Priceflag from your Shopify admin and try again.",
    };
  }

  try {
    const updated = await getAdapter().updateShop(shop.id, { notify_emails: cleaned });
    return { ok: true, emails: updated.notify_emails, persisted: true };
  } catch {
    return { ok: false, message: "Those addresses did not save. Nothing was changed — try again." };
  }
}

/** Deliberately permissive: rejecting a merchant's valid address is the worse error. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}
