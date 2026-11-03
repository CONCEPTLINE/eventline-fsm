import { Skeleton } from "@/components/ui/skeleton";

/** Meine-Anfragen-Skelett: Titel links + Melden-Knoepfe rechts, Offen|Erledigt, Karten. */
export default function Loading() {
  return (
    <div className="space-y-4 md:space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 max-md:hidden">
        <div className="space-y-2">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-28 rounded-xl" />)}
        </div>
      </div>
      <div className="flex gap-1">
        <Skeleton className="h-8 w-24 rounded-xl max-md:h-[34px]" />
        <Skeleton className="h-8 w-20 rounded-xl max-md:h-[34px]" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[52px] rounded-xl" />)}
      </div>
    </div>
  );
}
