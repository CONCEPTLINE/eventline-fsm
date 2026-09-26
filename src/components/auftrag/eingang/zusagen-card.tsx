"use client";

/**
 * ZusagenCard — der KI-gepflegte Kern des Auftrags auf der Uebersicht:
 *  - Zusammenfassung (jobs.ai_summary; von der KI gefuehrt, manuell
 *    ueberschreibbar — Leos Vorgabe: Aenderungen immer moeglich)
 *  - Zusagen an den Kunden (offen/erledigt/hinfaellig), von der KI aus dem
 *    Eingang extrahiert oder von Hand erfasst; Quelle per Klick einsehbar
 *  - Frage-Feld: beantwortet Fragen aus dem gesamten Auftragswissen
 * Selbsttragend: laedt seine Daten selbst (nur jobId + canEdit als Props).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import {
  Check, Loader2, FileText, Pencil, X, CornerDownLeft, Undo2, Wrench, Briefcase, ChevronRight,
} from "lucide-react";

type Zusage = {
  id: string;
  text: string;
  status: "offen" | "erledigt" | "hinfaellig";
  mit_wem: string | null;
  created_via: "ki" | "manuell";
  quelle: { kind: string; content: string | null; file_name: string | null } | null;
};

type DatumVorschlag = { start_datum: string; end_datum: string; grund: string };

type TerminVorschlag = {
  aktion: "erstellen" | "aendern";
  termin_id: string | null;
  titel: string;
  start: string;
  ende: string | null;
  grund: string;
};

function fmtDatum(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function fmtZeit(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** "22.09.2026, 13:30 – 14:00" (gleicher Tag) bzw. voll ausgeschrieben. */
function fmtZeitBereich(start: string, ende: string | null): string {
  const s = fmtZeit(start);
  if (!ende) return s;
  const tag = (iso: string) => new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
  const e = tag(start) === tag(ende)
    ? new Date(ende).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })
    : fmtZeit(ende);
  return `${s} – ${e}`;
}

export function ZusagenCard({ jobId, canEdit, onJobChanged }: { jobId: string; canEdit: boolean; onJobChanged?: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [summary, setSummary] = useState<string | null>(null);
  const [zusagen, setZusagen] = useState<Zusage[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [editSummary, setEditSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);
  const [quelleModal, setQuelleModal] = useState<Zusage["quelle"] | null>(null);
  const [frage, setFrage] = useState("");
  const [fragt, setFragt] = useState(false);
  const [antwort, setAntwort] = useState<string | null>(null);
  const [datumVorschlag, setDatumVorschlag] = useState<DatumVorschlag | null>(null);
  const [datumBusy, setDatumBusy] = useState(false);
  const [terminVorschlaege, setTerminVorschlaege] = useState<TerminVorschlag[]>([]);
  const [terminBusy, setTerminBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [jobRes, zRes] = await Promise.all([
      supabase.from("jobs").select("ai_summary, ai_datum_vorschlag, ai_termin_vorschlaege").eq("id", jobId).maybeSingle(),
      supabase
        .from("job_zusagen")
        .select("id, text, status, mit_wem, created_via, quelle:job_inbox_items(kind, content, file_name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
    ]);
    setSummary(jobRes.data?.ai_summary ?? null);
    setDatumVorschlag((jobRes.data?.ai_datum_vorschlag as DatumVorschlag | null) ?? null);
    setTerminVorschlaege(
      (jobRes.data?.ai_termin_vorschlaege as { vorschlaege?: TerminVorschlag[] } | null)?.vorschlaege ?? [],
    );
    setZusagen((zRes.data ?? []) as unknown as Zusage[]);
  }, [supabase, jobId]);

  useEffect(() => { load(); }, [load]);

  const offene = (zusagen ?? []).filter((z) => z.status === "offen");
  const andere = (zusagen ?? []).filter((z) => z.status !== "offen");

  async function setStatus(z: Zusage, status: Zusage["status"]) {
    const { error } = await supabase
      .from("job_zusagen")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", z.id);
    if (error) { toast.error("Änderung fehlgeschlagen: " + error.message); return; }
    setZusagen((prev) => (prev ?? []).map((x) => (x.id === z.id ? { ...x, status } : x)));
  }

  async function saveSummary() {
    setSavingSummary(true);
    const { error } = await supabase.from("jobs").update({ ai_summary: summaryDraft.trim() || null }).eq("id", jobId);
    setSavingSummary(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    setSummary(summaryDraft.trim() || null);
    setEditSummary(false);
  }

  async function stelleFrage() {
    const f = frage.trim();
    if (!f || fragt) return;
    setFragt(true);
    setAntwort(null);
    try {
      const res = await fetch("/api/ai/frage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, frage: f }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || "Anfrage fehlgeschlagen");
      setAntwort(j.antwort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Anfrage fehlgeschlagen");
    } finally {
      setFragt(false);
    }
  }

  /** KI-Termin-Vorschlag uebernehmen oder verwerfen — Termine werden NIE
   *  automatisch angelegt, nur hier auf Klick (unter USER-RLS). */
  async function terminEntscheiden(idx: number, uebernehmen: boolean) {
    const t = terminVorschlaege[idx];
    if (!t || terminBusy !== null) return;
    setTerminBusy(idx);
    try {
      if (uebernehmen) {
        if (t.aktion === "aendern" && t.termin_id) {
          const upd: { title: string; start_time: string; end_time?: string } = { title: t.titel, start_time: t.start };
          if (t.ende) upd.end_time = t.ende;
          const { error } = await supabase.from("job_appointments").update(upd).eq("id", t.termin_id);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await supabase.from("job_appointments").insert({
            job_id: jobId, title: t.titel, description: t.grund, start_time: t.start, end_time: t.ende,
          });
          if (error) throw new Error(error.message);
        }
        window.dispatchEvent(new CustomEvent("appointments:invalidate", { detail: { jobId } }));
        toast.success(t.aktion === "aendern" ? "Termin angepasst" : "Termin erstellt");
      }
      const rest = terminVorschlaege.filter((_, i) => i !== idx);
      const { error: perErr } = await supabase
        .from("jobs")
        .update({ ai_termin_vorschlaege: rest.length ? { vorschlaege: rest } : null })
        .eq("id", jobId);
      if (perErr) throw new Error(perErr.message);
      setTerminVorschlaege(rest);
    } catch (e) {
      toast.error("Aktion fehlgeschlagen: " + (e instanceof Error ? e.message : "unbekannter Fehler"));
    } finally {
      setTerminBusy(null);
    }
  }

  const tiles = summary ? splitTiles(summary) : null;
  const startEdit = canEdit ? () => { setSummaryDraft(summary ?? LEER_VORLAGE); setEditSummary(true); } : undefined;

  return (
    <div className="space-y-3 mb-3">
        {/* ── Offener KI-Datumsvorschlag (bleibt bis zur Entscheidung) ── */}
        {datumVorschlag && (
          <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 space-y-1.5">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Vorschlag: Event-Datum auf {datumVorschlag.start_datum === datumVorschlag.end_datum
                ? fmtDatum(datumVorschlag.start_datum)
                : `${fmtDatum(datumVorschlag.start_datum)} – ${fmtDatum(datumVorschlag.end_datum)}`}
            </p>
            <p className="text-[12px] text-amber-800 dark:text-amber-300">{datumVorschlag.grund}</p>
            {canEdit && (
              <div className="flex gap-1.5 pt-0.5">
                <button
                  type="button"
                  className="kasten kasten-red"
                  disabled={datumBusy}
                  onClick={async () => {
                    setDatumBusy(true);
                    const { error } = await supabase
                      .from("jobs")
                      .update({
                        start_date: `${datumVorschlag.start_datum}T00:00:00+00:00`,
                        end_date: `${datumVorschlag.end_datum}T00:00:00+00:00`,
                        ai_datum_vorschlag: null,
                      })
                      .eq("id", jobId);
                    setDatumBusy(false);
                    if (error) { toast.error("Umdatieren fehlgeschlagen: " + error.message); return; }
                    setDatumVorschlag(null);
                    toast.success("Event-Datum angepasst");
                    onJobChanged?.();
                  }}
                >
                  {datumBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Umdatieren
                </button>
                <button
                  type="button"
                  className="kasten kasten-muted"
                  disabled={datumBusy}
                  onClick={async () => {
                    const { error } = await supabase.from("jobs").update({ ai_datum_vorschlag: null }).eq("id", jobId);
                    if (error) { toast.error("Verwerfen fehlgeschlagen: " + error.message); return; }
                    setDatumVorschlag(null);
                  }}
                >
                  <X className="h-3.5 w-3.5" /> Verwerfen
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Offene KI-Termin-Vorschlaege (bleiben bis zur Entscheidung) ── */}
        {terminVorschlaege.length > 0 && (
          <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 space-y-2.5">
            {terminVorschlaege.map((t, idx) => (
              <div key={`${t.titel}-${t.start}`} className="space-y-1">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  {t.aktion === "aendern" ? "Vorschlag: Termin ändern" : "Vorschlag: neuer Termin"} — {t.titel}, {fmtZeitBereich(t.start, t.ende)}
                </p>
                <p className="text-[12px] text-amber-800 dark:text-amber-300">{t.grund}</p>
                {canEdit && (
                  <div className="flex gap-1.5 pt-0.5">
                    <button
                      type="button"
                      className="kasten kasten-red"
                      disabled={terminBusy !== null}
                      onClick={() => terminEntscheiden(idx, true)}
                    >
                      {terminBusy === idx ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      {t.aktion === "aendern" ? "Termin anpassen" : "Termin erstellen"}
                    </button>
                    <button
                      type="button"
                      className="kasten kasten-muted"
                      disabled={terminBusy !== null}
                      onClick={() => terminEntscheiden(idx, false)}
                    >
                      <X className="h-3.5 w-3.5" /> Verwerfen
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Wissens-Kacheln: Operativ | Administrativ ────── */}
        {editSummary ? (
          <section className="rounded-2xl border border-border bg-card p-4 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Zusammenfassung bearbeiten
            </p>
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              rows={14}
              className="w-full text-sm rounded-xl border border-border bg-muted/20 px-3 py-2 focus:outline-none focus:border-foreground/40 resize-y font-mono"
            />
            <div className="flex gap-1.5 justify-end">
              <button type="button" className="kasten kasten-muted" onClick={() => setEditSummary(false)}><X className="h-3.5 w-3.5" /> Abbrechen</button>
              <button type="button" className="kasten kasten-red" onClick={saveSummary} disabled={savingSummary}>
                {savingSummary ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Speichern
              </button>
            </div>
          </section>
        ) : tiles ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
            <SummaryTile titel="Operativ" icon={<Wrench className="h-3.5 w-3.5" />} text={tiles.operativ} onEdit={startEdit}
              hint="Noch nichts Operatives — entsteht aus dem Eingang." />
            <SummaryTile titel="Administrativ" icon={<Briefcase className="h-3.5 w-3.5" />} text={tiles.administrativ} onEdit={startEdit}
              hint="Noch nichts Administratives — entsteht aus dem Eingang." />
          </div>
        ) : (
          <SummaryTile
            titel="Zusammenfassung"
            icon={<Wrench className="h-3.5 w-3.5" />}
            text={summary ?? ""}
            onEdit={startEdit}
            hint="Noch keine Zusammenfassung — sie entsteht automatisch, sobald etwas im Tab «Eingang» abgelegt wird."
          />
        )}

        {/* ── Zusagen-Kachel ───────────────────────────────── */}
        <section className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          Zusagen an den Kunden
          {offene.length > 0 && (
            <span className="text-[10px] font-semibold normal-case tracking-normal text-amber-700 dark:text-amber-400 bg-amber-500/15 rounded-full px-1.5 py-0.5">
              {offene.length} offen
            </span>
          )}
        </p>
        <div className="space-y-1">
          {zusagen === null ? (
            <div className="py-3 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Laden…</div>
          ) : (
            <>
              {offene.map((z) => (
                <ZusageRow key={z.id} z={z} canEdit={canEdit} onStatus={setStatus} onQuelle={setQuelleModal} />
              ))}
              {offene.length === 0 && (zusagen.length === 0 ? (
                <p className="text-[12px] text-muted-foreground py-1">Noch keine Zusagen erfasst.</p>
              ) : (
                <p className="text-[12px] text-muted-foreground py-1 flex items-center gap-1"><Check className="h-3.5 w-3.5 text-green-600" /> Keine offenen Zusagen.</p>
              ))}
              {andere.length > 0 && (
                <button type="button" onClick={() => setShowDone((s) => !s)} className="text-[11px] text-muted-foreground underline">
                  {showDone ? "Erledigte ausblenden" : `Erledigt & hinfällig anzeigen (${andere.length})`}
                </button>
              )}
              {showDone && andere.map((z) => (
                <ZusageRow key={z.id} z={z} canEdit={canEdit} onStatus={setStatus} onQuelle={setQuelleModal} />
              ))}
            </>
          )}
        </div>

        {/* ── Frage an den Auftrag ─────────────────────────── */}
        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <input
              value={frage}
              onChange={(e) => setFrage(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); stelleFrage(); } }}
              placeholder="Frage zum Auftrag — z.B. «Was wurde zum Aufbau abgemacht?»"
              className="flex-1 text-sm rounded-lg border border-border bg-muted/20 px-2.5 py-1.5 focus:outline-none focus:border-foreground/40"
            />
            <button type="button" onClick={stelleFrage} disabled={!frage.trim() || fragt} className="kasten kasten-red">
              {fragt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CornerDownLeft className="h-3.5 w-3.5" />}
            </button>
          </div>
          {antwort && (
            <div className="text-sm rounded-xl bg-muted/30 border border-border px-3 py-2 whitespace-pre-wrap">
              {antwort}
            </div>
          )}
        </div>
        </section>

      {/* Quelle-Beleg */}
      {quelleModal && (
        <Modal open onClose={() => setQuelleModal(null)} title="Quelle im Eingang" size="md">
          {quelleModal.kind === "text" ? (
            <p className="text-sm whitespace-pre-wrap max-h-[50vh] overflow-auto">{quelleModal.content}</p>
          ) : (
            <p className="text-sm flex items-center gap-2"><FileText className="h-4 w-4" /> Datei: {quelleModal.file_name}</p>
          )}
        </Modal>
      )}
    </div>
  );
}

/** Vorlage fuer manuelles Erst-Erfassen im Kachel-Format. */
const LEER_VORLAGE = "=== OPERATIV ===\n\n=== ADMINISTRATIV ===\n";

/** Trennt die Zusammenfassung in die zwei Kacheln (Marker-Zeilen
 *  "=== OPERATIV ===" / "=== ADMINISTRATIV ==="). null = Alt-Format
 *  ohne Marker → eine Einzel-Kachel als Fallback. */
function splitTiles(text: string): { operativ: string; administrativ: string } | null {
  if (!/^===\s*OPERATIV/m.test(text)) return null;
  const op: string[] = [];
  const ad: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^===\s*(OPERATIV|ADMINISTRATIV)\s*===\s*$/i);
    if (m) { cur = m[1].toUpperCase() === "OPERATIV" ? op : ad; continue; }
    cur?.push(line);
  }
  return { operativ: op.join("\n").trim(), administrativ: ad.join("\n").trim() };
}

/** Eine Wissens-Kachel im Look der uebrigen Auftrag-Kacheln (WER/NOTIZEN). */
function SummaryTile({ titel, icon, text, onEdit, hint }: {
  titel: string;
  icon: React.ReactNode;
  text: string;
  onEdit?: () => void;
  hint: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 relative min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
        {icon} {titel}
      </p>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="absolute top-3 right-3 p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
          data-tooltip="Bearbeiten"
          data-tooltip-align="end"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {text ? (
        <div className="text-sm text-foreground/90"><SummaryView text={text} /></div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{hint}</p>
      )}
    </section>
  );
}

/** Gliedert die KI-Zusammenfassung: GROSSBUCHSTABEN-Zeile = Abschnitts-Label,
 *  "- "-Zeilen = Stichpunkte, Rest = normaler Text. Faellt bei Alt-Daten
 *  (reiner Fliesstext) automatisch auf normale Absaetze zurueck. */
function SummaryView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const isHeader = line.length <= 48 && !line.startsWith("- ") && line === line.toUpperCase() && /[A-ZÄÖÜ]/.test(line);
        if (isHeader) {
          return <p key={i} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground !mt-3.5 first:!mt-0">{line}</p>;
        }
        if (line.startsWith("- ")) {
          const body = line.slice(2);
          // "- OFFEN: …" = Handlungsbedarf, faellt farblich auf.
          if (/^OFFEN:/i.test(body)) {
            // Klartext statt Symbol/Chip (Leo): die Zeile beginnt woertlich
            // mit "Offen:" — sofort verstaendlich, farblich abgehoben.
            return (
              <p key={i} className="flex gap-2 leading-relaxed text-amber-700 dark:text-amber-400">
                <span className="text-muted-foreground/60 shrink-0">–</span>
                <span><span className="font-semibold">Offen:</span> {body.replace(/^OFFEN:\s*/i, "")}</span>
              </p>
            );
          }
          // "- Schlagwort: Kern" — zusammenklappbar: standardmaessig nur das
          // Schlagwort, Klick zeigt den Text (Leo: nur lesen was man gerade
          // wissen muss). Offen-Punkte bleiben immer voll sichtbar.
          // Schlagwort = alles bis zum ersten ": " (grosszuegige Laenge —
          // die KI baut teils Klammer-Zusaetze ins Schlagwort; Uhrzeiten
          // wie 13:30 matchen nicht, weil nach dem ":" kein Leerzeichen folgt).
          const m = body.match(/^([^:]{2,64}):\s+(.*)$/);
          if (m) return <KlappPunkt key={`${i}-${m[1]}`} titel={m[1]} text={m[2]} />;
          return (
            <p key={i} className="flex gap-2 leading-relaxed">
              <span className="text-muted-foreground/60 shrink-0">–</span>
              <span>{body}</span>
            </p>
          );
        }
        return <p key={i} className="leading-relaxed">{line}</p>;
      })}
    </div>
  );
}

/** Ein zusammenklappbarer Stichpunkt: Kopf = Schlagwort mit Chevron,
 *  Klick klappt die Kernaussage darunter auf/zu. */
function KlappPunkt({ titel, text }: { titel: string; text: string }) {
  const [offen, setOffen] = useState(false);
  const [hover, setHover] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOffen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="flex items-center gap-1.5 w-full text-left rounded-md px-1 py-0.5 -mx-1"
        style={{ background: hover ? "color-mix(in srgb, var(--foreground) 7%, transparent)" : "transparent" }}
        aria-expanded={offen}
      >
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform"
          style={{ transform: offen ? "rotate(90deg)" : "none" }}
        />
        <span className="font-medium leading-snug">{titel}</span>
      </button>
      {offen && <p className="leading-relaxed text-foreground/90 pl-[26px] pr-1 pt-0.5 pb-1">{text}</p>}
    </div>
  );
}

function ZusageRow({ z, canEdit, onStatus, onQuelle }: {
  z: Zusage;
  canEdit: boolean;
  onStatus: (z: Zusage, s: Zusage["status"]) => void;
  onQuelle: (q: Zusage["quelle"]) => void;
}) {
  const done = z.status === "erledigt";
  const void_ = z.status === "hinfaellig";
  return (
    <div className="flex items-start gap-2.5 py-2 group border-b border-border/40 last:border-0">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => onStatus(z, done || void_ ? "offen" : "erledigt")}
        data-tooltip={done || void_ ? "Wieder öffnen" : "Als erledigt markieren"}
        className={`mt-0.5 h-4 w-4 rounded border shrink-0 flex items-center justify-center ${
          done ? "bg-green-600 border-green-600 text-white"
          : void_ ? "bg-muted border-border text-muted-foreground"
          : "border-amber-500"
        }`}
      >
        {done && <Check className="h-3 w-3" />}
        {void_ && <Undo2 className="h-2.5 w-2.5" />}
      </button>
      <span className={`text-sm flex-1 min-w-0 ${done || void_ ? "text-muted-foreground" : ""} ${void_ ? "line-through" : ""}`}>
        {z.text}
        {z.mit_wem && <span className="text-[11px] text-muted-foreground"> — mit {z.mit_wem}</span>}
      </span>
      <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {z.quelle && (
          <button type="button" onClick={() => onQuelle(z.quelle)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]" data-tooltip="Quelle ansehen">
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
        {canEdit && !void_ && (
          <button type="button" onClick={() => onStatus(z, "hinfaellig")} className="p-1 rounded text-muted-foreground hover:text-red-600 hover:bg-red-500/10" data-tooltip="Hinfällig (gilt nicht mehr)">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}
