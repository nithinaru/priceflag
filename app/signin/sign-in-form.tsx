"use client";

import { useState } from "react";
import {
  Button,
  Field,
  Input,
  Notice,
  PageHeader,
  PageSection,
} from "@/components/ui";
import { IconArrowRight, IconIbis } from "@/components/ui/icons";
import { normalizeStoreAddress } from "@/lib/shopify/store-address";

/**
 * One field, one button.
 *
 * Everything else that used to be on this screen — the emailed link, the
 * "already connected?" disclosure, the six link-failure states — existed to
 * paper over a sign-up that had two halves. It has one now: entering a store
 * address starts a Shopify install, and finishing that install is the account.
 * There is nothing to remember and nothing to check an inbox for.
 */

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  sign_in_required: {
    title: "Connect your store to continue",
    body: "Enter your store address below. Shopify will ask you to approve Priceflag once.",
  },
  signed_out: {
    title: "You are signed out",
    body: "Enter your store address to come back in. Shopify will not ask you to approve anything twice.",
  },
  state_mismatch: {
    title: "That install link expired",
    body: "Installs have to finish within ten minutes. Start again below.",
  },
  invalid_hmac: {
    title: "That install link could not be verified",
    body: "Start the install again from here rather than from an old link.",
  },
  scope_mismatch: {
    title: "Shopify withheld a permission Priceflag needs",
    body: "Approve every permission on the Shopify screen, then try again. Priceflag cannot forecast on partial order history.",
  },
  session_not_configured: {
    title: "Your store is connected, but Priceflag could not sign you in",
    body: "The deployment is missing AUTH_SESSION_SECRET. Set it and open Priceflag again — you will not need to reinstall.",
  },
  shopify_not_configured: {
    title: "This deployment has no Shopify credentials",
    body: "Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET, or run in demo mode.",
  },
};

export function SignInForm({
  appUrl,
  demoMode = false,
  error,
  shop,
}: {
  appUrl: string;
  demoMode?: boolean;
  error?: string;
  shop?: string;
}) {
  const [domain, setDomain] = useState(shop ?? "");
  const [shopError, setShopError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const bounce =
    error === undefined
      ? undefined
      : (ERROR_COPY[error] ?? {
          title: "Could not connect that store",
          body: "Enter your store address and try again.",
        });

  function connectShopify() {
    const normalized = normalizeStoreAddress(domain);
    if (normalized === null) {
      setShopError("Enter your store's address, like my-store.myshopify.com.");
      return;
    }
    setShopError(null);
    setStarting(true);
    // `_top`, not the current frame: Shopify's authorize screen refuses to be
    // framed, so an install started inside an iframe would render nothing.
    window.open(`${appUrl}/api/auth?shop=${encodeURIComponent(normalized)}`, "_top");
  }

  async function openDemo() {
    setStarting(true);
    try {
      const response = await fetch(`${appUrl}/api/auth/demo`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        setShopError("The demo store is not available on this deployment.");
        setStarting(false);
        return;
      }
      window.location.assign(`${appUrl}/`);
    } catch {
      setShopError("The demo store is not available right now.");
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5 text-ink">
        <IconIbis size={22} />
        <span className="font-display text-md tracking-[-0.01em]">Priceflag</span>
      </div>

      <PageHeader
        title="Connect your store"
        description="One approval on Shopify. No password, no email to check."
      />

      {bounce !== undefined ? (
        <Notice tone={error === "signed_out" ? "info" : "hold"} title={bounce.title}>
          {bounce.body}
        </Notice>
      ) : null}

      <PageSection>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connectShopify();
          }}
          className="space-y-4"
        >
          <Field
            label="Store address"
            htmlFor="shop-domain"
            hint="From your Shopify admin URL — my-store, or my-store.myshopify.com."
            error={shopError ?? undefined}
          >
            <Input
              id="shop-domain"
              name="shop"
              value={domain}
              placeholder="my-store.myshopify.com"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
              invalid={shopError !== null}
              onChange={(event) => {
                setDomain(event.target.value);
                if (shopError) setShopError(null);
              }}
            />
          </Field>
          <Button
            type="submit"
            variant="neon"
            size="lg"
            fullWidth
            loading={starting}
            loadingLabel="Opening Shopify"
            iconRight={<IconArrowRight />}
          >
            Continue with Shopify
          </Button>
        </form>

        {/* Said before the approval screen, not on it. A merchant deciding
            whether to grant write access to their prices deserves to read what
            it is for somewhere that is not a permissions dialog. */}
        <p className="max-w-prose pt-4 text-base text-ink-muted">
          Shopify will ask you to approve Priceflag reading your products and
          order history, and writing prices. Priceflag stages every price change
          by SKU and time — never per visitor — and keeps a journal that can put
          any price back the way it was.
        </p>
      </PageSection>

      {demoMode ? (
        <PageSection>
          <p className="max-w-prose pb-4 text-base text-ink-muted">
            This deployment runs against a simulated store, so there is nothing
            to install.
          </p>
          <Button variant="secondary" loading={starting} onClick={() => void openDemo()}>
            Open the demo store
          </Button>
        </PageSection>
      ) : null}
    </div>
  );
}
