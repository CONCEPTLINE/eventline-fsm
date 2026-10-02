// Personen-Avatar (Initialen-Kreis) — gleicher Look wie die Avatar-
// Chips der Projekte-Uebersicht. Zwei Initialen statt einer, weil im
// Team mehrere Vornamen denselben Anfangsbuchstaben haben (Leo/Lulzim).

export function initialen(name: string | null | undefined): string {
  const teile = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (teile.length === 0) return "?";
  const erst = teile[0][0] ?? "";
  const letzt = teile.length > 1 ? teile[teile.length - 1][0] ?? "" : "";
  return (erst + letzt).toUpperCase();
}

const GROESSE = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-7 w-7 text-[11px]",
} as const;

export function PersonAvatar({
  name,
  size = "sm",
  tooltip,
}: {
  name: string | null | undefined;
  size?: keyof typeof GROESSE;
  /** Tooltip-Text; Standard = voller Name. */
  tooltip?: string;
}) {
  return (
    <span
      className={`${GROESSE[size]} rounded-full flex items-center justify-center font-bold shrink-0 bg-foreground/10 dark:bg-foreground/15 text-foreground/80`}
      data-tooltip={tooltip ?? name ?? undefined}
      aria-label={name ?? undefined}
    >
      {initialen(name)}
    </span>
  );
}
