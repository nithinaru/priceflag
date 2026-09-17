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

    const target: HTMLSpanElement = node;
    let hovered = false;

    function rest() {
      return hovered ? { scale: 1.03, translateY: -1.5 } : { scale: 1, translateY: 0 };
    }

    function toHover() {
      if (prefersReducedMotion()) return;
      hovered = true;
      animate(target, {
        ...rest(),
        duration: 280,
        ease: "out(3)",
      });
    }

    function toRest() {
      if (prefersReducedMotion()) return;
      hovered = false;
      animate(target, {
        scale: 1,
        translateY: 0,
        duration: 320,
        ease: "out(3)",
      });
    }

    function toPress() {
      if (prefersReducedMotion()) return;
      animate(target, {
        scale: 0.97,
        translateY: 0.5,
        duration: 70,
        ease: "out(1)",
      });
    }

    function fromPress() {
      if (prefersReducedMotion()) return;
      animate(target, {
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

    target.addEventListener("pointerenter", toHover);
    target.addEventListener("pointerleave", toRest);
    target.addEventListener("pointerdown", toPress);
    target.addEventListener("pointerup", fromPress);
    target.addEventListener("pointercancel", toRest);
    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    return () => {
      target.removeEventListener("pointerenter", toHover);
      target.removeEventListener("pointerleave", toRest);
      target.removeEventListener("pointerdown", toPress);
      target.removeEventListener("pointerup", fromPress);
      target.removeEventListener("pointercancel", toRest);
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
    };
  }, [disabled]);

  return (
    <span ref={ref} className={cn("inline-flex max-w-full origin-center will-change-transform", className)}>
      {children}
    </span>
  );
}
