/**
 * Handing a catalog selection to the preview screen.
 *
 * The URL is the obvious place for this, and it is where this should end up —
 * but a merchant can legitimately select 400 SKUs, and 400 ids in a query string
 * is a 6 kB URL. So A2 parks the selection in `sessionStorage` and the preview
 * screen reads it on mount.
 *
 * Two consequences, both handled rather than hidden:
 * - a bookmarked or shared `/propose` URL has no selection, so that screen has a
 *   designed empty state that sends the merchant back to the catalog;
 * - the preview screen is client-rendered.
 *
 * Lane A has asked Lane B for a server-side proposal draft so the selection can
 * live in the database and the URL can carry one short id
 * (contracts/requests-lane-a.md, REQ-A-004). This module is the seam for that.
 */

const KEY = "priceflag:selection:v1";

export function writeSelection(variantGids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(variantGids));
  } catch {
    // Private-browsing quota errors: the preview screen's empty state covers it.
  }
}

export function readSelection(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export function clearSelection(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to do — an unclearable selection is not worth an error state.
  }
}
