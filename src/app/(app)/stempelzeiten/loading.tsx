import { Skeleton } from "@/components/ui/skeleton";

/**
 * Stempelzeiten-Skeleton: Header + Ansicht-Toggles + Eintrags-Cards.
 * Deckt den Deep-Link /stempelzeiten (Notifications, Stempel-Pille) ab.
 * CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
