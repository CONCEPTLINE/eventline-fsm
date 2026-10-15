/**
 * ArchivHinweis — dezenter Hinweis oben auf jeder archivierten Detailseite
 * (Auftrag, Projekt, Entwurf, Kunde, Location): «Archiviert – nur lesen»,
 * dahinter optional der Vermerk («Storniert am … von …») und die Begruendung.
 *
 * Optik wie der fruehere Sperr-Hinweis im Technik-Tab (gedaempfte Flaeche,
 * Schloss): gleiche Bedeutung = gleiche Darstellung app-weit. Logik, ob ein
 * Datensatz archiviert ist, liegt in src/lib/archiv.ts.
 */

import { Lock } from "lucide-react";
import { ARCHIV_TITEL } from "@/lib/archiv";

type Props = {
  /** z. B. «Storniert am 14.10.2026 von Leo Muster» oder «Auftrag abgeschlossen». */
  vermerk?: string | null;
  /** Begruendung (Storno-/Archiv-Grund), wird mit « — Begründung:» angehaengt. */
  begruendung?: string | null;
  className?: string;
};

export function ArchivHinweis({ vermerk, begruendung, className }: Props) {
  const grund = begruendung?.trim();
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-xl border border-border bg-muted/50 dark:bg-muted px-3 py-2 text-sm text-muted-foreground ${className ?? ""}`}
    >
      <Lock className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
      <p className="min-w-0 break-words">
        <span className="font-medium text-foreground">{ARCHIV_TITEL}</span>
        {vermerk && <> · {vermerk}</>}
        {grund && (
          <>
            {" — Begründung: "}
            <span className="whitespace-pre-wrap text-foreground">{grund}</span>
          </>
        )}
      </p>
    </div>
  );
}
