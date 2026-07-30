import type { SVGProps } from "react";

/**
 * Inline icons, so Lane A ships no icon dependency (REQ-A-001).
 *
 * All are 24×24, 1.75 stroke, `currentColor`, and inherit size from the `size`
 * prop (default 16). Decorative by default: `aria-hidden` unless a `title` is
 * passed, in which case the icon becomes an image with an accessible name.
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

export function IconFlag(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 21V4.5" />
      <path d="M5 4.5h9.5l-1 3 1 3H5" />
    </Icon>
  );
}

export function IconGauge(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 14.5 16 9" />
      <path d="M3.5 18a9.5 9.5 0 1 1 17 0" />
      <circle cx="12" cy="15" r="1.6" />
    </Icon>
  );
}

export function IconTag(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.6 3.5H20v7.4l-8.7 8.7a2 2 0 0 1-2.8 0L4 14.9a2 2 0 0 1 0-2.8Z" />
      <circle cx="16.3" cy="7.7" r="1.3" />
    </Icon>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
      <path d="m3.5 17 8.5 4.5 8.5-4.5" />
    </Icon>
  );
}

export function IconBook(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5Z" />
      <path d="M8 3v18" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  );
}

export function IconCheckCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.5 2.5L16 9.5" />
    </Icon>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.4h.01" />
    </Icon>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6h.01" />
    </Icon>
  );
}

export function IconUndo(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9h9.5a5.5 5.5 0 1 1 0 11H8" />
      <path d="m7.5 4.5-3.6 4.5 3.6 4.5" />
    </Icon>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 5.5v13" />
      <path d="M14.5 5.5v13" />
    </Icon>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3.2 2" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9.5 5.5 7 6.5-7 6.5" />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </Icon>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19.5v-15" />
      <path d="m6 10.5 6-6 6 6" />
    </Icon>
  );
}

export function IconArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5v15" />
      <path d="m6 13.5 6 6 6-6" />
    </Icon>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 13.5 6 5h12l2.5 8.5v5H3.5Z" />
      <path d="M3.5 13.5h4l1 2.5h7l1-2.5h4" />
    </Icon>
  );
}
