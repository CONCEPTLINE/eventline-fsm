import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton «Mails zuordnen»: Kopf + Mail-Karten. CLAUDE.md §7. */
export default function Loading() {
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center gap-4">
        <Skeleton className="h-9 w-9" />
        <Skeleton className="h-8 w-48" />
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <Skeleton key={i} className="h-44" />
      ))}
    </div>
  );
}
