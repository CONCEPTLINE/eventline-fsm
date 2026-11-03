import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mein-Konto-Skeleton im Layout der Seite: Kopf, Karte «Melden» mit vier
 * Kacheln, darunter «Meine Anfragen» und «Meine Zeit & Lohn» nebeneinander
 * (Handy: untereinander), dann Tabs der Einstellungen.
 */
export default function Loading() {
  const karte = "rounded-xl border bg-card p-5 space-y-3.5";
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className={karte}>
        <Skeleton className="h-5 w-24" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[64px] rounded-xl" />
          ))}
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((k) => (
          <div key={k} className={karte}>
            <Skeleton className="h-5 w-36" />
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[34px]" />)}
          </div>
        ))}
      </div>
      <div className="space-y-3 pt-3">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-9 w-full max-w-md" />
      </div>
    </div>
  );
}
