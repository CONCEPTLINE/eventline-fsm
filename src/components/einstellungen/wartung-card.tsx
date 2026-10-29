"use client";

/**
 * Karte «Wartung (Umbauten)» — Einstellungen › Sicherheit, nur Admins.
 * Je Bereich ein Schalter (mit Bestätigung). Ein Bereich in Wartung zeigt allen
 * ausser den Ausnahmen statt der Seite einen Hinweis mit Mischas Kontakt; seine
 * Schnittstellen antworten mit 503 (Regeln: src/lib/wartung.ts).
 *
 * Schalten nur auf einem vertrauten Gerät (der Server prüft: /api/wartung).
 * Ausnahmen und Grund setzt das Skript: node scripts/wartung.mjs.
 * Nach dem Schalten router.refresh(), damit die Layouts den neuen Stand zeigen.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/use-confirm";
import { formatDateTimeFull } from "@/lib/format";
import { WARTUNG_BEREICHE, WARTUNG_BEREICH_INFO, type WartungBereich } from "@/lib/wartung";

interface Daten {
  stand: {
    bereiche: WartungBereich[];
    grund: string | null;
    seit: string | null;
    ausnahmen: { id: string; name: string }[];
  };
  darf_schalten: boolean;
  hinderungsgrund: string | null;
}

export function WartungCard() {
  const router = useRouter();
  const [daten, setDaten] = useState<Daten | null | undefined>(undefined);
  const [laeuft, setLaeuft] = useState<WartungBereich | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  const laden = useCallback(async () => {
    try {
      const res = await fetch("/api/wartung", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(`Wartung: ${(json?.error as string | undefined) ?? `HTTP ${res.status}`}`);
        setDaten(null);
        return;
      }
      setDaten(json as Daten);
    } catch (e) {
      toast.error(`Wartung: ${e instanceof Error ? e.message : String(e)}`);
      setDaten(null);
    }
  }, []);

  // Laden per queueMicrotask (react-hooks/set-state-in-effect: kein setState im Effekt-Durchlauf).
  useEffect(() => {
    queueMicrotask(() => void laden());
  }, [laden]);

  async function schalten(bereich: WartungBereich, aktiv: boolean) {
    const info = WARTUNG_BEREICH_INFO[bereich];
    const ok = await confirm(
      aktiv
        ? {
            title: `Wartung «${info.label}» einschalten?`,
            message:
              `Betrifft: ${info.umfang}. Alle ausser den Ausnahmen sehen dort nur noch den Hinweis mit Mischas Kontakt; ` +
              `die Schnittstellen antworten mit 503.${bereich === "lohn" ? " Der automatische Lohnlauf pausiert." : ""}`,
            confirmLabel: "Einschalten",
            variant: "red",
          }
        : {
            title: `Wartung «${info.label}» ausschalten?`,
            message: "Danach funktioniert der Bereich für alle wieder normal.",
            confirmLabel: "Ausschalten",
            variant: "blue",
          },
    );
    if (!ok) return;
    setLaeuft(bereich);
    try {
      const res = await fetch("/api/wartung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bereich, aktiv }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error((json?.message as string | undefined) ?? (json?.error as string | undefined) ?? `HTTP ${res.status}`);
      }
      setDaten(json as Daten);
      toast.success(`Wartung «${info.label}» ${aktiv ? "eingeschaltet" : "ausgeschaltet"}`);
      router.refresh();
    } catch (e) {
      toast.error(`Wartung schalten fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaeuft(null);
    }
  }

  const stand = daten?.stand;
  const darf = daten?.darf_schalten === true;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          Wartung (Umbauten)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Ein Bereich in Wartung zeigt allen ausser den Ausnahmen statt der Seite einen Hinweis mit Mischas Kontakt;
          seine Schnittstellen antworten mit 503. Ausnahmen arbeiten normal und sehen den Balken «Wartung aktiv».
        </p>

        {daten === undefined ? (
          <div className="space-y-2">
            {WARTUNG_BEREICHE.map((b) => (
              <div key={b} className="shimmer rounded-md h-9" />
            ))}
          </div>
        ) : daten === null ? (
          <p className="text-xs text-red-600 dark:text-red-400">Stand konnte nicht geladen werden.</p>
        ) : (
          <>
            <div className="divide-y divide-border">
              {WARTUNG_BEREICHE.map((b) => {
                const an = stand!.bereiche.includes(b);
                return (
                  <div key={b} className="py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium flex items-center gap-2">
                        {WARTUNG_BEREICH_INFO[b].label}
                        {an && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                            in Wartung
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{WARTUNG_BEREICH_INFO[b].umfang}</p>
                    </div>
                    <Schalter
                      an={an}
                      laeuft={laeuft === b}
                      gesperrt={!darf || (laeuft !== null && laeuft !== b)}
                      tooltip={darf ? undefined : daten.hinderungsgrund ?? undefined}
                      label={`Wartung ${WARTUNG_BEREICH_INFO[b].label}`}
                      onClick={() => void schalten(b, !an)}
                    />
                  </div>
                );
              })}
            </div>

            <div className="text-xs text-muted-foreground space-y-0.5">
              {stand!.bereiche.length > 0 && stand!.seit && (
                <p>
                  In Wartung seit {formatDateTimeFull(stand!.seit)}
                  {stand!.grund ? ` · Grund: ${stand!.grund}` : ""}
                </p>
              )}
              <p>
                Ausnahmen:{" "}
                {stand!.ausnahmen.length > 0 ? stand!.ausnahmen.map((a) => a.name).join(", ") : "keine"}
              </p>
              {!darf && daten.hinderungsgrund && (
                <p className="text-amber-700 dark:text-amber-300">{daten.hinderungsgrund}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
      {ConfirmModalElement}
    </Card>
  );
}

function Schalter({
  an,
  laeuft,
  gesperrt,
  tooltip,
  label,
  onClick,
}: {
  an: boolean;
  laeuft: boolean;
  gesperrt: boolean;
  tooltip?: string;
  label: string;
  onClick: () => void;
}) {
  const aus = gesperrt || laeuft;
  return (
    <button
      type="button"
      onClick={aus ? undefined : onClick}
      role="switch"
      aria-checked={an}
      aria-label={label}
      disabled={aus}
      data-tooltip={tooltip}
      className={`inline-flex items-center justify-center gap-2 max-md:min-h-[34px] max-md:min-w-[34px] ${
        laeuft ? "cursor-wait" : gesperrt ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      {laeuft && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      <span
        className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          an ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${an ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}
