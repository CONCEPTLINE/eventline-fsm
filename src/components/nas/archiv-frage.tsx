"use client";

// «Frag das Archiv» (docs/lokale-ki/MASTERPLAN.md §3.4 MP-4, Paket E3.3,
// Entscheid E3): zweiter Knopf in der Suchkarte der NAS-Seite fuer den
// eingegebenen Text. Die Frage geht als Auftrag `archiv_frage` ueber die
// Warteschlange an die lokale KI im Buero (POST /api/ki/archiv), der Browser
// fragt alle 1,5 s nach (GET /api/ki/archiv/<id>) und gibt nach 150 s auf.
// Die Route loescht die Antwort beim Lesen — sie ist genau einmal abholbar.
// Angezeigt werden nur Antworttext und Quellen (Name, Ordner, Seite); eine
// Quelle oeffnet per PdfPopup wie im Rest der App (Datei vorher vom NAS
// holen, gleicher Weg wie der Download-Knopf).
//
// Frage und Antwort leben nur im Tab (sessionStorage), damit ein Reload sie
// nicht verliert (§10) — nie in der URL, nie in localStorage. Ohne
// vertrautes Geraet (Route 403) erscheint ein Hinweis statt einer Antwort.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { ChevronRight, Cpu, FileText, Loader2, MessageSquareText, RotateCcw, ShieldAlert, TriangleAlert, X, Eye } from "lucide-react";
import { PdfPopup } from "@/components/pdf-popup";
import type { ArchivQuelleAnzeige } from "@/lib/ki/typen";
import { KI_ARCHIV_FRAGE_MAX as FRAGE_MAX, KI_ARCHIV_FRAGE_MIN as FRAGE_MIN } from "@/lib/ki/konstanten";
import { blobFuerVorschau, holeNasDatei, weckeKi } from "./ki-hilfen";
import { Sekunden } from "./inhalt-treffer";

export interface ArchivStand {
  frage: string;
  /** Start der Frage (ms) fuer Sekunden-Zaehler und 150-s-Grenze. */
  seit: number;
  auftragId?: string;
  status: "sendet" | "wartet" | "liest" | "fertig" | "fehler" | "geraet";
  antwort?: string;
  quellen?: ArchivQuelleAnzeige[];
  fehler?: string;
}

const SPEICHER_KEY = "nas-archiv-frage";
const POLL_MS = 1_500;
const AUFGEBEN_MS = 150_000;

function leseGespeichert(): ArchivStand | null {
  if (typeof window === "undefined") return null;
  try {
    const roh = sessionStorage.getItem(SPEICHER_KEY);
    if (!roh) return null;
    const s = JSON.parse(roh) as ArchivStand;
    if (!s || typeof s.frage !== "string" || typeof s.seit !== "number") return null;
    // Reload waehrend des Absendens: ob der Auftrag angekommen ist, weiss
    // niemand — ehrlich melden statt ewig warten.
    if (s.status === "sendet" || ((s.status === "wartet" || s.status === "liest") && !s.auftragId)) {
      return { ...s, status: "fehler", fehler: "Unterbrochen — bitte nochmals fragen" };
    }
    return s;
  } catch {
    return null;
  }
}

/** Zustand + Aktionen fuer «Frag das Archiv»; Knopf und Antwortfeld teilen ihn. */
export function useArchivFrage() {
  const [stand, setStand] = useState<ArchivStand | null>(leseGespeichert);

  useEffect(() => {
    try {
      if (stand) sessionStorage.setItem(SPEICHER_KEY, JSON.stringify(stand));
      else sessionStorage.removeItem(SPEICHER_KEY);
    } catch { /* privater Modus — dann eben ohne Reload-Schutz */ }
  }, [stand]);

  const laeuft = stand?.status === "sendet" || stand?.status === "wartet" || stand?.status === "liest";
  const auftragId = laeuft ? stand?.auftragId : undefined;
  const seit = stand?.seit;

  // Antwort abholen: alle 1,5 s, hoechstens bis 150 s nach dem Start.
  useEffect(() => {
    if (!auftragId || seit === undefined) return;
    let lebt = true;
    let unterwegs = false;
    const ctrl = new AbortController();
    const setzeFalls = (f: (s: ArchivStand) => ArchivStand) =>
      setStand((s) => (s && s.auftragId === auftragId ? f(s) : s));
    const abfragen = async () => {
      if (unterwegs || !lebt) return;
      if (Date.now() - seit > AUFGEBEN_MS) {
        toast.error("«Frag das Archiv» dauert zu lange — bitte später nochmals fragen");
        setzeFalls((s) => ({ ...s, status: "fehler", fehler: "Dauert zu lange — die lokale KI ist gerade ausgelastet" }));
        return;
      }
      unterwegs = true;
      try {
        const res = await fetch(`/api/ki/archiv/${auftragId}`, { cache: "no-store", signal: ctrl.signal });
        const json = await res.json().catch(() => null);
        if (!lebt) return;
        if (res.status === 403) {
          setzeFalls((s) => ({ ...s, status: "geraet" }));
          return;
        }
        if (res.status === 404) {
          toast.error("Antwort nicht mehr verfügbar — bitte nochmals fragen");
          setzeFalls((s) => ({ ...s, status: "fehler", fehler: "Antwort nicht mehr verfügbar (schon gelesen oder abgelaufen)" }));
          return;
        }
        if (!res.ok || !json?.success) return; // voruebergehend — naechster Takt
        if (json.status === "offen") setzeFalls((s) => (s.status === "wartet" ? s : { ...s, status: "wartet" }));
        else if (json.status === "laeuft") setzeFalls((s) => (s.status === "liest" ? s : { ...s, status: "liest" }));
        else if (json.status === "fertig") {
          const quellen = Array.isArray(json.quellen)
            ? (json.quellen as ArchivQuelleAnzeige[]).filter((q) => q && typeof q.pfad === "string" && typeof q.name === "string")
            : [];
          setzeFalls((s) => ({ ...s, status: "fertig", antwort: String(json.antwort ?? ""), quellen, auftragId: undefined }));
        } else if (json.status === "fehler") {
          const fehler = String(json.fehler ?? "Die lokale KI konnte die Frage nicht beantworten");
          toast.error(fehler);
          setzeFalls((s) => ({ ...s, status: "fehler", fehler, auftragId: undefined }));
        }
      } catch {
        // Netz kurz weg — naechster Takt versucht es wieder.
      } finally {
        unterwegs = false;
      }
    };
    void abfragen();
    const t = setInterval(abfragen, POLL_MS);
    return () => { lebt = false; clearInterval(t); ctrl.abort(); };
  }, [auftragId, seit]);

  const fragen = useCallback(async (text: string) => {
    const frage = text.trim().replace(/\s+/g, " ");
    if (frage.length < FRAGE_MIN || frage.length > FRAGE_MAX) {
      toast.error(`Frage mit ${FRAGE_MIN} bis ${FRAGE_MAX} Zeichen stellen`);
      return;
    }
    weckeKi();
    const start = Date.now();
    setStand({ frage, seit: start, status: "sendet" });
    const nurWennAktuell = (f: (s: ArchivStand) => ArchivStand) =>
      setStand((s) => (s && s.seit === start ? f(s) : s));
    try {
      const res = await fetch("/api/ki/archiv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frage }),
      });
      const json = await res.json().catch(() => null);
      if (res.status === 403) {
        nurWennAktuell((s) => ({ ...s, status: "geraet" }));
        return;
      }
      if (res.ok && json?.success && typeof json.auftrag_id === "string") {
        nurWennAktuell((s) => ({ ...s, status: "wartet", auftragId: json.auftrag_id }));
        return;
      }
      const fehler = String(json?.error ?? `Frage konnte nicht gestellt werden (HTTP ${res.status})`);
      toast.error(fehler);
      nurWennAktuell((s) => ({ ...s, status: "fehler", fehler }));
    } catch {
      toast.error("Frage konnte nicht gestellt werden — Netzwerkfehler");
      nurWennAktuell((s) => ({ ...s, status: "fehler", fehler: "Netzwerkfehler" }));
    }
  }, []);

  const schliessen = useCallback(() => setStand(null), []);

  return { stand, laeuft, fragen, schliessen };
}

export type ArchivFrage = ReturnType<typeof useArchivFrage>;

/** Zweiter Knopf neben dem Suchfeld: fragt mit dem eingegebenen Text. */
export function ArchivFrageKnopf({ archiv, text }: { archiv: ArchivFrage; text: string }) {
  const zuKurz = text.trim().length < FRAGE_MIN;
  return (
    <button
      type="button"
      onClick={() => archiv.fragen(text)}
      disabled={archiv.laeuft || zuKurz}
      className="kasten shrink-0 whitespace-nowrap"
      // Tooltip oberhalb (Standard der TooltipLayer): unterhalb laege er
      // ueber dem rechten Rand von Antwort- bzw. Hinweisfeld.
      data-tooltip="Die lokale KI im Büro beantwortet die Frage aus den Dokumenten auf dem NAS — kein Cloud-Dienst"
    >
      {archiv.laeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquareText className="h-3.5 w-3.5" />}
      {archiv.laeuft ? "Fragt…" : "Frag das Archiv"}
    </button>
  );
}

/** Antwortfeld ueber den Treffern. Rendert nichts ohne Frage. */
export function ArchivAntwort({ archiv, supabase }: { archiv: ArchivFrage; supabase: SupabaseClient }) {
  const { stand } = archiv;
  const [oeffnet, setOeffnet] = useState<string | null>(null);
  /** Vorschau: eigene Blob-URL (nicht die signierte URL — der Sync legt
   *  Abrufe als octet-stream ab, das iframe wuerde herunterladen statt
   *  zeigen). Wird beim Schliessen, beim Wechsel und beim Verlassen der
   *  Seite freigegeben. */
  const [popup, setPopup] = useState<{ url: string; title: string } | null>(null);
  const popupUrlRef = useRef<string | null>(null);
  const zeige = useCallback((neu: { url: string; title: string } | null) => {
    if (popupUrlRef.current) URL.revokeObjectURL(popupUrlRef.current);
    popupUrlRef.current = neu?.url ?? null;
    setPopup(neu);
  }, []);
  useEffect(() => () => { if (popupUrlRef.current) URL.revokeObjectURL(popupUrlRef.current); }, []);
  const schliessePopup = useCallback(() => zeige(null), [zeige]);

  async function quelleOeffnen(q: ArchivQuelleAnzeige) {
    if (oeffnet) return;
    setOeffnet(q.pfad);
    try {
      const { blob, name } = await holeNasDatei(supabase, q.pfad, {
        onGestartet: () => toast.info("Wird vom NAS geholt — kann bis zu einer Minute dauern…"),
      });
      zeige({ url: URL.createObjectURL(blobFuerVorschau(blob, name)), title: name });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Datei konnte nicht geöffnet werden");
    } finally {
      setOeffnet(null);
    }
  }

  if (!stand) return popup ? <PdfPopup url={popup.url} title={popup.title} onClose={schliessePopup} /> : null;
  const laeuft = stand.status === "sendet" || stand.status === "wartet" || stand.status === "liest";

  return (
    <>
      <div
        className="mb-3 rounded-lg border border-border bg-muted/40 dark:bg-muted/60 px-3 py-2.5 space-y-2"
        role="region"
        aria-label="Frag das Archiv"
        data-testid="archiv-antwort"
      >
        <div className="flex items-start gap-2">
          <MessageSquareText className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold flex items-center gap-1.5 flex-wrap">
              Frag das Archiv
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
                data-tooltip="Beantwortet von der lokalen KI im Büro — kein Cloud-Dienst"
              >
                <Cpu className="h-3 w-3" /> lokale KI
              </span>
            </p>
            <p className="text-[11px] text-muted-foreground break-words">«{stand.frage}»</p>
          </div>
          <button type="button" onClick={archiv.schliessen} className="icon-btn shrink-0" aria-label="Schliessen" data-tooltip="Schliessen">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {laeuft && (
          <p className="text-xs flex items-center gap-2 text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            {stand.status === "liest" ? "Lokale KI liest im Archiv…" : stand.status === "sendet" ? "Frage wird übergeben…" : "Wartet auf die lokale KI…"}
            <Sekunden seit={stand.seit} />
          </p>
        )}

        {stand.status === "geraet" && (
          <p className="text-xs flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              «Frag das Archiv» geht nur auf einem vertrauten Gerät (wie HR und Löhne). Dieses Gerät ist nicht freigeschaltet —
              vertraute Geräte verwaltet ein Admin unter Einstellungen › Integrationen.
            </span>
          </p>
        )}

        {stand.status === "fehler" && (
          <p className="text-xs flex items-center gap-2 flex-wrap text-amber-700 dark:text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {stand.fehler ?? "Die lokale KI konnte die Frage nicht beantworten"}
            <button
              type="button"
              onClick={() => archiv.fragen(stand.frage)}
              className="inline-flex items-center gap-1 text-muted-foreground underline underline-offset-2"
            >
              <RotateCcw className="h-3 w-3" /> Nochmals fragen
            </button>
          </p>
        )}

        {stand.status === "fertig" && (
          <>
            <p className="text-sm whitespace-pre-line break-words">{stand.antwort}</p>
            {(stand.quellen?.length ?? 0) > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-muted-foreground mb-0.5">Quellen ({stand.quellen!.length})</p>
                <ul>
                  {stand.quellen!.map((q) => (
                    <li key={`${q.pfad}#${q.seite ?? ""}`}>
                      <button
                        type="button"
                        onClick={() => quelleOeffnen(q)}
                        disabled={oeffnet !== null}
                        className="row-hover w-full py-1.5 flex items-start gap-2 text-left disabled:cursor-wait"
                        data-tooltip="Dokument in der Vorschau öffnen"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{q.name}</span>
                          <span className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
                            <span className="font-mono break-all">{q.ordner || "(Hauptebene)"}</span>
                            {q.seite !== null && (
                              <>
                                <ChevronRight className="h-3 w-3" />
                                Seite {q.seite}
                              </>
                            )}
                          </span>
                        </span>
                        {oeffnet === q.pfad
                          ? <Loader2 className="h-4 w-4 animate-spin shrink-0 mt-0.5 text-muted-foreground" />
                          : <Eye className="h-4 w-4 shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              Antwort der lokalen KI aus den gefundenen Stellen — wichtige Angaben in der Quelle prüfen.
            </p>
          </>
        )}
      </div>
      {popup && <PdfPopup url={popup.url} title={popup.title} onClose={schliessePopup} />}
    </>
  );
}
