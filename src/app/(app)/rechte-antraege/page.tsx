"use client";

/**
 * Rechte-Anträge (/rechte-antraege[?id=…]) — Vier Augen bei Rechten,
 * Lohn-Umbau Phase 1 (Migration 361).
 *
 * Admin-Rolle, Lohnrecht (an Personen oder Rollen) und die Vertretung ändert
 * kein Admin allein: die Änderung wartet hier, bis der ANDERE Admin sie auf
 * einem vertrauten Gerät bestätigt (24 h). Wer darf, entscheidet der Server
 * (/api/admin/rechte-antraege → darf_bestaetigen / hinderungsgrund).
 * Ablehnen bzw. den eigenen Antrag zurückziehen darf jeder Admin.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock, Info, Loader2, ShieldCheck, Wallet, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { usePrompt } from "@/components/ui/use-prompt";
import { formatDateFull, formatDateTimeFull } from "@/lib/format";
import Loading from "./loading";

interface Antrag {
  id: string;
  art: "person" | "rolle_rechte" | "vertretung";
  beschreibung: string;
  gewaehrt: boolean;
  status: "offen" | "bestaetigt" | "abgelehnt";
  beantragt_von_name: string | null;
  beantragt_at: string;
  gueltig_bis: string;
  entschieden_von_name: string | null;
  entschieden_at: string | null;
  notweg_grund: string | null;
  abgelaufen: boolean;
  darf_bestaetigen: boolean;
  hinderungsgrund: string | null;
  eigener: boolean;
}

/** Lohndaten-Antrag (Phase 2, Migration 364): Änderung an Lohnzeile,
 *  Firmensätzen oder Anstellung nach der Monatssperre. */
interface LohnAntrag {
  id: string;
  bereich: "lohnzeile" | "firmensaetze" | "anstellung";
  ziel_name: string | null;
  beschreibung: string;
  begruendung: string;
  betrifft_ab: string | null;
  status: "offen" | "bestaetigt" | "abgelehnt";
  beantragt_von_name: string | null;
  beantragt_at: string;
  gueltig_bis: string;
  entschieden_von_name: string | null;
  entschieden_at: string | null;
  ablehnung_grund: string | null;
  darf_bestaetigen: boolean;
  hinderungsgrund: string | null;
  eigener: boolean;
  /** Clientseitig beim Laden gesetzt (offen + gueltig_bis vorbei). */
  abgelaufen: boolean;
}

type Aktion = "bestaetigen" | "ablehnen";

const ART_LABEL: Record<Antrag["art"], string> = {
  person: "Person",
  rolle_rechte: "Rolle",
  vertretung: "Vertretung",
};

const BEREICH_LABEL: Record<LohnAntrag["bereich"], string> = {
  lohnzeile: "Lohnzeile",
  firmensaetze: "Firmensätze",
  anstellung: "Anstellung",
};

export default function RechteAntraegePage() {
  const markiert = useSearchParams().get("id");
  const [offen, setOffen] = useState<Antrag[] | null>(null);
  const [entschieden, setEntschieden] = useState<Antrag[]>([]);
  const [laeuft, setLaeuft] = useState<{ id: string; aktion: Aktion } | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();
  const { prompt, PromptModalElement } = usePrompt();
  // Lohndaten-Anträge: undefined = lädt, null = kein Zugriff (403 → Abschnitt still weglassen).
  const [lohn, setLohn] = useState<{ offen: LohnAntrag[]; entschieden: LohnAntrag[] } | null | undefined>(undefined);
  const [lohnVersion, setLohnVersion] = useState(0);
  const [lohnLaeuft, setLohnLaeuft] = useState<{ id: string; aktion: Aktion } | null>(null);

  useEffect(() => {
    let aktiv = true;
    fetch("/api/hr/lohn-antraege", { cache: "no-store" })
      .then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, ok: r.ok, j })))
      .then(({ status, ok, j }) => {
        if (!aktiv) return;
        // Kein Lohnrecht / kein vertrautes Gerät: Abschnitt still weglassen.
        if (status === 403) { setLohn(null); return; }
        if (!ok || !j?.success) {
          toast.error((j?.error as string | undefined) ?? "Lohndaten-Anträge konnten nicht geladen werden.");
          setLohn(null);
          return;
        }
        const jetzt = Date.now();
        const mit = (l: Omit<LohnAntrag, "abgelaufen">[]): LohnAntrag[] =>
          l.map((a) => ({ ...a, abgelaufen: a.status === "offen" && Date.parse(a.gueltig_bis) <= jetzt }));
        setLohn({ offen: mit(j.offen ?? []), entschieden: mit(j.entschieden ?? []) });
      })
      .catch((e) => {
        if (!aktiv) return;
        toast.error(`Lohndaten-Anträge konnten nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
        setLohn(null);
      });
    return () => { aktiv = false; };
  }, [lohnVersion]);

  async function entscheidenLohn(a: LohnAntrag, aktion: Aktion) {
    let grund: string | null = null;
    if (aktion === "bestaetigen") {
      const ok = await confirm({
        title: "Antrag bestätigen?",
        message: `${a.beschreibung}.\nBegründung: ${a.begruendung}\n\nDie Änderung gilt sofort. Danach rechnet das System die betroffenen Monate neu und schlägt Korrekturfassungen vor (Lohn › Lohndokumente).`,
        confirmLabel: "Bestätigen",
        variant: "blue",
      });
      if (!ok) return;
    } else if (a.eigener) {
      const ok = await confirm({
        title: "Eigenen Antrag zurückziehen?",
        message: `${a.beschreibung}. Es ändert sich nichts; für einen neuen Versuch braucht es einen neuen Antrag.`,
        confirmLabel: "Zurückziehen",
        variant: "red",
      });
      if (!ok) return;
    } else {
      grund = await prompt({
        title: "Antrag ablehnen?",
        label: "Grund der Ablehnung",
        placeholder: "z. B. Betrag stimmt nicht mit dem Vertrag überein",
        confirmLabel: "Ablehnen",
        variant: "red",
        maxLength: 500,
      });
      if (grund === null) return;
    }
    setLohnLaeuft({ id: a.id, aktion });
    try {
      const res = await fetch("/api/hr/lohn-antraege", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, aktion, ...(grund ? { grund } : {}) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Entscheid fehlgeschlagen.");
      } else if (aktion === "bestaetigen") {
        const n = Number(json.vorschlaege ?? 0);
        toast.success(`Bestätigt — ${n} Korrektur-Vorschl${n === 1 ? "ag" : "äge"} (Lohn › Lohndokumente)`);
        const fehler = Array.isArray(json.fehler) ? (json.fehler as string[]) : [];
        if (fehler.length > 0) {
          toast.warning(`${fehler.length} Monat${fehler.length === 1 ? "" : "e"} nicht nachgerechnet`, {
            description: fehler.slice(0, 5).join("\n") + (fehler.length > 5 ? "\n…" : ""),
          });
        }
      } else {
        toast.success(a.eigener ? "Zurückgezogen" : "Abgelehnt");
      }
      setLohnVersion((v) => v + 1);
    } catch (e) {
      toast.error(`Entscheid fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLohnLaeuft(null);
    }
  }

  const laden = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/rechte-antraege", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Anträge konnten nicht geladen werden.");
        setOffen([]);
        return;
      }
      setOffen(json.offen as Antrag[]);
      setEntschieden(json.entschieden as Antrag[]);
    } catch (e) {
      toast.error(`Anträge konnten nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
      setOffen([]);
    }
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  async function entscheiden(a: Antrag, aktion: Aktion) {
    const ok = await confirm({
      title: aktion === "bestaetigen" ? "Antrag bestätigen?" : a.eigener ? "Eigenen Antrag zurückziehen?" : "Antrag ablehnen?",
      message: aktion === "bestaetigen"
        ? `${a.beschreibung}. Die Änderung gilt sofort und wird im Rechte-Protokoll festgehalten.`
        : `${a.beschreibung}. Es ändert sich nichts; für einen neuen Versuch braucht es einen neuen Antrag.`,
      confirmLabel: aktion === "bestaetigen" ? "Bestätigen" : a.eigener ? "Zurückziehen" : "Ablehnen",
      variant: aktion === "bestaetigen" ? "blue" : "red",
    });
    if (!ok) return;
    setLaeuft({ id: a.id, aktion });
    try {
      const res = await fetch("/api/admin/rechte-antraege", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, aktion }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Entscheid fehlgeschlagen.");
      } else {
        toast.success(aktion === "bestaetigen" ? "Bestätigt — Änderung gilt" : "Abgelehnt");
        if (json.warnung) toast.error(json.warnung as string);
      }
      await laden();
    } catch (e) {
      toast.error(`Entscheid fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaeuft(null);
    }
  }

  if (offen === null) return <Loading />;

  return (
    <div className="space-y-6 max-w-3xl page-enter">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Rechte-Anträge</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Admin-Rolle, Lohnrecht und Vertretung ändern sich erst, wenn der andere Admin bestätigt.
        </p>
      </div>

      <section className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Offen</p>
        {offen.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="Keine offenen Anträge" />
        ) : (
          offen.map((a) => (
            <Card key={a.id} className={a.id === markiert ? "ring-2 ring-red-500/60" : undefined}>
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{a.beschreibung}</p>
                    <p className="text-xs text-muted-foreground">
                      {ART_LABEL[a.art]} · {a.gewaehrt ? "gewährt Zugang" : "entzieht Zugang"} · beantragt von {a.beantragt_von_name ?? "?"} am{" "}
                      {formatDateTimeFull(a.beantragt_at)} · gültig bis {formatDateTimeFull(a.gueltig_bis)}
                    </p>
                  </div>
                  <StatusBadge a={a} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {a.darf_bestaetigen && (
                    <button type="button" onClick={() => entscheiden(a, "bestaetigen")} disabled={laeuft !== null} className="kasten kasten-green">
                      {laeuft?.id === a.id && laeuft.aktion === "bestaetigen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      {laeuft?.id === a.id && laeuft.aktion === "bestaetigen" ? "Wird bestätigt …" : "Bestätigen"}
                    </button>
                  )}
                  {!a.abgelaufen && (
                    <button type="button" onClick={() => entscheiden(a, "ablehnen")} disabled={laeuft !== null} className="kasten kasten-red">
                      {laeuft?.id === a.id && laeuft.aktion === "ablehnen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                      {a.eigener ? "Zurückziehen" : "Ablehnen"}
                    </button>
                  )}
                  {!a.darf_bestaetigen && a.hinderungsgrund && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Info className="h-3.5 w-3.5 shrink-0" />
                      {a.hinderungsgrund}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {entschieden.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zuletzt entschieden</p>
          <Card>
            <CardContent className="p-0 divide-y">
              {entschieden.map((a) => (
                <div key={a.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="min-w-0">
                    <span className="font-medium text-sm">{a.beschreibung}</span>
                    <span className="block text-muted-foreground">
                      beantragt von {a.beantragt_von_name ?? "?"} · {a.status === "bestaetigt" ? "bestätigt" : "abgelehnt"} von {a.entschieden_von_name ?? "?"}
                      {a.entschieden_at ? ` am ${formatDateTimeFull(a.entschieden_at)}` : ""}
                      {a.notweg_grund ? ` · Notweg: ${a.notweg_grund}` : ""}
                    </span>
                  </span>
                  <StatusBadge a={a} />
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Bestätigen kann nur der andere Admin — nicht wer den Antrag gestellt hat und nie für die eigenen Rechte —, auf
        einem vertrauten Gerät, innerhalb von 24 Stunden. Jede Entscheidung steht im Rechte-Protokoll. Notweg ohne zweiten
        Admin: über Mischa.
      </p>

      {/* Lohndaten (Phase 2): Lohnzeilen, Firmensätze, Anstellungen nach der Monatssperre */}
      {lohn === undefined ? (
        <div className="shimmer rounded-md h-20" />
      ) : lohn && (
        <div className="space-y-4 pt-4 border-t border-border">
          <div>
            <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              <Wallet className="h-4 w-4" /> Lohndaten
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Änderungen an Lohnzeilen, Firmensätzen und Anstellungen, die abgerechnete Monate betreffen, gelten erst, wenn eine
              zweite Person (anderer Admin oder Vertretung) innert 24 h bestätigt. Danach schlägt das System Korrekturfassungen vor.
            </p>
          </div>

          <section className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Offen</p>
            {lohn.offen.length === 0 ? (
              <EmptyState icon={Wallet} title="Keine offenen Lohndaten-Anträge" />
            ) : (
              lohn.offen.map((a) => (
                <Card key={a.id} className={a.id === markiert ? "ring-2 ring-red-500/60" : undefined}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{a.beschreibung}</p>
                        <p className="text-xs text-muted-foreground">
                          {BEREICH_LABEL[a.bereich] ?? a.bereich}
                          {a.ziel_name ? ` · ${a.ziel_name}` : ""}
                          {a.betrifft_ab ? ` · betrifft ab ${formatDateFull(a.betrifft_ab)}` : ""} · beantragt von{" "}
                          {a.beantragt_von_name ?? "?"} am {formatDateTimeFull(a.beantragt_at)} · gültig bis {formatDateTimeFull(a.gueltig_bis)}
                        </p>
                        <p className="text-xs mt-1">
                          <span className="text-muted-foreground">Begründung:</span> {a.begruendung}
                        </p>
                      </div>
                      <StatusBadge a={a} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {a.darf_bestaetigen && (
                        <button type="button" onClick={() => void entscheidenLohn(a, "bestaetigen")} disabled={lohnLaeuft !== null} className="kasten kasten-green">
                          {lohnLaeuft?.id === a.id && lohnLaeuft.aktion === "bestaetigen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                          {lohnLaeuft?.id === a.id && lohnLaeuft.aktion === "bestaetigen" ? "Wird bestätigt …" : "Bestätigen"}
                        </button>
                      )}
                      {!a.abgelaufen && (
                        <button type="button" onClick={() => void entscheidenLohn(a, "ablehnen")} disabled={lohnLaeuft !== null} className="kasten kasten-red">
                          {lohnLaeuft?.id === a.id && lohnLaeuft.aktion === "ablehnen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                          {a.eigener ? "Zurückziehen" : "Ablehnen"}
                        </button>
                      )}
                      {!a.darf_bestaetigen && a.hinderungsgrund && (
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Info className="h-3.5 w-3.5 shrink-0" />
                          {a.hinderungsgrund}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </section>

          {lohn.entschieden.length > 0 && (
            <section className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zuletzt entschieden</p>
              <Card>
                <CardContent className="p-0 divide-y">
                  {lohn.entschieden.map((a) => (
                    <div key={a.id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="min-w-0">
                        <span className="font-medium text-sm">{a.beschreibung}</span>
                        <span className="block text-muted-foreground">
                          {BEREICH_LABEL[a.bereich] ?? a.bereich} · beantragt von {a.beantragt_von_name ?? "?"} ·{" "}
                          {a.status === "bestaetigt" ? "bestätigt" : "abgelehnt"} von {a.entschieden_von_name ?? "?"}
                          {a.entschieden_at ? ` am ${formatDateTimeFull(a.entschieden_at)}` : ""}
                          {a.ablehnung_grund ? ` · Grund: ${a.ablehnung_grund}` : ""}
                        </span>
                      </span>
                      <StatusBadge a={a} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </section>
          )}
        </div>
      )}
      {ConfirmModalElement}
      {PromptModalElement}
    </div>
  );
}

function StatusBadge({ a }: { a: { status: Antrag["status"]; abgelaufen: boolean } }) {
  const basis = "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full shrink-0";
  if (a.status === "bestaetigt") {
    return <span className={`${basis} bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300`}><CheckCircle2 className="h-3.5 w-3.5" />Bestätigt</span>;
  }
  if (a.status === "abgelehnt") {
    return <span className={`${basis} bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300`}><XCircle className="h-3.5 w-3.5" />Abgelehnt</span>;
  }
  if (a.abgelaufen) {
    return <span className={`${basis} bg-muted text-muted-foreground dark:bg-foreground/15`}><Clock className="h-3.5 w-3.5" />Abgelaufen</span>;
  }
  return <span className={`${basis} bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300`}><Clock className="h-3.5 w-3.5" />Wartet auf Bestätigung</span>;
}
