"use client";

import { Liquid, type TransitionPreset } from "liquid-gooey";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/cn";

export function LiquidNav({
  activeKey,
  transition = "smooth",
  fill = "var(--pf-neon)",
  children,
  className,
}: {
  activeKey: string;
  transition?: TransitionPreset;
  fill?: string;
  children: ReactNode;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ x: 0, y: 0, width: 0, height: 0 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function measure() {
      if (!root) return;
      const active = root.querySelector<HTMLElement>(`[data-liquid-nav="${CSS.escape(activeKey)}"]`);
      if (!active) return;
      const rootBox = root.getBoundingClientRect();
      const itemBox = active.getBoundingClientRect();
      setBox({
        x: itemBox.left - rootBox.left + root.scrollLeft,
        y: itemBox.top - rootBox.top + root.scrollTop,
        width: itemBox.width,
        height: itemBox.height,
      });
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeKey, children]);

  return (
    <div className={cn("relative", className)}>
      <div ref={rootRef} className="relative">
        <Liquid
          aria-hidden="true"
          blur={7}
          contrast={18}
          fill={fill}
          className="pointer-events-none absolute inset-0 overflow-visible"
        >
          <Liquid.Item
            effect="move"
            x={box.x}
            y={box.y}
            transition={transition}
            move={{ springiness: 0.55, trail: 0.45, wobble: 0.35 }}
            style={{ width: box.width || 1, height: box.height || 1 }}
          >
            <div className="h-full w-full rounded-md bg-transparent" />
          </Liquid.Item>
        </Liquid>
        <div className="relative">{children}</div>
      </div>
    </div>
  );
}
