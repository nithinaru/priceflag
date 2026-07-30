"use server";

/**
 * `PATCH /api/shop` — notification addresses (B5).
 *
 * Kept to the one thing A5 needs: who gets told when a price change starts,
 * advances, breaches, or is undone. The kill switch lives on the overview, not
 * buried in settings, because it is an emergency control (R21).
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

  return { ok: true, emails: cleaned, persisted: false };
}

/** Deliberately permissive: rejecting a merchant's valid address is the worse error. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}
