"use client";

import { Fragment, createElement, type ComponentType, type ReactNode } from "react";
import * as ReactNS from "react";

type ViewTransitionProps = {
  children?: ReactNode;
  name?: string;
  default?: "none" | "auto" | (string & {});
};

function resolveViewTransition() {
  const candidate = (ReactNS as Record<string, unknown>)["ViewTransition"];
  return typeof candidate === "function" ? candidate : null;
}

/**
 * React 19 / Next ViewTransition when `experimental.viewTransition` is on.
 * Falls back to a fragment if the export is missing from this React build.
 */
export function MotionViewTransition({
  children,
  name,
  defaultClass = "auto",
}: {
  children: ReactNode;
  name?: string;
  defaultClass?: ViewTransitionProps["default"];
}) {
  const Transition = resolveViewTransition();
  if (!Transition) return createElement(Fragment, null, children);
  return createElement(Transition as ComponentType<ViewTransitionProps>, {
    name,
    default: defaultClass,
    children,
  });
}
