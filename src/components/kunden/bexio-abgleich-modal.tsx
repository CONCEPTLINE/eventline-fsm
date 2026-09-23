"use client";

// Gefuehrter Bexio-Abgleich — Kunde-fuer-Kunde-Flow im Modal.
//
// Wird vom Abgleich-Banner auf der Kunden-Liste geoeffnet. WICHTIG: Der
// Parent remountet die Komponente pro Oeffnen (key), damit jeder Durchlauf
// mit frischem State startet — kein Reset-Effect, kein Flackern beim ersten
// Frame. Die Items kommen vorgerechnet aus POST /api/bexio/contacts/abgleich
// (laedt die Kunden-Liste beim Mount im Hintergrund):
//
//   * kind "unlinked": Kunde ohne Bexio-Verknuepfung.
//       - Mit Treffern: Kandidaten-Karten (Nr., Name, E-Mail) mit "Verknüpfen"
//         pro Karte + "Überspringen". Verknuepfen nutzt denselben Endpoint wie
//         das Einzel-Modal auf der Kunden-Detailseite: /api/bexio/contacts/link.
//         Nach dem Verknuepfen werden die Feld-Diffs des frisch verknuepften
//         Kontakts nachgeladen (abgleich mit { customerId }) — gibt es welche,
//         folgt direkt der Diff-Schritt.
//       - Ohne Treffer: "Kein Treffer in Bexio" + "Überspringen". Es wird NIE
//         automatisch neu angelegt.
//   * kind "diff": verknuepfter Kunde mit Abweichungen. Diff-Tabelle
//         (Feld / EVENTLINE / Bexio) + "Übernehmen" (ersetzt NUR die
//         abweichenden Felder durch die Bexio-Werte, via
//         /api/bexio/contacts/uebernehmen) oder "Behalten".
//
// Am Ende: Zusammenfassung (verknuepft / uebernommen / uebersprungen) und der
// bestehende Kundennummern-Backfill (/api/bexio/contacts/sync-nrs) laeuft
// automatisch mit. onClose(didChange) sagt dem Parent, ob er die Liste und
// den Abgleich-Status neu laden soll.

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Link2, Loader2, RefreshCw, SearchX } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";

// Bexio-Lime — dieselben Werte wie die bexio_nr-Pill in der Kunden-Liste
// und der kasten-bexio-Button, damit "das ist der Bexio-Wert" sofort lesbar ist.
const BEXIO_TEXT = "text-[rgb(132,152,0)] dark:text-[rgb(196,214,0)]";

export interface AbgleichMatch {
  id: number;
  nr: string | null;
  name: string;
  email: string | null;
  city: string | null;
  postcode: string | null;
  url: string;
  /** Wie der Treffer zustande kam — "email" allein kann eine gleiche
   *  Kontaktperson bei einem ANDEREN Kunden sein (Warnung an der Karte). */
  match?: "beide" | "name" | "email" | null;
}

export interface AbgleichDiff {
  field: string;
  label: string;
  fsm: string | null;
  bexio: string;
}

export interface BexioAbgleichItem {
  customerId: string;
  customerName: string;
  bexioNr: string | null;
  kind: "unlinked" | "diff";
  matches: AbgleichMatch[];
  diffs: AbgleichDiff[];
  error: string | null;
}

interface Props {
  open: boolean;
  items: BexioAbgleichItem[];
  /** didChange = true wenn verknuepft/uebernommen/Nummern aktualisiert wurde
   *  -> Parent soll Liste + Abgleich-Status neu laden. */
  onClose: (didChange: boolean) => void;
}

export function BexioAbgleichModal({ open, items, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  // Diffs eines FRISCH verknuepften Kunden (nach dem Link-Schritt
  // nachgeladen). null = kein Zwischenschritt, die Ansicht kommt direkt
  // aus items[idx]. Alles andere ist abgeleitet — kein mode-State noetig.
  const [freshDiffs, setFreshDiffs] = useState<AbgleichDiff[] | null>(null);
  const [linkBusyId, setLinkBusyId] = useState<number | null>(null);
  const [takeBusy, setTakeBusy] = useState(false);
  const [stats, setStats] = useState({ linked: 0, taken: 0, skipped: 0 });
  const [syncState, setSyncState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [syncUpdated, setSyncUpdated] = useState(0);
  const changedRef = useRef(false);

  const isSummary = idx >= items.length;
  const item = isSummary ? undefined : items[idx];
  // Diff-Ansicht: entweder frisch nachgeladene Diffs (nach Verknuepfen)
  // oder die vorgerechneten eines bereits verknuepften Kunden.
  const showDiff = !isSummary && !item?.error && (freshDiffs !== null || item?.kind === "diff");
  const diffs: AbgleichDiff[] = freshDiffs ?? item?.diffs ?? [];
  const actionBusy = linkBusyId !== null || takeBusy;

  // Kundennummern-Backfill (bestehende Route) laeuft automatisch mit, sobald
  // der Flow die Zusammenfassung erreicht — genau einmal pro Durchlauf.
  // Sind gar keine Flow-Items da (nur fehlende Kundennummern), landet der
  // Flow sofort hier und der Backfill erledigt den Rest.
  useEffect(() => {
    if (!open || !isSummary || syncState !== "idle") return;
    setSyncState("running");
    (async () => {
      try {
        const res = await fetch("/api/bexio/contacts/sync-nrs", { method: "POST" });
        const json = await res.json();
        if (json.success) {
          const updated = typeof json.updated === "number" ? json.updated : 0;
          setSyncUpdated(updated);
          if (updated > 0) changedRef.current = true;
          setSyncState("done");
        } else {
          setSyncState("failed");
        }
      } catch {
        setSyncState("failed");
      }
    })();
  }, [open, isSummary, syncState]);

  function advance() {
    setFreshDiffs(null);
    setIdx((i) => i + 1);
  }

  function skip() {
    setStats((s) => ({ ...s, skipped: s.skipped + 1 }));
    advance();
  }

  async function linkCandidate(m: AbgleichMatch) {
    if (!item || actionBusy) return;
    setLinkBusyId(m.id);
    try {
      // Derselbe Server-Weg wie das "Möglicher Treffer in Bexio"-Modal auf
      // der Kunden-Detailseite — keine Duplikat-Logik.
      const res = await fetch("/api/bexio/contacts/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: item.customerId, bexioContactId: m.id, bexioNr: m.nr }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error);
        return;
      }
      changedRef.current = true;
      setStats((s) => ({ ...s, linked: s.linked + 1 }));
      toast.success(`${item.customerName} mit Bexio verknüpft`);
      // Geteilter Bexio-Kontakt (z.B. Verein + Privatperson mit gleicher
      // Kontaktperson) ist erlaubt — aber bewusst machen.
      if (json.hinweis) toast.info(json.hinweis, { duration: 8000 });

      // Frisch verknuepft -> gibt es Abweichungen zum Bexio-Kontakt?
      try {
        const dres = await fetch("/api/bexio/contacts/abgleich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerId: item.customerId }),
        });
        const djson = await dres.json();
        const fresh = djson?.items?.[0] as BexioAbgleichItem | undefined;
        if (djson?.success && fresh && !fresh.error && fresh.diffs.length > 0) {
          setFreshDiffs(fresh.diffs);
          return;
        }
      } catch {
        // Diff-Nachladen ist optional — die Verknuepfung steht bereits.
      }
      advance();
    } catch (e) {
      TOAST.errorOr(e instanceof Error ? e.message : "Netzwerkfehler");
    } finally {
      setLinkBusyId(null);
    }
  }

  async function uebernehmen() {
    if (!item || actionBusy || diffs.length === 0) return;
    setTakeBusy(true);
    try {
      const felder = Object.fromEntries(diffs.map((d) => [d.field, d.bexio]));
      const res = await fetch("/api/bexio/contacts/uebernehmen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: item.customerId, felder }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error);
        return;
      }
      changedRef.current = true;
      setStats((s) => ({ ...s, taken: s.taken + 1 }));
      toast.success(`Daten aus Bexio übernommen — ${item.customerName}`);
      advance();
    } catch (e) {
      TOAST.errorOr(e instanceof Error ? e.message : "Netzwerkfehler");
    } finally {
      setTakeBusy(false);
    }
  }

  const progress = items.length > 0 ? Math.min(idx / items.length, 1) : 1;

  return (
    <Modal
      open={open}
      onClose={() => onClose(changedRef.current)}
      title="Bexio-Abgleich"
      icon={<RefreshCw className={`h-5 w-5 ${BEXIO_TEXT}`} />}
      size="md"
      closable={!actionBusy}
    >
      {!isSummary && item ? (
        <>
          {/* Fortschritt: "Kunde 3 von 12" + duenner Balken */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Kunde {idx + 1} von {items.length}
              </p>
              {item.bexioNr && (
                <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-[rgba(196,214,0,0.15)] dark:bg-[rgba(196,214,0,0.2)] ${BEXIO_TEXT}`}>
                  Nr. {item.bexioNr}
                </span>
              )}
            </div>
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-[rgb(132,152,0)] dark:bg-[rgb(196,214,0)] transition-all"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="font-medium break-words">{item.customerName}</p>
          </div>

          {showDiff ? (
            <>
              <p className="text-sm text-muted-foreground">
                Die Stammdaten weichen von Bexio ab. Daten aus Bexio übernehmen?
                Übernehmen ersetzt nur die abweichenden Felder.
              </p>
              <div className="rounded-xl border overflow-hidden">
                <div className="grid grid-cols-[76px_1fr_1fr] gap-3 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b bg-muted/30">
                  <span>Feld</span>
                  <span>EVENTLINE</span>
                  <span>Bexio</span>
                </div>
                <div className="divide-y max-h-64 overflow-y-auto">
                  {diffs.map((d) => (
                    <div key={d.field} className="grid grid-cols-[76px_1fr_1fr] gap-3 px-3 py-2">
                      <span className="text-xs text-muted-foreground pt-0.5">{d.label}</span>
                      <span className="text-sm text-muted-foreground break-words">{d.fsm ?? "—"}</span>
                      <span className={`text-sm font-medium break-words ${BEXIO_TEXT}`}>{d.bexio}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={skip}
                  disabled={actionBusy}
                  className="kasten kasten-muted flex-1"
                >
                  Behalten
                </button>
                <button
                  type="button"
                  onClick={uebernehmen}
                  disabled={actionBusy}
                  className="kasten kasten-bexio flex-1"
                >
                  {takeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {takeBusy ? "Wird übernommen…" : "Übernehmen"}
                </button>
              </div>
            </>
          ) : item.error ? (
            <>
              <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-sm text-amber-900 dark:text-amber-100 break-words">
                  Abgleich für diesen Kunden fehlgeschlagen: {item.error}
                </p>
              </div>
              <button type="button" onClick={skip} className="kasten kasten-muted w-full">
                Überspringen
              </button>
            </>
          ) : item.matches.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground">
                {item.matches.length === 1
                  ? "In Bexio gibt es einen Kontakt, der zu diesem Kunden passen könnte."
                  : `In Bexio gibt es ${item.matches.length} Kontakte, die zu diesem Kunden passen könnten.`}{" "}
                Verknüpfe den richtigen Eintrag — oder überspringe den Kunden.
              </p>
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {item.matches.map((m) => (
                  <div key={m.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border bg-foreground/[0.02]">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        {m.nr && (
                          <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-foreground/[0.08] text-muted-foreground">
                            Nr. {m.nr}
                          </span>
                        )}
                        <p className="text-sm font-medium break-words">{m.name}</p>
                        {m.match === "beide" && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">
                            Name + E-Mail
                          </span>
                        )}
                      </div>
                      {m.email && <p className="text-xs text-muted-foreground break-all">{m.email}</p>}
                      {(m.postcode || m.city) && (
                        <p className="text-xs text-muted-foreground break-words">
                          {[m.postcode, m.city].filter(Boolean).join(" ")}
                        </p>
                      )}
                      {m.match === "email" && (
                        <p className="text-xs text-amber-700 dark:text-amber-300/90">
                          ⚠ Nur die E-Mail stimmt überein, der Name weicht ab — das kann die gleiche
                          Kontaktperson bei einem <strong>anderen</strong> Kunden sein. Nur verknüpfen,
                          wenn es wirklich derselbe Kunde ist.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => linkCandidate(m)}
                      disabled={actionBusy}
                      className="kasten kasten-bexio shrink-0"
                    >
                      {linkBusyId === m.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Link2 className="h-3.5 w-3.5" />
                      )}
                      {linkBusyId === m.id ? "Verknüpfe…" : "Verknüpfen"}
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={skip} disabled={actionBusy} className="kasten kasten-muted w-full">
                Überspringen
              </button>
            </>
          ) : (
            <>
              <EmptyState
                icon={SearchX}
                title="Kein Treffer in Bexio"
                description={`Für „${item.customerName}" wurde kein passender Kontakt in Bexio gefunden.`}
              />
              <button type="button" onClick={skip} className="kasten kasten-muted w-full">
                Überspringen
              </button>
            </>
          )}
        </>
      ) : (
        <>
          {/* Zusammenfassung */}
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
            <p className="font-medium">Abgleich abgeschlossen</p>
          </div>
          <div className="rounded-xl border divide-y">
            <div className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">Verknüpft</span>
              <span className="font-semibold tabular-nums">{stats.linked}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">Daten übernommen</span>
              <span className="font-semibold tabular-nums">{stats.taken}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">Übersprungen</span>
              <span className="font-semibold tabular-nums">{stats.skipped}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            {syncState === "running" && (
              <>
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                Kundennummern werden aus Bexio nachgezogen…
              </>
            )}
            {syncState === "done" && (
              syncUpdated > 0
                ? `${syncUpdated} ${syncUpdated === 1 ? "Kundennummer" : "Kundennummern"} aus Bexio nachgezogen.`
                : "Alle Kundennummern sind aktuell."
            )}
            {syncState === "failed" && "Kundennummern-Abgleich fehlgeschlagen — später erneut versuchen."}
          </p>
          <button
            type="button"
            onClick={() => onClose(changedRef.current)}
            disabled={syncState === "running"}
            className="kasten kasten-bexio w-full"
          >
            {syncState === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Fertig
          </button>
        </>
      )}
    </Modal>
  );
}
