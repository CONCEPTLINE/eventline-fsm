import { Skeleton } from "@/components/ui/skeleton";
import { MeinLohnSkelett } from "@/components/lohn/mein-lohn";

/** Lohn-Skeleton: Titel + Untertitel, Monatsliste, Lohnausweis, Zustellung. CLAUDE.md §7. */
export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <MeinLohnSkelett />
    </div>
  );
}
