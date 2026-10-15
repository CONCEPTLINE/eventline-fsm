"use client";

/**
 * Karte «Zugriffe auf Finanzen & Lohn» — Einstellungen › Sicherheit (Admin).
 * Wer hat wann Finanzzahlen oder Lohndaten angesehen (finanzen.zugriffe).
 *
 * Datenquelle: /api/einstellungen/zugriffe?tage=&bereich= (requireAdmin;
 * Antwort ohne Geraete-Hash und ohne Profil-IDs). details werden NUR mit
 * den Schluesseln aus ZUGRIFF_DETAILS_ANZEIGE gerendert — nie generisch.
 * Filter (Bereich, Zeitraum) ueberleben den Reload via localStorage (§10).
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { TOAST } from "@/lib/messages";
import { formatDateTimeFull } from "@/lib/format";
import {
  ZUGRIFF_AKTION_LABEL,
  ZUGRIFF_DETAILS_ANZEIGE,
  type ZugriffAnzeigeRow,
  type ZugriffeAntwort,
} from "@/lib/finanzen/types";

type BereichFilter = "alle" | "finanzen" | "lohn";
const BEREICHE: readonly BereichFilter[] = ["alle", "finanzen", "lohn"];
const BEREICH_LABEL: Record<BereichFilter, string> = { alle: "Alle", finanzen: "Finanzen", lohn: "Lohn" };
const TAGE: readonly number[] = [7, 30, 90];

const LS_BEREICH = "zugriffe-bereich";
const LS_TAGE = "zugriffe-tage";

/** Anzeige-Namen der Whitelist-Schluessel (Rest: Schluessel selbst). */
const DETAIL_LABEL: Record<string, string> = {
  jahr: "Jahr",
  monat: "Monat",
  doc_type: "Dokument",
  art: "Art",
  von: "von",
  bis: "bis",
  voll: "komplett",
};

function liesBereich(): BereichFilter {
  try {
    const v = localStorage.getItem(LS_BEREICH);
    return BEREICHE.includes(v as BereichFilter) ? (v as BereichFilter) : "alle";
  } catch {
    return "alle";
  }
}

function liesTage(): number {
  try {
    const v = Number(localStorage.getItem(LS_TAGE));
    return TAGE.includes(v) ? v : 30;
  } catch {
    return 30;
  }
}

function detailZeile(details: ZugriffAnzeigeRow["details"]): string | null {
  if (!details || typeof details !== "object") return null;
  const teile: string[] = [];
  for (const k of ZUGRIFF_DETAILS_ANZEIGE) {
    const v = details[k];
    if (v === undefined || v === null || v === "") continue;
    teile.push(`${DETAIL_LABEL[k] ?? k}: ${v === true ? "ja" : v === false ? "nein" : v}`);
  }
  return teile.length ? teile.join(" · ") : null;
}

export function ZugriffeCard(): React.JSX.Element {
  const [bereich, setBereich] = useState<BereichFilter>(() => (typeof window !== "undefined" ? liesBereich() : "alle"));
  const [tage, setTage] = useState<number>(() => (typeof window !== "undefined" ? liesTage() : 30));
  const [eintraege, setEintraege] = useState<ZugriffAnzeigeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(LS_BEREICH, bereich);
      localStorage.setItem(LS_TAGE, String(tage));
    } catch {
      // localStorage kann fehlen (privater Modus) — Filter gelten dann nur fuer die Sitzung.
    }
  }, [bereich, tage]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ tage: String(tage) });
      if (bereich !== "alle") params.set("bereich", bereich);
      const res = await fetch(`/api/einstellungen/zugriffe?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as (ZugriffeAntwort & { error?: string }) | { success: false; error?: string } | null;
      if (!res.ok || !json?.success) {
        TOAST.errorOr(json && "error" in json ? json.error : null);
        setEintraege([]);
        return;
      }
      setEintraege(json.eintraege);
    } catch {
      TOAST.errorOr("Zugriffe konnten nicht geladen werden");
      setEintraege([]);
    } finally {
      setLoading(false);
    }
  }, [bereich, tage]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Eye className="h-4 w-4" />
          Zugriffe auf Finanzen &amp; Lohn
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Wer hat wann Finanzzahlen oder Lohndaten angesehen. Signierte Download-Links zählen als Ausgabe des Links, nicht als Download.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-2">
            {BEREICHE.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setBereich(b)}
                className={bereich === b ? "kasten-active" : "kasten-toggle-off"}
              >
                {BEREICH_LABEL[b]}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground/50 text-xs">·</span>
          <div className="flex flex-wrap gap-2">
            {TAGE.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTage(t)}
                className={tage === t ? "kasten-active" : "kasten-toggle-off"}
              >
                {t} Tage
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lade…</p>
        ) : eintraege.length === 0 ? (
          <EmptyState icon={Eye} title="Keine Zugriffe im Zeitraum" />
        ) : (
          <div className="divide-y divide-border">
            {eintraege.map((e) => {
              const label = ZUGRIFF_AKTION_LABEL[e.aktion] ?? e.aktion;
              const details = detailZeile(e.details);
              return (
                <div key={e.id} className="py-2 flex items-start gap-3 text-xs">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="font-medium">
                      {label}
                      {e.ziel_label && <span className="text-muted-foreground"> · Person: {e.ziel_label}</span>}
                    </p>
                    {details && <p className="text-[11px] text-muted-foreground">{details}</p>}
                  </div>
                  <div className="text-[10px] text-muted-foreground text-right shrink-0">
                    <p>{formatDateTimeFull(e.occurred_at)}</p>
                    <p className="text-muted-foreground/70">von {e.actor_label ?? "Unbekannt"}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
