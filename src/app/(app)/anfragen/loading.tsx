import { Skeleton } from "@/components/ui/skeleton";

/** Meine-Anfragen-Skelett: Titel, Melden-Knoepfe, Offen|Erledigt, Zeilen. */
export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="space-y-2 max-md:hidden">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex gap-2 max-md:hidden">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-28" />)}
      </div>
      <Skeleton className="h-[34px] w-64" />
      <div className="space-y-px overflow-hidden rounded-xl border border-border">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[46px] rounded-none" />)}
      </div>
    </div>
  );
}
