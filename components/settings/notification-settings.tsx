"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardFooter, CardHeader, Input, Notice } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { IconClose } from "@/components/ui/icons";
import { merchantJson } from "@/components/lib/merchant-api";

/**
 * Who gets told, and about what.
 *
 * The list of events is not configurable, deliberately: every one of them is a
 * thing that changed a price or is about to. Safety-limit alerts are always
 * included so a merchant knows when Priceflag has paused for their decision.
 */
export function NotificationSettings({
  initialEmails,
  emailConfigured,
  demoMode = true,
}: {
  initialEmails: string[];
  /** Whether this deployment can actually send mail. */
  emailConfigured: boolean;
  /** Defaults to the safe claim: never say "saved to your shop" unless told otherwise. */
  demoMode?: boolean;
}) {
  const [emails, setEmails] = useState<string[]>(
    initialEmails.length > 0 ? initialEmails : [""],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save() {
    setSaving(true);
    setError(null);
    const cleaned = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    const invalid = cleaned.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email));
    if (invalid) {
      setSaving(false);
      setError(`“${invalid}” does not look like an email address.`);
      return;
    }

    let reply: { ok: true; emails: string[]; persisted: boolean } | { ok: false; message: string };
    if (demoMode) {
      reply = { ok: true, emails: cleaned, persisted: false };
    } else {
      try {
        const body = await merchantJson<{ shop: { notify_emails: string[] } }>("/api/shop", {
          method: "PATCH",
          body: JSON.stringify({ notify_emails: cleaned }),
        });
        reply = { ok: true, emails: body.shop.notify_emails, persisted: true };
      } catch (cause) {
        reply = {
          ok: false,
          message: cause instanceof Error ? cause.message : "Those addresses did not save. Try again.",
        };
      }
    }
    setSaving(false);

    if (!reply.ok) {
      setError(reply.message);
      return;
    }

    setEmails(reply.emails.length > 0 ? reply.emails : [""]);
    toast({
      tone: "success",
      title: reply.persisted ? "Saved" : "Saved on this screen",
      description: reply.persisted
        ? reply.emails.length === 0
          ? "Nobody will be emailed about price changes on this store."
          : `We will email ${reply.emails.length === 1 ? "this address" : "these addresses"} when a change starts, advances, pauses, or is manually rolled back.`
        : demoMode
          ? "This is the demo store, so nothing was stored. On a connected store these addresses would be saved against your shop."
          : "These addresses were not saved to your shop. They will show here until you leave the page — try saving again.",
    });
  }

  return (
    <Card>
      <CardHeader
        title="Who we email"
        description="We email when a price change starts, moves to more products, crosses a safety limit, pauses, or is manually rolled back."
      />
      <CardBody className="space-y-4">
        {!emailConfigured ? (
          <Notice tone="hold" title="This copy of Priceflag cannot send email yet">
            No email service is configured, so nothing will be sent whatever you put here. Every
            event is still recorded in your price journal and on the rollout page.
          </Notice>
        ) : null}

        <div className="space-y-2">
          {emails.map((email, index) => (
            <div key={index} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={`notify-${index}`} className="sr-only">
                  Email address {index + 1}
                </label>
                <Input
                  id={`notify-${index}`}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@yourstore.com"
                  value={email}
                  invalid={error !== null}
                  onChange={(event) => {
                    const next = [...emails];
                    next[index] = event.target.value;
                    setEmails(next);
                    if (error) setError(null);
                  }}
                />
              </div>
              {emails.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove ${email || `address ${index + 1}`}`}
                  onClick={() => setEmails(emails.filter((_, i) => i !== index))}
                  className="rounded-md p-2 text-ink-subtle outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <IconClose size={15} />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        {error ? <p className="text-sm text-breach">{error}</p> : null}

        {emails.length < 5 ? (
          <Button variant="ghost" size="sm" onClick={() => setEmails([...emails, ""])}>
            Add another address
          </Button>
        ) : null}
      </CardBody>
      <CardFooter>
        <span>Anyone here can see prices and results, but cannot change anything.</span>
        <Button variant="primary" size="sm" loading={saving} loadingLabel="Saving" onClick={() => void save()}>
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}
