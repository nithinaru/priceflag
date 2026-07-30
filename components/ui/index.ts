/**
 * The Priceflag design system, Lane A. Import from here, not from the files.
 *
 * Rules that hold across every primitive:
 * - colour comes from semantic tokens only, so light and dark are correct by
 *   construction and no component writes a `dark:` variant
 * - status colour meanings are fixed: live / hold / breach / accent
 * - one primary action per screen
 * - every component has an empty, loading and error story, or it is not done
 */

export { Badge, Tag } from "@/components/ui/badge";
export type { BadgeTone, BadgeSize } from "@/components/ui/badge";

export { Button, ButtonLink, TextLink, buttonClasses } from "@/components/ui/button";
export type { ButtonVariant, ButtonSize } from "@/components/ui/button";

export { Card, CardBody, CardDivider, CardFooter, CardHeader } from "@/components/ui/card";
export type { CardTone } from "@/components/ui/card";

export { EmptyState } from "@/components/ui/empty-state";

export { Checkbox, Field, Input, SearchInput, Select } from "@/components/ui/input";

export { Modal } from "@/components/ui/modal";

export { Notice } from "@/components/ui/notice";
export type { NoticeTone } from "@/components/ui/notice";

export { PageHeader } from "@/components/ui/page-header";

export { Skeleton, SkeletonCard, SkeletonTable, SkeletonText } from "@/components/ui/skeleton";

export { DetailList, DetailRow, Stat, StatGroup } from "@/components/ui/stat";

export {
  CellNote,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableEmptyRow,
} from "@/components/ui/table";

export { ToastProvider, useToast } from "@/components/ui/toast";
export type { Toast, ToastTone } from "@/components/ui/toast";
