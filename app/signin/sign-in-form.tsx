"use client";

import { useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Notice,
  PageHeader,
} from "@/components/ui";
import { IconArrowRight } from "@/components/ui/icons";

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  sign_in_required: {
    title: "Sign in to continue",
    body: "Connect your Shopify store, or ask for an email link, then open that link in this browser.",
  },
  link_expired: {
    title: "That sign-in link has expired",
    body: "Ask for a new one below, then open it in this same browser.",
  },
  otp_expired: {
    title: "That sign-in link has expired",
    body: "Ask for a new one below, then open it in this same browser.",
  },
  link_invalid: {
    title: "That sign-in link did not work",
    body: "Ask for a new one below. Links can only be used once.",
  },
  link_unbound: {
    title: "Open the link in this browser",
    body: "The link has to be opened in the same browser you used to request it. Ask for a new one here, then use it on this device.",
  },
  link_missing: {
    title: "That sign-in link did not work",
    body: "Ask for a new one below.",
  },
  signed_out: {
    title: "You have been signed out",
    body: "Connect your store or ask for a new email link to come back in.",
  },
};

/** Accepts what merchants actually paste: a bare handle, or a full admin URL. */
function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const withoutScheme = trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const handle = withoutScheme.replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) return null;
  return `${handle}.myshopify.com`;
}

function nextPath(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "" || raw === "/") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

export function SignInForm({ error, next }: { error?: string; next?: string }) {
  const [domain, setDomain] = useState("");
  const [shopError, setShopError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const bounce =
    error === undefined
      ? undefined
      : (ERROR_COPY[error] ?? {
          title: "Could not sign in",
          body: "Ask for a new email link below, or connect with Shopify.",
        });
  const destination = nextPath(next);

  function connectShopify() {
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      setShopError("Enter your store's address, like my-store.myshopify.com.");
      return;
    }
    setShopError(null);
    window.open(`/api/auth?shop=${encodeURIComponent(normalized)}`, "_top");
  }

  async function sendMagicLink() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed.includes("@")) {
      setEmailError("That does not look like an email address.");
      return;
    }
    setEmailError(null);
    setSending(true);
    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: trimmed,
          ...(destination !== undefined ? { next: destination } : {}),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setEmailError(payload?.error?.message ?? "We could not send that link. Try again in a moment.");
        return;
      }
      setSent(true);
    } catch {
      setEmailError("We could not send that link. Try again in a moment.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader
        title="Sign in to Priceflag"
        description="Connect your Shopify store to install and open Priceflag. Or we can email you a sign-in link — no password."
      />

      {bounce !== undefined ? (
        <Notice tone={error === "signed_out" ? "info" : "hold"} title={bounce.title}>
          {bounce.body}
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Connect with Shopify"
          description="This is how merchants sign in and install. You will approve Priceflag on your store, then land back here."
        />
        <CardBody className="space-y-4">
          <Field
            label="Your store's address"
            htmlFor="shop-domain"
            hint="You will find this in your Shopify admin URL. It ends in .myshopify.com."
            error={shopError ?? undefined}
          >
            <Input
              id="shop-domain"
              value={domain}
              placeholder="my-store.myshopify.com"
              autoComplete="off"
              spellCheck={false}
              invalid={shopError !== null}
              onChange={(event) => {
                setDomain(event.target.value);
                if (shopError) setShopError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") connectShopify();
              }}
            />
          </Field>
          <Button type="button" variant="primary" iconRight={<IconArrowRight />} onClick={connectShopify}>
            Connect with Shopify
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Email me a link"
          description="We send a one-time link. Open it in this same browser — a different device will not work."
        />
        <CardBody className="space-y-4">
          {sent ? (
            <Notice tone="info" title="Check your email">
              Open the link in this same browser to finish signing in. If nothing arrives, wait a minute and
              try again.
            </Notice>
          ) : (
            <>
              <Field
                label="Email"
                htmlFor="sign-in-email"
                error={emailError ?? undefined}
              >
                <Input
                  id="sign-in-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  placeholder="you@store.com"
                  invalid={emailError !== null}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void sendMagicLink();
                  }}
                />
              </Field>
              <Button
                type="button"
                variant="secondary"
                loading={sending}
                loadingLabel="Sending"
                onClick={() => void sendMagicLink()}
              >
                Email me a link
              </Button>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
