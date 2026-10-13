// Technik-Dashboard: Lade-Skelett im Layout der Seite (loading.tsx und erster Abruf).

/** Lade-Skelett im Layout der Seite (gleich wie loading.tsx): Kopfzeile, Banner, Szene mit Detail-Spalte. */
export function TechnikSkelett() {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Technik wird geladen">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <div className="shimmer rounded-md h-7 w-32" />
          <div className="shimmer rounded-md h-4 w-80" />
        </div>
        <div className="shimmer rounded-full h-7 w-64" />
      </div>
      <div className="shimmer rounded-xl h-11" />
      <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) clamp(300px,31%,360px)", height: "max(460px, calc(100dvh - 200px))" }}>
        <div className="shimmer rounded-xl" />
        <div className="shimmer rounded-xl" />
      </div>
    </div>
  );
}
