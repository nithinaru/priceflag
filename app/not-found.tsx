import { ButtonLink, Card, EmptyState } from "@/components/ui";
import { IconSearch } from "@/components/ui/icons";

export default function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={<IconSearch size={19} />}
        title="We couldn't find that"
        description="The page or price change you asked for doesn't exist, or it was removed. Nothing on your storefront changed."
        action={
          <ButtonLink href="/" variant="primary">
            Go to the overview
          </ButtonLink>
        }
        secondaryAction={
          <ButtonLink href="/rollouts" variant="secondary">
            See all price changes
          </ButtonLink>
        }
      />
    </Card>
  );
}
