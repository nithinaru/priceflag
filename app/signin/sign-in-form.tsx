"use client";

import { useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Notice,
  PageHeader,
} from "@/components/ui";
import { IconArrowRight, IconChevronRight } from "@/components/ui/icons";

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  sign_in_required: {
    title: "Connect your store to continue",
    body: "Enter the store address below. If you already connected it, you can email yourself a link instead — open that link in this browser.",
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
    body: "Connect the store again, or email yourself a link if you already have.",
  },
};

const EMAIL_ERRORS = new Set([
  "link_expired",
  "otp_expired",
  "link_invalid",
  "link_unbound",
  "link_missing",
]);

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
          body: "Connect with Shopify, or ask for a new email link if you already have.",
        });
  const destination = nextPath(next);
  const emailOpen = sent || (error !== undefined && EMAIL_ERRORS.has(error));

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
    <div className="space-y-6">
      <div className="flex items-center gap-2.5 text-ink">
        <img src="/ibis.png" alt="" width={22} height={22} />
        <span
          className="text-md tracking-[-0.01em]"
          style={{ fontFamily: "var(--font-display), Georgia, serif" }}
        >
          Priceflag
        </span>
      </div>

      <PageHeader
        title="Connect your Shopify store"
        description="Approve the app once. After that, open it from Apps in Shopify admin. Email is a same-browser return path — it cannot change a price."
      />

      {bounce !== undefined ? (
        <Notice tone={error === "signed_out" ? "info" : "hold"} title={bounce.title}>
          {bounce.body}
        </Notice>
      ) : null}

      <Card>
        <CardBody className="space-y-4 pt-5">
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
              hint="From your Shopify admin URL. It ends in .myshopify.com."
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
                invalid={shopError !== null}
                onChange={(event) => {
                  setDomain(event.target.value);
                  if (shopError) setShopError(null);
                }}
              />
            </Field>
            <Button type="submit" variant="neon" size="lg" fullWidth iconRight={<IconArrowRight />}>
              Continue with Shopify
            </Button>
          </form>
        </CardBody>
      </Card>

      <details className="group rounded-lg border border-border bg-surface shadow-sm" open={emailOpen || undefined}>
        <summary className="cursor-pointer list-none px-4 py-3.5 text-base font-medium text-ink marker:hidden sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center justify-between gap-3">
            Already connected? Open from email
            <IconChevronRight
              size={16}
              className="shrink-0 text-ink-subtle transition-transform duration-150 group-open:rotate-90"
            />
          </span>
        </summary>
        <div className="space-y-4 border-t border-border px-4 py-4 sm:px-5">
          <p className="max-w-prose text-base text-ink-muted">
            We send a one-time link. Open it in this same browser — a different device will not
            work. If this email has not connected a store yet, the next screen is Connect.
          </p>
          {sent ? (
            <Notice tone="info" title="Check your email">
              Open the link in this same browser to finish. If nothing arrives, wait a minute and
              try again.
            </Notice>
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void sendMagicLink();
              }}
              className="space-y-4"
            >
              <Field label="Email" htmlFor="sign-in-email" error={emailError ?? undefined}>
                <Input
                  id="sign-in-email"
                  name="email"
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
                />
              </Field>
              <Button type="submit" variant="secondary" loading={sending} loadingLabel="Sending">
                Email me a link
              </Button>
            </form>
          )}
        </div>
      </details>
    </div>
  );
}
