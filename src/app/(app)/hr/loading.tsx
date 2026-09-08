import { Skeleton } from "@/components/ui/skeleton";

/**
 * HR-Hub-Skeleton: Titel + Top-Tab-Leiste (Underline-Nav) + Sub-Toggle-
 * Buttons + Listen-Cards. Bildet den Tab-Hub (Stempelzeiten/Ferien/…)
 * grob nach. CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-24" />
      <div className="flex gap-1 border-b">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-none" />
        ))}
      </div>
      <div className="flex gap-2 flex-wrap">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    </div>
  );
}
