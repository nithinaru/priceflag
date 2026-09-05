import type { SVGProps } from "react";
import { cn } from "@/components/cn";
import { FREEHAND_GLYPHS } from "@/components/ui/freehand-glyphs";

/**
 * Chrome icons are Streamline Freehand (CC BY 4.0). Attribution lives in the
 * app footer. Ibis stays the logo only — never a nav glyph.
 *
 * Decorative by default: `aria-hidden` unless a `title` is passed.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
  title?: string;
};

function FreehandIcon({
  glyph,
  size = 16,
  title,
  ...props
}: IconProps & { glyph: keyof typeof FREEHAND_GLYPHS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <g dangerouslySetInnerHTML={{ __html: FREEHAND_GLYPHS[glyph].body }} />
    </svg>
  );
}

/**
 * The Priceflag ibis, from priceflag.org/ibis.svg. Logo only — nav tools stay
 * Freehand. `currentColor` so cream chrome is navy and the lime footer is ink.
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
  return <FreehandIcon glyph="flag" {...props} />;
}

export function IconDownload(props: IconProps) {
  return <FreehandIcon glyph="download" {...props} />;
}

export function IconSettings(props: IconProps) {
  return <FreehandIcon glyph="settings" {...props} />;
}

export function IconGauge(props: IconProps) {
  return <FreehandIcon glyph="gauge" {...props} />;
}

export function IconTag(props: IconProps) {
  return <FreehandIcon glyph="tag" {...props} />;
}

export function IconLayers(props: IconProps) {
  return <FreehandIcon glyph="layers" {...props} />;
}

export function IconBook(props: IconProps) {
  return <FreehandIcon glyph="book" {...props} />;
}

export function IconBeaker(props: IconProps) {
  return <FreehandIcon glyph="beaker" {...props} />;
}

export function IconCheck(props: IconProps) {
  return <FreehandIcon glyph="check" {...props} />;
}

export function IconCheckCircle(props: IconProps) {
  return <FreehandIcon glyph="checkCircle" {...props} />;
}

export function IconAlert(props: IconProps) {
  return <FreehandIcon glyph="alert" {...props} />;
}

export function IconInfo(props: IconProps) {
  return <FreehandIcon glyph="info" {...props} />;
}

export function IconUndo(props: IconProps) {
  return <FreehandIcon glyph="undo" {...props} />;
}

export function IconPause(props: IconProps) {
  return <FreehandIcon glyph="pause" {...props} />;
}

export function IconClock(props: IconProps) {
  return <FreehandIcon glyph="clock" {...props} />;
}

export function IconSearch(props: IconProps) {
  return <FreehandIcon glyph="search" {...props} />;
}

export function IconClose(props: IconProps) {
  return <FreehandIcon glyph="close" {...props} />;
}

export function IconChevronRight(props: IconProps) {
  return <FreehandIcon glyph="chevronRight" {...props} />;
}

export function IconArrowRight(props: IconProps) {
  return <FreehandIcon glyph="arrowRight" {...props} />;
}

export function IconArrowUp(props: IconProps) {
  return <FreehandIcon glyph="arrowUp" {...props} />;
}

export function IconArrowDown(props: IconProps) {
  return <FreehandIcon glyph="arrowDown" {...props} />;
}

export function IconMenu(props: IconProps) {
  return <FreehandIcon glyph="menu" {...props} />;
}

export function IconPlus(props: IconProps) {
  return <FreehandIcon glyph="plus" {...props} />;
}

export function IconInbox(props: IconProps) {
  return <FreehandIcon glyph="inbox" {...props} />;
}
