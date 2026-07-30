export type ClassValue = string | false | null | undefined;

/**
 * Joins class names, dropping falsy values.
 *
 * Deliberately not `clsx` + `tailwind-merge`: Lane A adds no runtime
 * dependencies (see contracts/requests-lane-a.md, REQ-A-001). Because there is
 * no class-conflict resolution, component variants are written so that a
 * caller's `className` is always appended last and never fights a base class —
 * variants set the properties they own, and nothing else.
 */
export function cn(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (!value) continue;
    out = out ? `${out} ${value}` : value;
  }
  return out;
}
