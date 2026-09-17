"use client";

import { animate, createScope, spring, stagger } from "animejs";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/components/cn";
import { prefersReducedMotion } from "@/components/motion/reduced-motion";

export function LiveCardOutline({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !active || prefersReducedMotion()) return;

    const animation = animate(node, {
      boxShadow: [
        "0 0 0 0 rgb(13 119 72 / 0)",
        "0 0 0 4px rgb(13 119 72 / 0.28)",
        "0 0 0 0 rgb(13 119 72 / 0)",
      ],
      ease: spring({ bounce: 0.35, duration: 900 }),
      loop: true,
      loopDelay: 420,
    });

    return () => {
      animation.revert();
    };
  }, [active]);

  if (!active) return children;

  return (
    <div ref={ref} className="rounded-lg">
      {children}
    </div>
  );
}

export function PresenceEnter({
  show,
  children,
  className,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!show || !node || prefersReducedMotion()) return;

    const animation = animate(node, {
      translateY: [28, 0],
      opacity: [0, 1],
      ease: spring({ bounce: 0.28, duration: 520 }),
    });

    return () => {
      animation.revert();
    };
  }, [show]);

  if (!show) return null;

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

export function DotsLoading({ className }: { className?: string }) {
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = root.current;
    if (!node || prefersReducedMotion()) return;

    const scope = createScope({ root }).add(() => {
      animate(".pf-wait-dot", {
        translateY: [
          { to: -3, duration: 160 },
          { to: 0, ease: spring({ bounce: 0.55, duration: 380 }) },
        ],
        delay: stagger(90),
        loop: true,
        loopDelay: 160,
      });
    });

    return () => {
      scope.revert();
    };
  }, []);

  return (
    <span
      ref={root}
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-hidden="true"
    >
      <span className="pf-wait-dot size-1 rounded-full bg-current" />
      <span className="pf-wait-dot size-1 rounded-full bg-current" />
      <span className="pf-wait-dot size-1 rounded-full bg-current" />
    </span>
  );
}

export function useFocusSpring(ref: { readonly current: HTMLElement | null }) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    function onFocus() {
      if (!node || prefersReducedMotion()) return;
      animate(node, {
        scale: [1, 1.012, 1],
        ease: spring({ bounce: 0.32, duration: 420 }),
      });
    }

    node.addEventListener("focus", onFocus);
    return () => node.removeEventListener("focus", onFocus);
  }, [ref]);
}
