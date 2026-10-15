"use client";

// Bereich «Doppelte» im Tab «Ablage» (Migration 334, lib/ki/doppel): Gruppen exakt bzw. inhaltlich gleicher Dateien
// über das ganze NAS — gefunden von der lokalen KI im Büro (rig/eventline-ki/dienst/app/duplikate.py), nachts und
// laufend aktualisiert. Je Datei «In Duplikate-Ordner»: verschiebt beim nächsten Sync nach
// 99_System/Duplikate/<Datum>/<Ordner> (nie löschen) — nur auf Klick, nach Rückfrage, nie die letzte Kopie.
// Fassungen (neu/alt) erscheinen hier nicht — die zeigt «Einsortieren» an der jeweiligen ZZ-Datei.

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { Copy, FolderInput, Loader2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { DOPPEL_QUARANTAENE, type DoppelGruppe, type DoppelMitglied } from "@/lib/ki/doppel";
import { datumText, doppelAktion, groesseText, useDoppelDaten, zeitText } from "./doppel-daten";
import { ZzVorschau } from "./zz-vorschau";

const CHIP = "shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium";
const CHIP_EXAKT = `${CHIP} bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100`;
const CHIP_INHALT = `${CHIP} border border-violet-300 text-violet-800 dark:border-violet-400/50 dark:text-violet-200`;

function istExakt(g: DoppelGruppe): boolean {
  return new Set(g.mitglieder.map((m) => m.kopie)).size === 1;
}

export function DoppelteListe({
  supabase,
  takt,
  onAnzahl,
}: {
  supabase: SupabaseClient;
  takt: number;
  onAnzahl?: (n: number | null) => void;
}) {
  const { daten, neuLaden } = useDoppelDaten(takt, (m) => toast.error("Doppelte konnten nicht geladen werden: " + m));
  const { confirm, ConfirmModalElement } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [weg, setWeg] = useState<Set<string>>(new Set());

  const gruppen = useMemo(() => {
    const liste = (daten?.gruppen ?? [])
      .filter((g) => g.art === "gleich")
      .map((g) => ({ ...g, mitglieder: g.mitglieder.filter((m) => !weg.has(m.pfad)) }))
      .filter((g) => g.mitglieder.length >= 2);
    const summe = (g: DoppelGruppe) => g.mitglieder.reduce((n, m) => n + (m.groesse ?? 0), 0);
    return liste.sort((a, b) => Number(istExakt(b)) - Number(istExakt(a)) || summe(b) - summe(a) || a.gruppe.localeCompare(b.gruppe));
  }, [daten, weg]);

  // Anzahl fuer den Umschalter: Gruppen, nicht Dateien.
  const anzahl = daten ? gruppen.length : null;
  useEffect(() => { onAnzahl?.(anzahl); }, [anzahl, onAnzahl]);

  async function entfernen(g: DoppelGruppe, m: DoppelMitglied) {
    const bleibt = g.mitglieder.filter((x) => x.pfad !== m.pfad);
    const ok = await confirm({
      title: "In den Duplikate-Ordner verschieben?",
      message:
        `«${m.name}» wird beim nächsten Sync nach ${DOPPEL_QUARANTAENE}/… verschoben (nicht gelöscht, dort wiederherstellbar).\n\n` +
        `Es bleibt: «${bleibt[0]?.name ?? ""}» in ${bleibt[0]?.ordner || "(Hauptebene)"}` +
        (bleibt.length > 1 ? ` und ${bleibt.length - 1} weitere` : ""),
      confirmLabel: "Verschieben",
    });
    if (!ok) return;
    setBusy(m.pfad);
    const r = await doppelAktion({ aktion: "entfernen", pfad: m.pfad });
    setBusy(null);
    if (!r.ok) {
      toast.error("Verschieben fehlgeschlagen: " + r.meldung);
      return;
    }
    setWeg((w) => new Set(w).add(m.pfad));
    toast.success(`Wird beim nächsten Sync nach «${r.ziel ?? DOPPEL_QUARANTAENE}» verschoben`);
    void neuLaden();
  }

  if (daten === null) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="shimmer rounded-md h-8" />)}
      </div>
    );
  }
  if (gruppen.length === 0) {
    return (
      <EmptyState
        icon={Copy}
        title="Keine Doppelten"
        description="Die lokale KI prüft das ganze NAS laufend auf gleiche Dateien (exakt oder gleicher Inhalt in anderer Form)."
      />
    );
  }
  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="doppelte-liste">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border">
        <p className="text-[11px] text-muted-foreground min-w-0 flex-1">
          {gruppen.length} {gruppen.length === 1 ? "Gruppe" : "Gruppen"} gleicher Dateien
          {daten.stand?.aktualisiert ? ` · Stand ${zeitText(daten.stand.aktualisiert)}` : ""} — verschoben wird nur auf Klick, in den Duplikate-Ordner, nie gelöscht.
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {gruppen.map((g) => {
          const exakt = istExakt(g);
          return (
            <section key={g.gruppe} className="border-b border-border last:border-b-0 py-1" data-testid="doppel-gruppe">
              <div className="flex items-center gap-2 px-3 py-1">
                <span className={exakt ? CHIP_EXAKT : CHIP_INHALT} data-tooltip={exakt ? "Gleiche Bytes — echte Kopien" : "Gleicher Inhalt in anderer Form (z. B. DOCX und PDF) — bitte kurz prüfen"}>
                  {exakt ? "Exakt gleich" : "Gleicher Inhalt"}
                </span>
                <span className="min-w-0 truncate text-[12px] font-medium">{g.mitglieder[0].name}</span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {g.mitglieder.length} Dateien · {groesseText(g.mitglieder.reduce((n, m) => n + (m.groesse ?? 0), 0))}
                </span>
              </div>
              <ul>
                {g.mitglieder.map((m) => (
                  <Mitglied
                    key={m.pfad}
                    supabase={supabase}
                    m={m}
                    zeigeForm={!exakt}
                    letzte={g.mitglieder.length <= 1}
                    laeuft={busy === m.pfad}
                    gesperrt={busy !== null}
                    onEntfernen={() => entfernen(g, m)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {ConfirmModalElement}
    </div>
  );
}

function Mitglied({
  supabase, m, zeigeForm, letzte, laeuft, gesperrt, onEntfernen,
}: {
  supabase: SupabaseClient;
  m: DoppelMitglied;
  zeigeForm: boolean;
  letzte: boolean;
  laeuft: boolean;
  gesperrt: boolean;
  onEntfernen: () => void;
}) {
  const endung = m.name.includes(".") ? m.name.slice(m.name.lastIndexOf(".") + 1).toUpperCase() : "";
  return (
    <li className="row-hover [--row-hover-x:0.25rem] flex items-center gap-2 pl-5 pr-3 py-1" data-testid="doppel-mitglied">
      <ZzVorschau supabase={supabase} pfad={m.pfad} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[12px]" data-tooltip={m.pfad}>{m.name}</span>
          {m.zz && (
            <span className={`${CHIP} bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200`} data-tooltip="Liegt im Rückstau (ZZ-Ordner)">ZZ</span>
          )}
          {zeigeForm && endung && <span className={`${CHIP} bg-muted text-muted-foreground`}>{endung}</span>}
        </p>
        <p className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" data-tooltip={m.ordner}>{m.ordner || "(Hauptebene)"}</p>
      </div>
      <span className="hidden sm:inline shrink-0 text-[10px] tabular-nums text-muted-foreground">{groesseText(m.groesse)}</span>
      <span className="hidden md:inline shrink-0 text-[10px] tabular-nums text-muted-foreground">{datumText(m.geaendert)}</span>
      <button
        type="button"
        onClick={onEntfernen}
        disabled={gesperrt || letzte}
        className="kasten shrink-0 px-2 py-1 text-[11px]"
        aria-label="In Duplikate-Ordner verschieben"
        data-tooltip={letzte ? "Letzte Kopie — bleibt" : `Nach ${DOPPEL_QUARANTAENE}/… verschieben (nicht löschen)`}
        data-testid="doppel-entfernen"
      >
        {laeuft ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderInput className="h-3 w-3" />}
        <span className="hidden lg:inline">Duplikate-Ordner</span>
      </button>
    </li>
  );
}
