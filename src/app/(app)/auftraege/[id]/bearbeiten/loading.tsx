import { Skeleton } from "@/components/ui/skeleton";

/**
 * Auftrag-bearbeiten-Skeleton (§7): erscheint sofort beim Klick auf
 * «Bearbeiten» im Auftragskopf — Kopfzeile (Zurück, Titel, Nummer) und die
 * Formular-Karte wie auf der echten Seite (max-w-2xl).
 */
export default function Loading() {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-6 w-20 ml-auto" />
      </div>
      <div className="rounded-xl border bg-card p-5 space-y-5">
        <Skeleton className="h-9 w-56" />
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-9" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-20" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
        <div className="flex gap-3 pt-2">
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="h-8 flex-1" />
        </div>
      </div>
    </div>
  );
}
