import { Skeleton } from "@/components/ui/skeleton";

/**
 * Akquise-Skeleton: Kopf mit Gebietssuche, darunter Trefferliste links und
 * Detailfläche rechts — bildet das echte Layout nach (§7).
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4 h-[calc(100dvh-290px)] md:h-[calc(100vh-72px)]">
      <div className="flex flex-wrap items-end justify-between gap-3 shrink-0">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-80 shrink-0 space-y-1.5 rounded-lg border border-border p-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
        <Skeleton className="min-w-0 flex-1" />
      </div>
    </div>
  );
}
