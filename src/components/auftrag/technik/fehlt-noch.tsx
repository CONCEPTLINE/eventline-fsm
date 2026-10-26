"use client";

// «Fehlt noch» je Positionsgruppe (Migration 355, Leo 2026-10-26) — nur im
// Firmen-Tab, NICHT im Lieferantenportal und nicht in der Zahl am Tab.
// Technisch noetige, aber nicht genannte Angaben/Komponenten als kurze
// Hinweise («Mikrofon-Halterung fehlt – Stative oder Galgen?»). Die
// Eingang-KI legt sie an und hakt sie ab, wenn eine Folgemail sie beantwortet;
// von Hand: ✓ erledigt, ✕ verwerfen, ↺ wieder offen, «+ Hinweis». Was von
// Hand entschieden wurde, fasst die KI nie mehr an.

import { useState } from "react";
import { Check, ChevronDown, CircleHelp, Loader2, Plus, RotateCcw, X } from "lucide-react";
import type { HinweisStatus, TechnikHinweis } from "@/lib/technik";
import { HINWEIS_TEXT_MAX } from "@/lib/technik";
import { formatDateTimeFull } from "@/lib/format";

type OnStatus = (id: string, status: HinweisStatus) => Promise<boolean>;

/** Dezenter Marker «2 fehlt» im Gruppenkopf — bewusst anders als das rote
 *  «offen» (das wartet auf EVENTLINE wegen des Lieferanten). */
export function FehltMarker({ hinweise }: { hinweise: Pick<TechnikHinweis, "status" | "text">[] }) {
  const offen = hinweise.filter((h) => h.status === "offen");
  if (!offen.length) return null;
  const tooltip = `Fehlt noch: ${offen.slice(0, 3).map((h) => h.text).join(" · ")}${offen.length > 3 ? ` · +${offen.length - 3} weitere` : ""}`;
  return (
    <span
      className="inline-flex items-center justify-center h-5 px-1.5 rounded-full text-[10px] font-semibold tabular-nums whitespace-nowrap shrink-0 border border-amber-300/80 text-amber-700 dark:border-amber-500/40 dark:text-amber-300"
      data-tooltip={tooltip}
    >
      {offen.length} fehlt
    </span>
  );
}

/** Wer/wann erledigt bzw. verworfen — fuer den Tooltip. */
function abschlussText(h: TechnikHinweis): string {
  const wann = h.erledigt_at ? ` am ${formatDateTimeFull(h.erledigt_at)}` : "";
  if (h.status === "verworfen") return `Verworfen${h.erledigt_von_name ? ` von ${h.erledigt_von_name}` : ""}${wann}`;
  if (!h.manuell_geaendert_at) return `Vom Eingang beantwortet (Eingang-KI)${wann}`;
  return `Erledigt${h.erledigt_von_name ? ` von ${h.erledigt_von_name}` : ""}${wann}`;
}

/** Block «Fehlt noch» einer aufgeklappten Gruppe (nach dem Zusammenhang, vor
 *  den Einzelpositionen). Ohne Hinweise: nichts (der «+ Hinweis»-Knopf steht
 *  in der Fusszeile der Gruppe). Erledigte/verworfene eingeklappt. */
export function FehltNochBlock({ hinweise, canEdit, busy, onStatus }: {
  hinweise: TechnikHinweis[];
  canEdit: boolean;
  busy: string | null;
  onStatus: OnStatus;
}) {
  const [zeigeErledigte, setZeigeErledigte] = useState(false);
  const [hover, setHover] = useState(false);
  if (!hinweise.length) return null;
  const offen = hinweise.filter((h) => h.status === "offen");
  const erledigt = hinweise.filter((h) => h.status !== "offen");
  const nErledigt = erledigt.filter((h) => h.status === "erledigt").length;
  return (
    <div className="rounded-md border border-amber-200/80 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10 px-2 py-1">
      <div className="flex items-center gap-2 min-h-5">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
          <CircleHelp className="h-3 w-3" /> Fehlt noch
        </span>
        {!offen.length && <span className="text-[11px] text-muted-foreground">nichts mehr offen</span>}
        {erledigt.length > 0 && (
          <button
            type="button"
            onClick={() => setZeigeErledigte(!zeigeErledigte)}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            className="ml-auto inline-flex items-center gap-1 text-[11px]"
            style={{ color: hover ? "var(--foreground)" : "var(--muted-foreground)" }}
            aria-expanded={zeigeErledigte}
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${zeigeErledigte ? "rotate-180" : ""}`} />
            {[
              nErledigt ? `${nErledigt} erledigt` : null,
              erledigt.length - nErledigt ? `${erledigt.length - nErledigt} verworfen` : null,
            ].filter(Boolean).join(" · ")}
          </button>
        )}
      </div>
      {offen.length > 0 && (
        <ul>
          {offen.map((h) => <HinweisZeile key={h.id} hinweis={h} canEdit={canEdit} busy={busy} onStatus={onStatus} />)}
        </ul>
      )}
      {zeigeErledigte && erledigt.length > 0 && (
        <ul className="border-t border-amber-200/70 dark:border-amber-500/20 mt-0.5 pt-0.5">
          {erledigt.map((h) => <HinweisZeile key={h.id} hinweis={h} canEdit={canEdit} busy={busy} onStatus={onStatus} />)}
        </ul>
      )}
    </div>
  );
}

function HinweisZeile({ hinweis: h, canEdit, busy, onStatus }: {
  hinweis: TechnikHinweis;
  canEdit: boolean;
  busy: string | null;
  onStatus: OnStatus;
}) {
  const [hover, setHover] = useState(false);
  const offen = h.status === "offen";
  const laeuft = busy === `hin_${h.id}`;
  const knopf = (status: HinweisStatus, tone: string, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => void onStatus(h.id, status)}
      disabled={busy !== null}
      className={`icon-btn ${tone} p-1`}
      data-tooltip={label}
      aria-label={label}
    >
      {icon}
    </button>
  );
  return (
    <li
      className="flex items-start gap-1.5 text-xs min-h-6 py-0.5"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className={`mt-[0.4rem] h-1 w-1 rounded-full shrink-0 ${offen ? "bg-amber-600 dark:bg-amber-300" : "bg-muted-foreground/60"}`} aria-hidden />
      <span
        className={`flex-1 min-w-0 break-words ${offen ? "text-foreground/90" : "text-muted-foreground"} ${h.status === "verworfen" ? "line-through" : ""}`}
        data-tooltip={offen ? (h.created_via === "ki" ? "Von der Eingang-KI erkannt" : "Von Hand erfasst") : abschlussText(h)}
      >
        {h.text}
      </span>
      {!offen && (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0 mt-0.5">
          {h.status === "verworfen" ? "verworfen" : "erledigt"}
        </span>
      )}
      {canEdit && (
        // Platz bleibt reserviert (visibility), damit die Zeile beim Hover nicht springt.
        <span className="flex items-center shrink-0 -my-0.5" style={{ visibility: hover || laeuft ? "visible" : "hidden" }}>
          {laeuft ? (
            <span className="p-1"><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></span>
          ) : offen ? (
            <>
              {knopf("erledigt", "icon-btn-green", "Erledigt", <Check className="h-3 w-3" />)}
              {knopf("verworfen", "icon-btn-red", "Verwerfen — nicht nötig", <X className="h-3 w-3" />)}
            </>
          ) : (
            knopf("offen", "icon-btn-muted", "Wieder offen", <RotateCcw className="h-3 w-3" />)
          )}
        </span>
      )}
    </li>
  );
}

/** «+ Hinweis» von Hand: eine Zeile, gespeichert nur per Knopf (Enter = Tab). */
export function HinweisNeu({ busy, onSave, onClose }: {
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
        maxLength={HINWEIS_TEXT_MAX}
        autoFocus
        placeholder="Was fehlt noch? z.B. Kabellänge Bühne → Mischpult?"
        aria-label="Hinweis"
        className="flex-1 min-w-[220px] rounded-lg border border-border bg-background px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
      />
      <button
        type="button"
        onClick={async () => { if (await onSave(text.trim())) onClose(); }}
        disabled={busy || !text.trim()}
        className="kasten kasten-blue"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        {busy ? "Wird gespeichert…" : "Hinweis"}
      </button>
      <button type="button" onClick={onClose} disabled={busy} className="kasten kasten-muted">Abbrechen</button>
    </div>
  );
}
