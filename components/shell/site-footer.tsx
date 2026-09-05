import Link from "next/link";

import { Button } from "@/components/ui";
import { IconIbis } from "@/components/ui/icons";

type SiteFooterProps = {
  shopDomain?: string;
};

export function SiteFooter({ shopDomain }: SiteFooterProps) {
  const headline = shopDomain ?? "Priceflag";

  return (
    <footer
      role="contentinfo"
      className="rounded-t-[26px] bg-[#d8f24b] text-[#0d1f00]"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <IconIbis size={22} />
          <p className="font-display text-lg leading-none">{headline}</p>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link
            href="/journal"
            className="text-base font-medium text-[#0d1f00] underline-offset-2 hover:underline"
          >
            Journal
          </Link>
          <Link
            href="/settings"
            className="text-base font-medium text-[#0d1f00] underline-offset-2 hover:underline"
          >
            Settings
          </Link>
          <form action="/auth/sign-out" method="post">
            <Button type="submit" variant="neonDark" size="sm">
              Sign out
            </Button>
          </form>
        </nav>
      </div>

      <div className="flex flex-col items-center justify-center gap-1 border-t border-[#0d1f00]/15 px-6 py-4 text-center text-sm text-[#0d1f00]/80 sm:flex-row sm:gap-3">
        <span>Built by Humans in San Francisco, CA</span>
        <span className="hidden sm:inline" aria-hidden="true">
          ·
        </span>
        <a
          href="https://www.streamlinehq.com"
          className="underline-offset-2 hover:underline"
        >
          Icons by Streamline, CC BY 4.0
        </a>
      </div>
    </footer>
  );
}
