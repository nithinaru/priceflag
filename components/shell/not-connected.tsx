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
        description="Priceflag needs to know which store to show. If the app is already installed, open it from Apps in Shopify admin. Otherwise connect the store."
      />
      <Card>
        <EmptyState
          icon={<IconFlag size={19} />}
          title="No store connected to this session"
          description="Connecting is how Priceflag knows which catalog to load. It is the next step after signing in, not another password."
          action={
            <ButtonLink href="/connect" variant="primary">
              Connect a store
            </ButtonLink>
          }
        />
      </Card>
      <p className="text-base text-ink-muted">
        Already have an email link working? Connecting is the next step, not another password.
      </p>
    </div>
  );
}
