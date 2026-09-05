import type { SVGProps } from "react";
import { cn } from "@/components/cn";

/**
 * Inline icons, so Lane A ships no icon dependency (REQ-A-001).
 *
 * All are 24×24, ink-style strokes (~1.2–2.1), `currentColor`, and inherit size
 * from the `size` prop (default 16). Decorative by default: `aria-hidden` unless
 * a `title` is passed, in which case the icon becomes an image with an accessible
 * name.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
  title?: string;
};

function Icon({ size = 16, title, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/**
 * The Priceflag ibis, from priceflag.org/ibis.svg. Logo only — nav tools stay
 * ink strokes. `currentColor` so cream chrome is navy and the lime footer is ink.
 */
export function IconIbis({
  size = 22,
  title,
  className,
}: {
  size?: number;
  title?: string;
  className?: string;
}) {
  const height = size;
  const width = Math.round((size * 621) / 402);
  return (
    <span
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        width,
        height,
        WebkitMaskImage: "url(/ibis.svg)",
        maskImage: "url(/ibis.svg)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

export function IconFlag(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.8 21V4.3" strokeWidth={1.9} />
      <path
        d="M5.8 4.6c2.4-.4 5.1-.9 8.1-.2 1.4.3 2.2 1.3 1.9 2.8-.2 1-1.1 1.6-2.2 1.9L5.8 10.2V4.6Z"
        strokeWidth={1.5}
      />
      <path d="M5.8 10.2c1.8-.3 3.6-.2 5.4.4" strokeWidth={1.3} />
    </Icon>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.4v9.6" strokeWidth={1.6} />
      <path d="M8.4 10.8 12 14.6l3.8-4.1" strokeWidth={2} />
      <path d="M5.8 17.6h12.6c.7 0 1.2-.5 1.2-1.2v-.9" strokeWidth={1.4} />
      <path d="M8.2 19.2h7.8" strokeWidth={1.2} />
    </Icon>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 3.8c.9-.6 2-.3 2.4.7l.5 1.5c.3.8 1.1 1.2 1.9 1l1.6-.4c1-.2 2 .5 2 1.6v1.6c0 .9-.6 1.7-1.5 1.9l-1.7.4c-.8.2-1.3 1-1.1 1.8l.4 1.7c.2 1-1 1.9-2 1.5l-1.5-.7c-.7-.3-1.5-.1-1.9.5l-.9 1.3c-.6.9-1.9 1-2.5 0l-.9-1.3c-.4-.6-1.2-.8-1.9-.5l-1.5.7c-1 .4-2.2-.5-2-1.5l.4-1.7c.2-.8-.3-1.6-1.1-1.8l-1.7-.4c-.9-.2-1.5-1-1.5-1.9v-1.6c0-1.1 1-1.8 2-1.6l1.6.4c.8.2 1.6-.2 1.9-1l.5-1.5c.4-1 1.5-1.3 2.4-.7Z"
        strokeWidth={1.3}
      />
      <path d="M12 9.8c1.2 0 2.2 1 2.2 2.2s-1 2.2-2.2 2.2-2.2-1-2.2-2.2 1-2.2 2.2-2.2Z" strokeWidth={1.5} />
    </Icon>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.2 17.8c1.8-4.6 5.8-7.6 10.6-7.6 4.1 0 7.7 2.3 9.4 5.7" strokeWidth={1.5} />
      <path d="M6.4 18.2h11.4" strokeWidth={1.2} />
      <path d="M12 15.2 15.8 9.6" strokeWidth={1.8} />
      <path d="M11.2 15.4c.5-.1 1-.1 1.5.1" strokeWidth={1.6} />
      <path d="M7.6 17.4l-.8-.6M16.6 17.2l.7-.5" strokeWidth={1.2} />
    </Icon>
  );
}

export function IconTag(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M13.1 3.6H20v6.9l-8.4 8.6c-1.1 1.1-2.9 1.1-4 0L4.4 14.8c-1.1-1.1-1.1-2.9 0-4L13.1 3.6Z"
        strokeWidth={1.5}
      />
      <path d="M16.4 7.2c.8-.1 1.5.6 1.4 1.4-.1.7-.7 1.2-1.4 1.1" strokeWidth={1.4} />
      <path d="M9.2 8.8 6.8 11.2" strokeWidth={1.2} />
    </Icon>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.8 8.2 12 4.2l7.4 4.2-7.4 4-7.2-4.2Z" strokeWidth={1.6} />
      <path d="M4.8 8.2v1.2l7.2 4.1 7.4-4.1V8.2" strokeWidth={1.3} />
      <path d="M6.2 13.4l5.8 3.3 5.9-3.3" strokeWidth={1.5} />
      <path d="M6.4 17.2 12 20.4l5.8-3.4" strokeWidth={1.5} />
      <path d="M9.4 6.8h5.4M8.8 11.4h6.6M9.6 16h5" strokeWidth={1.1} />
    </Icon>
  );
}

export function IconBook(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M4.6 4.8c0-.9.8-1.6 1.7-1.6H19v16.4H6.3c-1 0-1.7-.7-1.7-1.6V4.8Z"
        strokeWidth={1.5}
      />
      <path d="M8.4 3.2v16.4" strokeWidth={1.6} />
      <path d="M10.2 7.4h7.2M10.2 10.6h6.8M10.2 13.8h7M10.2 17h5.6" strokeWidth={1.2} />
      <path d="M6.8 6.2c.3-.2.7-.3 1.1-.3" strokeWidth={1.3} />
    </Icon>
  );
}

export function IconBeaker(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.8 3.6h6.6" strokeWidth={1.7} />
      <path d="M10.2 3.6v5.4l-4.8 8.2c-.8 1.4.2 3.2 1.8 3.2h9.6c1.6 0 2.6-1.8 1.8-3.2l-4.9-8.2V3.6" strokeWidth={1.4} />
      <path d="M7.4 14.8h9.4" strokeWidth={1.5} />
      <path d="M8.6 17.2h6.8" strokeWidth={1.2} />
      <path d="M11.2 9.4h1.8" strokeWidth={1.3} />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.8 12.4 9.8 17.2 19.4 6.8" strokeWidth={2.1} />
    </Icon>
  );
}

export function IconCheckCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 3.4c4.9.3 8.6 4.4 8.6 8.6s-3.7 8.3-8.6 8.6c-4.9-.3-8.6-4.4-8.6-8.6S7.1 3.7 12 3.4Z"
        strokeWidth={1.4}
      />
      <path d="M8.2 12.3 10.8 15l5.4-6.2" strokeWidth={1.9} />
    </Icon>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 3.8 20.2 18.4c.5.9-.2 2-1.2 2H4.9c-1 0-1.7-1.1-1.2-2L12 3.8Z"
        strokeWidth={1.5}
      />
      <path d="M12 9.2v5.2" strokeWidth={1.8} />
      <path d="M12 16.8c.5 0 .9-.4.9-.9s-.4-.9-.9-.9-.9.4-.9.9.4.9.9.9Z" strokeWidth={1.4} />
    </Icon>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 3.6c4.8.2 8.4 4.1 8.4 8.4s-3.6 8.2-8.4 8.4c-4.8-.2-8.4-4.1-8.4-8.4S7.2 3.8 12 3.6Z"
        strokeWidth={1.4}
      />
      <path d="M12 10.8v5.4" strokeWidth={1.7} />
      <path d="M12 7.6c.6 0 1-.4 1-.9s-.4-1-1-1-1 .4-1 1 .4.9 1 .9Z" strokeWidth={1.5} />
    </Icon>
  );
}

export function IconUndo(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M4.2 9.4h9.8c3.8 0 6.8 2.8 6.8 6.2s-3 6.2-6.8 6.2H8.4"
        strokeWidth={1.5}
      />
      <path d="M7.8 4.8 4.2 9.4l3.8 4.4" strokeWidth={1.8} />
    </Icon>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.2 5.8v12.6" strokeWidth={2} />
      <path d="M14.8 6.2v12.2" strokeWidth={1.8} />
    </Icon>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 3.8c4.7.2 8.2 4 8.2 8.2s-3.5 8-8.2 8.2c-4.7-.2-8.2-4-8.2-8.2S7.3 4 12 3.8Z"
        strokeWidth={1.4}
      />
      <path d="M12 7.8V12l3.6 2.4" strokeWidth={1.7} />
      <path d="M12 3.8V2.6M12 21.4v-1.2M3.8 12H2.6M21.4 12h-1.2" strokeWidth={1.2} />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M10.8 4.8c3.4.2 6 3 6 6.2s-2.6 6-6 6.2c-3.4-.2-6-3-6-6.2s2.6-6 6-6.2Z"
        strokeWidth={1.5}
      />
      <path d="M15.4 15.6 20 20.2" strokeWidth={2} />
      <path d="M8.6 8.8c1.2-.8 2.8-.6 3.8.4" strokeWidth={1.2} />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.4 6.2 17.8 17.6" strokeWidth={1.9} />
      <path d="M17.6 6.4 6.2 17.8" strokeWidth={1.9} />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.2 5.8 16.4 12l-7.2 6.4" strokeWidth={1.8} />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.6 12h14.8" strokeWidth={1.6} />
      <path d="M14.2 6.4 19.4 12l-5.2 5.8" strokeWidth={1.9} />
    </Icon>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19.6V4.8" strokeWidth={1.6} />
      <path d="M6.2 10.6 12 4.8l5.8 5.8" strokeWidth={1.9} />
    </Icon>
  );
}

export function IconArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.4v14.8" strokeWidth={1.6} />
      <path d="M6.2 13.4 12 19.2l5.8-5.8" strokeWidth={1.9} />
    </Icon>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.2 7.2h15.2" strokeWidth={1.8} />
      <path d="M4.6 12h14.4" strokeWidth={1.6} />
      <path d="M4.2 16.8h15.6" strokeWidth={1.7} />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.2v13.8" strokeWidth={1.8} />
      <path d="M5.2 12.2h13.8" strokeWidth={1.8} />
    </Icon>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.8 13.6 6.4 5.2h11.4l2.6 8.4v5.2H3.8v-5.2Z" strokeWidth={1.5} />
      <path d="M3.8 13.6h4.2l1.2 2.8h7.4l1.1-2.8h4.1" strokeWidth={1.4} />
      <path d="M8.6 9.2h6.8" strokeWidth={1.2} />
    </Icon>
  );
}
