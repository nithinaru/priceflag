import Link from "next/link";

import { ButtonLink } from "@/components/ui";
import { IconArrowRight, IconIbis } from "@/components/ui/icons";

type SiteFooterProps = {
  shopDomain?: string;
};

const COL_PRIMARY = [
  { href: "/", label: "Overview" },
  { href: "/products", label: "Products" },
  { href: "/rollouts", label: "Price changes" },
  { href: "/journal", label: "Journal" },
  { href: "/settings", label: "Settings" },
] as const;

const COL_SECONDARY = [
  { href: "/connect", label: "Connect store" },
  { href: "https://priceflag.org/about", label: "About", external: true },
] as const;

export function SiteFooter({ shopDomain }: SiteFooterProps) {
  return (
    <footer role="contentinfo" className="pf-app-foot">
      <div className="pf-app-foot-inner">
        <div className="pf-app-foot-top">
          <div className="pf-app-foot-lead">
            <Link href="/" className="pf-app-foot-mark">
              <IconIbis size={22} />
              Priceflag
            </Link>
            <h2 className="pf-app-foot-head">
              {shopDomain ? (
                shopDomain
              ) : (
                <>
                  A tool for <span className="whitespace-nowrap">Shopify</span> &amp; more
                </>
              )}
            </h2>
            <ButtonLink
              href="/products"
              variant="neon"
              size="lg"
              className="pf-app-foot-cta mt-1 self-start"
              iconRight={<IconArrowRight size={17} />}
            >
              Go to your products
            </ButtonLink>
          </div>

          <nav className="pf-app-foot-nav" aria-label="Footer">
            <ul className="pf-app-foot-col">
              {COL_PRIMARY.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="pf-app-foot-link">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="pf-app-foot-col">
              {COL_SECONDARY.map((item) => (
                <li key={item.href}>
                  {"external" in item && item.external ? (
                    <a href={item.href} className="pf-app-foot-link">
                      {item.label}
                    </a>
                  ) : (
                    <Link href={item.href} className="pf-app-foot-link">
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
              <li>
                <form action="/auth/sign-out" method="post">
                  <button type="submit" className="pf-app-foot-link">
                    Sign out
                  </button>
                </form>
              </li>
            </ul>
          </nav>
        </div>

        <svg
          className="pf-app-foot-word"
          viewBox="30 -804 3896 1061"
          aria-hidden="true"
          focusable="false"
          preserveAspectRatio="xMidYMid meet"
        >
          <text x="0" y="0" textLength="3931.02" lengthAdjust="spacingAndGlyphs">
            Priceflag
          </text>
        </svg>

        <div className="pf-app-foot-bar">
          <span>Built by Humans in San Francisco, CA</span>
          <div className="pf-app-foot-legal">
            <a href="https://www.streamlinehq.com">Icons by Streamline, CC BY 4.0</a>
            <a href="https://priceflag.org/contact">Contact</a>
            <a href="https://priceflag.org/legal">Legal</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
