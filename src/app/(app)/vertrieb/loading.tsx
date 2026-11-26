import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton der Seite «Ressourcen» (§7): Titel, Reiter-Zeile und — wie der
 *  Standard-Reiter «Karte» — Kennzahlen, Planungsbrett, darunter Karte mit Details. */
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
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-80 w-full rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <Skeleton className="h-[24rem] rounded-xl lg:h-[30rem]" />
        <Skeleton className="h-[24rem] rounded-xl lg:h-[30rem]" />
      </div>
    </div>
  );
}
