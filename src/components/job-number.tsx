// Eine zentrale Stelle fuer die Optik der Auftragsnummer (INT-XXXXX).
// Wird ueberall verwendet wo eine job_number visuell angezeigt wird —
// damit eine Aenderung des Designs immer alle Stellen erreicht.
//
// Stil: mono + semibold + dezenter neutraler Hintergrund-Pill via foreground/[0.08].
// Theme-adaptiv (light = subtle gray, dark = subtle near-white). Keine Farbe — der
// Identifier soll auffallen durch Form, nicht durch Buntheit.

interface JobNumberProps {
  number: number | null | undefined;
  /** Default 'sm' (text-xs). 'md' fuer Detail-Header, 'lg' fuer Hero-Anzeige, 'xl' fuer Page-Title. */
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeClasses = {
  sm: "text-sm px-2 py-0.5",
  md: "text-base px-2.5 py-1",
  lg: "text-lg px-3 py-1",
  xl: "text-2xl px-3.5 py-1.5",
};

export function JobNumber({ number, size = "sm", className = "" }: JobNumberProps) {
  if (!number) return null;
  return (
    <span
      className={`inline-flex items-center font-mono font-semibold rounded bg-card whitespace-nowrap ${sizeClasses[size]} ${className}`}
    >
      INT-{number}
    </span>
  );
}
