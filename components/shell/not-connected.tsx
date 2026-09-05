import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { IconFlag } from "@/components/ui/icons";

/**
 * Real mode, but no authenticated shop: the request carried no Shopify session
 * token, no signed launch params, and no `pf_shop` cookie, so we do not know
 * whose store this is. The honest render is to say so — never a guess, and
 * never another merchant's data.
 *
 * Magic-link users land here after email sign-in: the account is signed in,
 * the store is not yet connected. Every merchant page returns this in that
 * state, so it stays one component.
 */
export function NotConnected() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Connect your Shopify store"
        description="Open the app from Apps in Shopify admin, or connect below. Email only shows a store that address has already connected."
      />
      <Card>
        <EmptyState
          icon={<IconFlag size={19} />}
          title="No store connected to this session"
          description="Shopify is the proof. Connecting loads that catalog."
          action={
            <ButtonLink href="/connect" variant="neon">
              Connect a store
            </ButtonLink>
          }
        />
      </Card>
      <p className="text-base text-ink-muted">
        Email gets you into this dashboard. Shopify is what lets Priceflag change a price.
      </p>
    </div>
  );
}
