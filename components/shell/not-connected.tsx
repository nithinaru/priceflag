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
      <PageHeader title="Connect your store" />
      <Card>
        <EmptyState
          icon={<IconFlag size={19} />}
          title="No store connected"
          action={
            <ButtonLink href="/connect" variant="neon">
              Connect a store
            </ButtonLink>
          }
        />
      </Card>
    </div>
  );
}
