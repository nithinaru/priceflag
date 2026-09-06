"use client";

import { MetalFx } from "metal-fx";
import type { ReactElement } from "react";
import { cn } from "@/components/cn";
import { usePrefersReducedMotion } from "@/components/motion/reduced-motion";

export function MetalCta({
  children,
  paused = false,
  theme = "light",
  className,
}: {
  children: ReactElement;
  paused?: boolean;
  theme?: "light" | "dark";
  className?: string;
}) {
  const reduce = usePrefersReducedMotion();
  return (
    <MetalFx
      variant="button"
      theme={theme}
      paused={paused || reduce}
      className={cn("inline-flex max-w-full", className)}
    >
      {children}
    </MetalFx>
  );
}
