import { Skeleton } from "@/components/ui/skeleton";

/**
 * Abwesenheit-Skeleton: Header + 3 KPI-Cards + Ansicht-Toggles +
 * Antrags-Cards. Deckt den Deep-Link /ferien (Notifications) ab.
 * CLAUDE.md §7.
 */
export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    </div>
  );
}
