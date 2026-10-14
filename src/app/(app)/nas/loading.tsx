// Sofortiges Lade-Skeleton fuer die NAS-Ablage (§7: nie im Unklaren) —
// bildet den Tab «Ablage» nach: Kopf, Tabs, links Ablegen + Zuletzt
// abgelegt, rechts Einsortieren/Fristen.
export default function AblageLoading() {
  return (
    <div className="space-y-6">
      <div className="shimmer rounded-md h-8 w-52" />
      <div className="shimmer rounded-md h-9 w-72" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <div className="shimmer rounded-xl h-24" />
          <div className="shimmer rounded-xl h-64" />
        </div>
        <div className="shimmer rounded-xl h-96" />
      </div>
    </div>
  );
}
