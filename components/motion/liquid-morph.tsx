"use client";

import { Liquid, type TransitionPreset } from "liquid-gooey";
import type { ReactNode } from "react";
import { cn } from "@/components/cn";

export function LiquidMorph({
  transition = "bouncy",
  fill,
  className,
  children,
}: {
  transition?: TransitionPreset;
  fill: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Liquid blur={5} contrast={16} fill={fill} className={cn("inline-flex", className)}>
      <Liquid.Item morph={{ shape: true }} transition={transition}>
        {children}
      </Liquid.Item>
    </Liquid>
  );
}
