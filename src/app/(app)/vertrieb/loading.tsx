import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton der Seite «Ressourcen» (§7): Titel, Reiter-Zeile und — wie der
 *  Standard-Reiter «Karte» — Kennzahlen, Suche, Karten der Häuser. */
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
      <Skeleton className="h-9 w-80" />
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))" }}>
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
      </div>
    </div>
  );
}
