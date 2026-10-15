// Lade-Skelett fuer die Sicherheits-Seite (§7): bildet das echte Layout grob
// nach — Titel, Kachel-Raster, grosse Karte, zwei Protokoll-Spalten.

export function SicherheitSkelett() {
  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto page-enter">
      <div className="shimmer h-8 w-56 rounded-md" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="shimmer h-[4.5rem] rounded-xl" />
        ))}
      </div>
      <div className="shimmer h-56 rounded-xl" />
      <div className="grid md:grid-cols-2 gap-4">
        <div className="shimmer h-72 rounded-xl" />
        <div className="shimmer h-72 rounded-xl" />
      </div>
    </div>
  );
}
