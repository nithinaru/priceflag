"use client";

import { useEffect } from "react";
import { Button, ButtonLink, EmptyState, PageSection } from "@/components/ui";
import { IconAlert } from "@/components/ui/icons";

/**
 * The error state says the one thing a merchant needs to hear: your prices did
 * not change. A failure to *display* something must never read as a failure
 * that touched the storefront.
 */
export default function ErrorState({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Lane B owns error reporting; until then, the console is the record.
    console.error(error);
  }, [error]);

  return (
    <PageSection>
      <EmptyState
        tone="breach"
        icon={<IconAlert size={19} />}
        title="We couldn't load this page"
        description="Nothing on your storefront changed, and no price change was started or stopped by this. Try again — if it keeps happening, the details are in your browser console."
        action={
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
        }
        secondaryAction={
          <ButtonLink href="/" variant="secondary">
            Go to the overview
          </ButtonLink>
        }
      />
      {error.digest ? (
        <p className="text-center text-xs text-ink-subtle">Reference: {error.digest}</p>
      ) : null}
    </PageSection>
  );
}
