import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton der Seite «Ressourcen» (§7): Titel, Reiter-Zeile und — wie der
 *  Standard-Reiter «Karte» — Liste links, Karte in der Mitte, Details rechts. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-32" />
      <div className="flex gap-2 border-b pb-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,25rem)]">
        <Skeleton className="h-[26rem] rounded-xl lg:h-[36rem]" />
        <Skeleton className="h-[26rem] rounded-xl lg:h-[36rem]" />
        <Skeleton className="h-[26rem] rounded-xl lg:h-[36rem]" />
      </div>
    </div>
  );
}
