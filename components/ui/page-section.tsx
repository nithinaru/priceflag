import type { ReactNode } from "react";
import { Separator } from "@base-ui/react/separator";
import { cn } from "@/components/cn";

/**
 * Editorial block: Hedvig title, a Base UI hairline, then the section body.
 * Prefer this over Card when the page does not need a boxed panel.
 */
export function PageSection({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      {title ? <h2 className="font-display text-xl text-ink">{title}</h2> : null}
      <Separator className="h-px bg-border" />
      {children}
    </section>
  );
}
