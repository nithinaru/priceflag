"use client";

import NumberFlow, { type NumberFlowProps } from "@number-flow/react";

export function FlowNumber({
  respectMotionPreference = true,
  ...props
}: NumberFlowProps) {
  return <NumberFlow respectMotionPreference={respectMotionPreference} {...props} />;
}
