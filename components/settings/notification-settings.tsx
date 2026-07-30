"use client";

import { useState } from "react";
import { Button, Card, CardBody, CardFooter, CardHeader, Input, Notice } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { IconClose } from "@/components/ui/icons";
import { saveNotificationEmails } from "@/app/settings/actions";

/**
 * Who gets told, and about what.
 *
 * The list of events is not configurable, deliberately: every one of them is a
 * thing that changed a price or is about to. A merchant who can switch off
 * "your prices were put back automatically" is a merchant who will one day not
 * know their prices were put back automatically.
 */
export function NotificationSettings({
  initialEmails,
  emailConfigured,
}: {
  initialEmails: string[];
  /** Whether this deployment can actually send mail. */
  emailConfigured: boolean;
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
    const reply = await saveNotificationEmails(emails);
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
          : `We will email ${reply.emails.length === 1 ? "this address" : "these addresses"} whenever a price change starts, moves on, or is undone.`
        : "This is the demo store, so nothing was stored. On a connected store these addresses would be saved against your shop.",
    });
  }

  return (
    <Card>
      <CardHeader
        title="Who we email"
        description="We email when a price change starts, moves to more products, goes below your limit, or is undone. Never anything else."
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
