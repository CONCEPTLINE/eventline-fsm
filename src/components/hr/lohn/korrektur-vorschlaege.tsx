"use client";

/**
 * Korrektur-Vorschläge (Lohn-Umbau Phase 2) — Abschnitt in Lohn › Lohndokumente.
 *
 * Nach einer bestätigten Änderung an Lohndaten (oder «Jahr nachrechnen»)
 * rechnet der Kern die abgerechneten Monate neu; jede Abweichung wird ein
 * Vorschlag. «Korrekturfassung erstellen» ersetzt den Monat (Begründung
 * Pflicht), ausbezahlt bzw. zurückgefordert wird die Differenz. «Verwerfen»
 * lässt die Abrechnung, wie sie ist (protokolliert).
 *
 * API: GET/POST /api/hr/lohn-korrekturen. Jahr im localStorage (§10).
 */

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, FileDiff, FilePlus2, History, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Loading } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/use-confirm";
import { TOAST } from "@/lib/messages";
import { formatChf, formatDateFull } from "@/lib/format";
import { monatLabel } from "@/lib/lohn/monate";
import { JahrWahl, useGemerkt, useGemerktesJahr } from "@/components/hr/lohn/jahr-wahl";
import { KorrekturEingabe, KORREKTUR_MIN, chfMitVorzeichen, korrekturText } from "@/components/hr/lohn/korrektur-eingabe";

interface Vorschlag {
  id: string;
  profile_id: string;
  name: string;
  jahr: number;
  monat: number;
  brutto_alt: number | string;
  brutto_neu: number | string;
  netto_alt: number | string;
  netto_neu: number | string;
  differenz: number | string;
  status: "offen" | "erledigt" | "verworfen";
  erledigt_at: string | null;
  erledigt_von_name: string | null;
}

const SPALTEN = "minmax(0, 1.3fr) 120px 200px 110px auto";

function differenzKlasse(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "text-muted-foreground";
  return n > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300";
}

export function KorrekturVorschlaege({ onFassungErstellt }: { onFassungErstellt?: (profileId: string) => void }) {
  const [jahr, setJahr] = useGemerktesJahr("lohn-korrekturen-jahr");
  const [erledigteOffen, setErledigteOffen] = useGemerkt<"0" | "1">("lohn-korrekturen-erledigte", "0", ["0", "1"]);
  const [daten, setDaten] = useState<{ jahr: number; liste: Vorschlag[] } | null>(null);
  const [version, setVersion] = useState(0);
  const [rechnet, setRechnet] = useState(false);
  const [fehler, setFehler] = useState<string[]>([]);
  const [erstelle, setErstelle] = useState<Vorschlag | null>(null);
  const [verwirft, setVerwirft] = useState<string | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    let aktiv = true;
    fetch(`/api/hr/lohn-korrekturen?jahr=${jahr}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j.success) {
          toast.error(`Korrektur-Vorschläge: ${j.error ?? "konnten nicht geladen werden"}`);
          setDaten({ jahr, liste: [] });
          return;
        }
        setDaten({ jahr, liste: (j.vorschlaege ?? []) as Vorschlag[] });
      })
      .catch((e) => {
        if (!aktiv) return;
        toast.error(`Korrektur-Vorschläge: ${e instanceof Error ? e.message : String(e)}`);
        setDaten({ jahr, liste: [] });
      });
    return () => { aktiv = false; };
  }, [jahr, version]);

  const laedt = !daten || daten.jahr !== jahr;
  const liste = daten && daten.jahr === jahr ? daten.liste : [];
  const offene = liste.filter((v) => v.status === "offen");
  const erledigte = liste.filter((v) => v.status !== "offen");

  function jahrWechseln(j: number) {
    setFehler([]);
    setJahr(j);
  }

  async function nachrechnen() {
    setRechnet(true);
    try {
      const res = await fetch("/api/hr/lohn-korrekturen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aktion: "nachrechnen", jahr }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { TOAST.errorOr(j.error, "Nachrechnen fehlgeschlagen"); return; }
      const n = Number(j.vorschlaege ?? 0);
      const f = Array.isArray(j.fehler) ? (j.fehler as string[]) : [];
      setFehler(f);
      toast.success(n === 0 ? `${jahr} nachgerechnet — keine Abweichung` : `${jahr} nachgerechnet — ${n} Korrektur-Vorschl${n === 1 ? "ag" : "äge"}`);
      if (f.length > 0) toast.warning(`${f.length} Monat${f.length === 1 ? "" : "e"} nicht gerechnet`, { description: "Details stehen über der Liste." });
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(`Nachrechnen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRechnet(false);
    }
  }

  async function verwerfen(v: Vorschlag) {
    const ok = await confirm({
      title: "Vorschlag verwerfen?",
      message: `${v.name} · ${monatLabel({ jahr: v.jahr, monat: v.monat })}: Die Abrechnung bleibt, wie sie ist. Der Vorschlag wird als verworfen protokolliert.`,
      confirmLabel: "Verwerfen",
      variant: "red",
    });
    if (!ok) return;
    setVerwirft(v.id);
    try {
      const res = await fetch("/api/hr/lohn-korrekturen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aktion: "verwerfen", id: v.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { TOAST.errorOr(j.error, "Verwerfen fehlgeschlagen"); return; }
      toast.success("Vorschlag verworfen");
      setVersion((x) => x + 1);
    } catch (e) {
      toast.error(`Verwerfen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerwirft(null);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FileDiff className="h-4 w-4" /> Korrektur-Vorschläge
            </h3>
            <p className="text-xs text-muted-foreground">
              Abgerechnete Monate, die nach einer Änderung an Lohndaten anders herauskommen. Eine Korrekturfassung ersetzt den
              Monat; ausbezahlt bzw. zurückgefordert wird die Differenz.
            </p>
          </div>
          <JahrWahl jahr={jahr} onChange={jahrWechseln} disabled={rechnet} />
          <button
            type="button"
            onClick={() => void nachrechnen()}
            disabled={rechnet}
            className="kasten kasten-muted"
            data-tooltip="Alle abgerechneten Monate des Jahres neu rechnen und Abweichungen als Vorschlag anlegen"
          >
            {rechnet ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {rechnet ? "Rechnet…" : "Jahr nachrechnen"}
          </button>
        </div>

        {fehler.length > 0 && (
          <div className="text-xs rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2.5 py-2 space-y-1">
            <p className="font-medium">Beim Nachrechnen nicht gerechnet ({fehler.length}):</p>
            <ul className="list-disc pl-4 space-y-0.5 max-h-32 overflow-y-auto">
              {fehler.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </div>
        )}

        {laedt ? (
          <Loading />
        ) : offene.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={`Keine offenen Korrektur-Vorschläge ${jahr}`}
            description="Nach einer bestätigten Änderung an Lohndaten oder mit «Jahr nachrechnen» erscheinen hier die Monate, die abweichen."
          />
        ) : (
          <div className="rounded-lg border border-border divide-y">
            <div
              className="hidden md:grid items-center gap-x-3 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground"
              style={{ gridTemplateColumns: SPALTEN }}
            >
              <div>Mitarbeiter</div>
              <div>Monat</div>
              <div>Netto bisher → neu</div>
              <div className="text-right" data-tooltip="positiv = Nachzahlung, negativ = Rückforderung">Differenz</div>
              <div />
            </div>
            {offene.map((v) => (
              <div key={v.id} className="grid items-center gap-x-3 px-3 py-2 text-sm" style={{ gridTemplateColumns: SPALTEN }}>
                <div className="font-medium truncate">{v.name}</div>
                <div className="text-xs text-muted-foreground">{monatLabel({ jahr: v.jahr, monat: v.monat })}</div>
                <div
                  className="text-xs tabular-nums"
                  data-tooltip={`Brutto ${formatChf(v.brutto_alt)} → ${formatChf(v.brutto_neu)}`}
                >
                  {formatChf(v.netto_alt)} → {formatChf(v.netto_neu)}
                </div>
                <div className={`text-right tabular-nums font-semibold ${differenzKlasse(v.differenz)}`}>{chfMitVorzeichen(v.differenz)}</div>
                <div className="flex justify-end gap-1">
                  <button type="button" onClick={() => setErstelle(v)} disabled={verwirft !== null} className="kasten kasten-red text-xs">
                    <FilePlus2 className="h-3.5 w-3.5" /> Korrekturfassung erstellen
                  </button>
                  <button type="button" onClick={() => void verwerfen(v)} disabled={verwirft !== null} className="kasten kasten-muted text-xs">
                    {verwirft === v.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Verwerfen
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!laedt && erledigte.length > 0 && (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setErledigteOffen(erledigteOffen === "1" ? "0" : "1")}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <History className="h-3 w-3" />
              Erledigt / verworfen ({erledigte.length})
              {erledigteOffen === "1" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {erledigteOffen === "1" && (
              <div className="space-y-0.5">
                {erledigte.map((v) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-x-2 px-1 py-0.5 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/80">{v.name}</span>
                    <span>· {monatLabel({ jahr: v.jahr, monat: v.monat })}</span>
                    <span className="tabular-nums">· {chfMitVorzeichen(v.differenz)}</span>
                    <span
                      className={`px-1.5 py-0 rounded-full text-[10px] font-medium ${
                        v.status === "erledigt"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                          : "bg-foreground/[0.08] dark:bg-foreground/[0.15]"
                      }`}
                    >
                      {v.status === "erledigt" ? "Korrekturfassung erstellt" : "Verworfen"}
                    </span>
                    {(v.erledigt_von_name || v.erledigt_at) && (
                      <span>
                        {v.erledigt_von_name ? `von ${v.erledigt_von_name}` : ""}
                        {v.erledigt_at ? ` am ${formatDateFull(v.erledigt_at)}` : ""}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>

      {erstelle && (
        <ErstellenModal
          key={erstelle.id}
          vorschlag={erstelle}
          onClose={() => setErstelle(null)}
          onDone={() => {
            const pid = erstelle.profile_id;
            setErstelle(null);
            setVersion((x) => x + 1);
            onFassungErstellt?.(pid);
          }}
        />
      )}
      {ConfirmModalElement}
    </Card>
  );
}

function ErstellenModal({ vorschlag: v, onClose, onDone }: { vorschlag: Vorschlag; onClose: () => void; onDone: () => void }) {
  const [begruendung, setBegruendung] = useState("");
  const [datum, setDatum] = useState("");
  const [busy, setBusy] = useState(false);

  async function erstellen() {
    if (begruendung.trim().length < KORREKTUR_MIN) { toast.error(`Begründung: mindestens ${KORREKTUR_MIN} Zeichen`); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/hr/lohn-korrekturen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aktion: "erstellen", id: v.id, begruendung: begruendung.trim(), ...(datum ? { auszahlungsdatum: datum } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) { TOAST.errorOr(j.error, "Korrekturfassung fehlgeschlagen"); return; }
      toast.success(korrekturText(j));
      onDone();
    } catch (e) {
      toast.error(`Korrekturfassung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} closable={!busy} title="Korrekturfassung erstellen" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground">{v.name}</strong> · {monatLabel({ jahr: v.jahr, monat: v.monat })}: Netto{" "}
          <span className="tabular-nums">{formatChf(v.netto_alt)} → {formatChf(v.netto_neu)}</span>{" "}
          (<span className={`tabular-nums font-semibold ${differenzKlasse(v.differenz)}`}>{chfMitVorzeichen(v.differenz)}</span>).
          Die Korrekturfassung ersetzt den Monat, die bisherige Fassung bleibt erhalten. Ausbezahlt bzw. zurückgefordert wird die Differenz.
        </p>
        <KorrekturEingabe begruendung={begruendung} setBegruendung={setBegruendung} datum={datum} setDatum={setDatum} disabled={busy} />
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button
            type="button"
            onClick={() => void erstellen()}
            disabled={busy || begruendung.trim().length < KORREKTUR_MIN}
            className="kasten kasten-red flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Erstellt…</> : <><FilePlus2 className="h-3.5 w-3.5" /> Korrekturfassung erstellen</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
