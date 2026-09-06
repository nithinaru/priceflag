"use client";

import { animate, spring } from "animejs";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/cn";
import { prefersReducedMotion } from "@/components/motion/reduced-motion";

/**
 * Shared hover / press for every control — metal and plain. CSS :hover fights
 * a spring, so this owns transform on a wrapper and leaves fill/border to the
 * button.
 */
export function PressShell({
  children,
  className,
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || disabled) return;

    let hovered = false;

    function rest() {
      return hovered ? { scale: 1.03, translateY: -1.5 } : { scale: 1, translateY: 0 };
    }

    function toHover() {
      if (prefersReducedMotion()) return;
      hovered = true;
      animate(node, {
        ...rest(),
        duration: 280,
        ease: "out(3)",
      });
    }

    function toRest() {
      if (prefersReducedMotion()) return;
      hovered = false;
      animate(node, {
        scale: 1,
        translateY: 0,
        duration: 320,
        ease: "out(3)",
      });
    }

    function toPress() {
      if (prefersReducedMotion()) return;
      animate(node, {
        scale: 0.97,
        translateY: 0.5,
        duration: 70,
        ease: "out(1)",
      });
    }

    function fromPress() {
      if (prefersReducedMotion()) return;
      animate(node, {
        ...rest(),
        ease: spring({ bounce: 0.22, duration: 420 }),
      });
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.key !== " " && event.key !== "Enter") return;
      toPress();
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== " " && event.key !== "Enter") return;
      fromPress();
    }

    node.addEventListener("pointerenter", toHover);
    node.addEventListener("pointerleave", toRest);
    node.addEventListener("pointerdown", toPress);
    node.addEventListener("pointerup", fromPress);
    node.addEventListener("pointercancel", toRest);
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("keyup", onKeyUp);
    return () => {
      node.removeEventListener("pointerenter", toHover);
      node.removeEventListener("pointerleave", toRest);
      node.removeEventListener("pointerdown", toPress);
      node.removeEventListener("pointerup", fromPress);
      node.removeEventListener("pointercancel", toRest);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("keyup", onKeyUp);
    };
  }, [disabled]);

  return (
    <span ref={ref} className={cn("inline-flex max-w-full origin-center will-change-transform", className)}>
      {children}
    </span>
  );
}
