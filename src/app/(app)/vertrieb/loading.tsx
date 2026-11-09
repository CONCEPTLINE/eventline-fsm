import { Skeleton } from "@/components/ui/skeleton";

/** Vertriebs-Skeleton (§7): Titel, Reiter-Zeile und — wie der Standard-
 *  Reiter «Heute» — Aufgaben links, Termine und Antworten rechts. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-32" />
      <div className="flex gap-2 border-b pb-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
        <Skeleton className="h-[320px] rounded-xl" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[200px] rounded-xl" />
          <Skeleton className="h-[120px] rounded-xl" />
        </div>
      </div>
    </div>
  );
}
