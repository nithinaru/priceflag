import { ButtonLink, Card, EmptyState, PageHeader, TextLink } from "@/components/ui";
import { IconFlag } from "@/components/ui/icons";

/**
 * Real mode, but no authenticated shop: the request carried no Shopify session
 * token, no signed launch params, and no `pf_shop` cookie, so we do not know
 * whose store this is. The honest render is to say so — never a guess, and
 * never another merchant's data.
 *
 * Every merchant page returns this in that state, so it stays one component:
 * the fix (open the app from the Shopify admin, or connect a store) is the
 * same whichever page they landed on.
 */
export function NotConnected() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Open this from your Shopify admin"
        description="Priceflag works on one store at a time, and this page does not know which store is yours yet."
      />
      <Card>
        <EmptyState
          icon={<IconFlag size={19} />}
          title="No store connected to this session"
          description="If Priceflag is already installed, open it from Apps in your Shopify admin and this page will show your own products and price changes. If not, connecting a store takes a couple of minutes."
          action={
            <ButtonLink href="/connect" variant="primary">
              Connect a store
            </ButtonLink>
          }
        />
      </Card>
      <p className="text-base text-ink-muted">
        Just looking around? The <TextLink href="/connect">connect page</TextLink> explains what
        Priceflag needs and what it will never do.
      </p>
    </div>
  );
}
