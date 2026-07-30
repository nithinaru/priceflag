"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardFooter, CardHeader, Field, Input, Notice } from "@/components/ui";
import { IconArrowRight, IconCheck } from "@/components/ui/icons";
import { SyncProgressPanel } from "@/components/onboarding/sync-progress";
import { startDemoSync, type StartSyncReply } from "@/app/connect/actions";
import type { SyncProgress } from "@/lib/contracts";

/**
 * Connecting a store.
 *
 * Two honest paths, decided by what is actually configured on the server rather
 * than by a flag in the UI:
 *
 * - **Shopify credentials present** → the install link is real; it hands off to
 *   `GET /api/auth`, which is Lane B's OAuth start.
 * - **Not present** → the button says so and does not pretend. A dead install
 *   button that silently 404s is worse than one that explains itself.
 *
 * The demo path runs a scripted sync so the whole first-run sequence can be
 * walked end to end without credentials, and it is labelled as scripted
 * throughout — a demo that implies it touched Shopify is a lie the merchant
 * finds out about later.
 */
export function ConnectPanel({
  shopifyConfigured,
  installBase,
}: {
  shopifyConfigured: boolean;
  installBase: string;
}) {
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);

  const normalized = normalizeDomain(domain);

  async function connect() {
    if (!normalized) {
      setError("Enter your store's address, like my-store.myshopify.com.");
      return;
    }
    setError(null);

    if (shopifyConfigured) {
      // Real install: hand off to Lane B's OAuth start.
      window.location.href = `${installBase}?shop=${encodeURIComponent(normalized)}`;
      return;
    }

    setRunning(true);
    const reply: StartSyncReply = await startDemoSync(normalized);
    setRunning(false);
    if (!reply.ok) {
      setError(reply.message);
      return;
    }
    setProgress(reply.progress);
  }

  if (progress) {
    return (
      <Card tone="accent" edge>
        <CardHeader
          eyebrow="Scripted, not connected"
          title={`Loading ${normalized}`}
          description="This is what the real thing looks like. No Shopify store was contacted, and no credentials were used."
        />
        <CardBody>
          <SyncProgressPanel initial={progress} poll={false} />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Connect your Shopify store"
        description="Priceflag reads your products, their costs, and your order history. It changes a price only when you tell it to."
      />
      <CardBody className="space-y-5">
        <Field
          label="Your store's address"
          htmlFor="shop-domain"
          hint="You will find this in your Shopify admin URL. It ends in .myshopify.com."
          error={error ?? undefined}
        >
          <Input
            id="shop-domain"
            value={domain}
            placeholder="my-store.myshopify.com"
            autoComplete="off"
            spellCheck={false}
            invalid={error !== null}
            onChange={(event) => {
              setDomain(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void connect();
            }}
          />
        </Field>

        <div className="rounded-lg border border-border bg-surface-muted px-4 py-3.5">
          <h3 className="text-base font-semibold text-ink">What Priceflag will do</h3>
          <ul className="mt-2 space-y-1.5">
            {[
              "Read your products, their prices, and the unit costs you have saved in Shopify.",
              "Read your order history, as daily totals only. We never store anything about a customer.",
              "Change a price only as part of a change you set up and started yourself.",
              "Record every price change, including ones you make in Shopify without us.",
            ].map((line) => (
              <li key={line} className="flex gap-2 text-base text-ink-muted">
                <span className="mt-0.5 shrink-0 text-live" aria-hidden="true">
                  <IconCheck size={14} />
                </span>
                <span className="max-w-prose">{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-prose text-base text-ink">
            <span className="font-medium">What it never does:</span> show different prices to
            different shoppers. Everyone who visits your store sees the same price, always.
          </p>
        </div>

        {!shopifyConfigured ? (
          <Notice tone="hold" title="This copy of Priceflag has no Shopify credentials yet">
            You can still walk through the whole first-run sequence — the next button plays a
            scripted version of it against the demo store. To connect a real store, add your
            Shopify app credentials and reload.
          </Notice>
        ) : null}
      </CardBody>
      <CardFooter>
        <span>
          {shopifyConfigured
            ? "Shopify will ask you to approve the permissions above."
            : "Nothing here contacts Shopify."}
        </span>
        <Button
          variant="primary"
          loading={running}
          loadingLabel="Loading your store"
          onClick={() => void connect()}
          iconRight={<IconArrowRight size={15} />}
        >
          {shopifyConfigured ? "Install on my store" : "Show me how this works"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Accepts what merchants actually paste: a bare handle, or a full admin URL. */
function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const withoutScheme = trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const handle = withoutScheme.replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
  return `${handle}.myshopify.com`;
}
