// Technik-Dashboard: Lade-Skelett im Layout der Seite (loading.tsx und erster Abruf).

/** Lade-Skelett im Layout der Seite (gleich wie loading.tsx). */
export function TechnikSkelett() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Technik wird geladen">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <div className="shimmer rounded-md h-3 w-28" />
          <div className="shimmer rounded-md h-9 w-40" />
          <div className="shimmer rounded-md h-4 w-72" />
        </div>
        <div className="shimmer rounded-full h-8 w-64" />
      </div>
      <div className="shimmer rounded-xl h-16" />
      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,340px)" }}>
        <div className="shimmer rounded-xl" style={{ height: 760 }} />
        <div className="shimmer rounded-xl" style={{ height: 520 }} />
      </div>
      <div className="shimmer rounded-xl h-56" />
    </div>
  );
}
