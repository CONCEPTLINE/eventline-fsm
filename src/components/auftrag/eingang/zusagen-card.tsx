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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import {
  Sparkles, Check, Plus, Loader2, FileText, Pencil, X, CornerDownLeft, Undo2,
} from "lucide-react";

type Zusage = {
  id: string;
  text: string;
  status: "offen" | "erledigt" | "hinfaellig";
  mit_wem: string | null;
  created_via: "ki" | "manuell";
  quelle: { kind: string; content: string | null; file_name: string | null } | null;
};

export function ZusagenCard({ jobId, canEdit }: { jobId: string; canEdit: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [summary, setSummary] = useState<string | null>(null);
  const [zusagen, setZusagen] = useState<Zusage[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const [editSummary, setEditSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [savingSummary, setSavingSummary] = useState(false);
  const [quelleModal, setQuelleModal] = useState<Zusage["quelle"] | null>(null);
  const [frage, setFrage] = useState("");
  const [fragt, setFragt] = useState(false);
  const [antwort, setAntwort] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [jobRes, zRes] = await Promise.all([
      supabase.from("jobs").select("ai_summary").eq("id", jobId).maybeSingle(),
      supabase
        .from("job_zusagen")
        .select("id, text, status, mit_wem, created_via, quelle:job_inbox_items(kind, content, file_name)")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true }),
    ]);
    setSummary(jobRes.data?.ai_summary ?? null);
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

  async function addZusage() {
    const text = newText.trim();
    if (!text || adding) return;
    setAdding(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("job_zusagen")
      .insert({ job_id: jobId, text, created_via: "manuell", created_by: user?.id ?? null });
    setAdding(false);
    if (error) { toast.error("Zusage konnte nicht gespeichert werden: " + error.message); return; }
    setNewText("");
    load();
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

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden mb-4">
      <header className="px-4 py-2.5 border-b border-border flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          Zusagen &amp; Zusammenfassung
          {offene.length > 0 && (
            <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-500/15 rounded-full px-1.5 py-0.5">
              {offene.length} offen
            </span>
          )}
        </h2>
      </header>

      <div className="p-4 space-y-3">
        {/* ── Zusammenfassung ─────────────────────────────── */}
        {editSummary ? (
          <div className="space-y-1.5">
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              rows={4}
              className="w-full text-sm rounded-xl border border-border bg-muted/20 px-3 py-2 focus:outline-none focus:border-foreground/40 resize-y"
            />
            <div className="flex gap-1.5 justify-end">
              <button type="button" className="kasten kasten-muted" onClick={() => setEditSummary(false)}><X className="h-3.5 w-3.5" /> Abbrechen</button>
              <button type="button" className="kasten kasten-red" onClick={saveSummary} disabled={savingSummary}>
                {savingSummary ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Speichern
              </button>
            </div>
          </div>
        ) : summary ? (
          <div className="group relative text-sm text-foreground/90">
            <SummaryView text={summary} />
            {canEdit && (
              <button
                type="button"
                onClick={() => { setSummaryDraft(summary); setEditSummary(true); }}
                className="absolute -top-1 right-0 p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
                data-tooltip="Zusammenfassung bearbeiten"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            Noch keine Zusammenfassung — sie entsteht automatisch, sobald etwas im Tab «Eingang» abgelegt wird.
            {canEdit && (
              <button type="button" className="underline ml-1" onClick={() => { setSummaryDraft(""); setEditSummary(true); }}>
                Oder selbst schreiben.
              </button>
            )}
          </p>
        )}

        {/* ── Zusagen ─────────────────────────────────────── */}
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
          {canEdit && (
            <div className="flex items-center gap-1.5 pt-1">
              <input
                ref={inputRef}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addZusage(); } }}
                placeholder="Neue Zusage an den Kunden…"
                className="flex-1 text-sm rounded-lg border border-border bg-muted/20 px-2.5 py-1.5 focus:outline-none focus:border-foreground/40"
              />
              <button type="button" onClick={addZusage} disabled={!newText.trim() || adding} className="kasten kasten-muted">
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            </div>
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
      </div>

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
    </section>
  );
}

/** Gliedert die KI-Zusammenfassung: GROSSBUCHSTABEN-Zeile = Abschnitts-Label,
 *  "- "-Zeilen = Stichpunkte, Rest = normaler Text. Faellt bei Alt-Daten
 *  (reiner Fliesstext) automatisch auf normale Absaetze zurueck. */
function SummaryView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    <div>
      {lines.map((line, i) => {
        const isHeader = line.length <= 48 && !line.startsWith("- ") && line === line.toUpperCase() && /[A-ZÄÖÜ]/.test(line);
        if (isHeader) {
          return <p key={i} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mt-2.5 first:mt-0 mb-0.5">{line}</p>;
        }
        if (line.startsWith("- ")) {
          return (
            <p key={i} className="flex gap-1.5 leading-snug py-[1px]">
              <span className="text-muted-foreground shrink-0">–</span>
              <span>{line.slice(2)}</span>
            </p>
          );
        }
        return <p key={i} className="leading-snug py-[1px]">{line}</p>;
      })}
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
    <div className="flex items-start gap-2 py-1 group">
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
