"use client";

/**
 * Lohn-Standardwerte: firmenweite Defaults MIT effective_from-Historie
 * (Migration 195). Multi-Row-Tabelle payroll_defaults, aufgeteilt in:
 *   - AKTUELL: die aktive Zeile (neueste mit effective_from <= today) —
 *     inline editierbar mit per-Feld "OK"-Button.
 *   - GEPLANT: Zeilen mit effective_from > today. Bearbeitbar +
 *     loeschbar. Greifen automatisch am Stichtag — kein Cron.
 *   - HISTORIE: aeltere Zeilen. Read-only.
 *
 * Persistiert via /api/hr/lohn-defaults (GET/POST/PATCH/DELETE).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Wallet, CalendarPlus, History, Trash2, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { useConfirm } from "@/components/ui/use-confirm";
import { Input } from "@/components/ui/input";
import { AN_FIELDS, AG_FIELDS, fmtPct } from "@/components/hr/loehne/lohn-shared";

type PctColumn =
  | "default_ahv_iv_eo_pct" | "default_alv_pct" | "default_nbu_pct"
  | "default_bvg_pct" | "default_ktg_pct" | "default_quellensteuer_pct"
  | "default_employer_ahv_pct" | "default_employer_alv_pct" | "default_employer_fak_pct"
  | "default_employer_bu_pct" | "default_employer_bvg_pct" | "default_employer_verwaltung_pct";

const PCT_COLUMNS: PctColumn[] = [
  "default_ahv_iv_eo_pct", "default_alv_pct", "default_nbu_pct",
  "default_bvg_pct", "default_ktg_pct", "default_quellensteuer_pct",
  "default_employer_ahv_pct", "default_employer_alv_pct", "default_employer_fak_pct",
  "default_employer_bu_pct", "default_employer_bvg_pct", "default_employer_verwaltung_pct",
];

interface Row {
  id: string;
  effective_from: string; // YYYY-MM-DD
  bvg_threshold_chf: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  default_ahv_iv_eo_pct: number;
  default_alv_pct: number;
  default_nbu_pct: number;
  default_bvg_pct: number;
  default_ktg_pct: number;
  default_quellensteuer_pct: number;
  default_employer_ahv_pct: number;
  default_employer_alv_pct: number;
  default_employer_fak_pct: number;
  default_employer_bu_pct: number;
  default_employer_bvg_pct: number;
  default_employer_verwaltung_pct: number;
}

function formatDate(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

/** Konvertiert PctKey (ahv_iv_eo_pct) zu DB-Spalte (default_ahv_iv_eo_pct). */
function colOf(pctKey: string): PctColumn {
  return `default_${pctKey}` as PctColumn;
}

export function LohnStandardwerteCard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [today, setToday] = useState<string>("");
  const [impact, setImpact] = useState<{ standard: number; override: number }>({ standard: 0, override: 0 });
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/hr/lohn-defaults", { cache: "no-store" });
      const json = await res.json();
      if (json?.success) {
        setRows((json.rows ?? []) as Row[]);
        setToday(json.today);
        if (json.impact) setImpact(json.impact);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  // Aufteilung in current / future / past (rows sind desc sortiert).
  const { current, future, past } = useMemo(() => {
    if (!today) return { current: null as Row | null, future: [] as Row[], past: [] as Row[] };
    const future: Row[] = [];
    let current: Row | null = null;
    const past: Row[] = [];
    // rows kommen desc: durchgehen und einteilen
    for (const r of rows) {
      if (r.effective_from > today) {
        future.push(r);
      } else if (!current) {
        current = r;
      } else {
        past.push(r);
      }
    }
    // future: aufsteigend anzeigen (naechster Stichtag oben)
    future.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    return { current, future, past };
  }, [rows, today]);

  async function handleDelete(row: Row) {
    const ok = await confirm({
      title: "Geplanten Eintrag loeschen?",
      message: `Der Eintrag "gueltig ab ${formatDate(row.effective_from)}" wird endgueltig geloescht. Dann greifen ab diesem Datum weiterhin die davor gueltigen Saetze.`,
      confirmLabel: "Loeschen",
      variant: "red",
    });
    if (!ok) return;
    const res = await fetch(`/api/hr/lohn-defaults?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok || !json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Geplanter Eintrag geloescht");
    await loadAll();
  }

  if (loading && rows.length === 0) {
    return (
      <Card className="bg-card">
        <CardContent className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Lade Standardwerte...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Kopf-Card + Aktueller Stand */}
      <Card className="bg-card">
        <CardContent className="p-3 space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <Wallet className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">Lohn-Standardwerte</p>
              <p className="text-[11px] text-muted-foreground">
                Firmenweite Defaults mit Historie. Aenderungen greifen ab dem hinterlegten Datum — alte Lohnabrechnungen bleiben stabil.
              </p>
            </div>
          </div>

          {/* Reichweiten-Anzeige: wieviele MA ziehen die Aenderung automatisch
              mit, wieviele haben eigene Overrides und muessen ggf. separat
              gepflegt werden. */}
          {(impact.standard + impact.override) > 0 && (
            <div className="text-[11px] px-3 py-2 rounded-lg bg-foreground/[0.04] dark:bg-foreground/[0.06] flex items-center gap-3 flex-wrap">
              <span>
                <span className="font-semibold text-green-700 dark:text-green-400">{impact.standard}</span>
                <span className="text-muted-foreground"> Mitarbeiter uebernehmen neue Saetze automatisch</span>
              </span>
              {impact.override > 0 && (
                <span>
                  <span className="font-semibold text-amber-700 dark:text-amber-400">{impact.override}</span>
                  <span className="text-muted-foreground"> haben eigene Overrides und muessen manuell im Mitarbeiter-Tab angepasst werden</span>
                </span>
              )}
            </div>
          )}

          {current && (
            <RowEditor
              row={current}
              badge={`Aktuell gueltig — seit ${formatDate(current.effective_from)}`}
              badgeTone="green"
              onSaved={loadAll}
              readonly={false}
              editWarning='Aenderungen hier gelten AB dem urspruenglichen Datum und wirken auch auf bereits generierte Lohnabrechnungen bei Regenerate. Fuer Aenderungen ab einem NEUEN Stichtag stattdessen "Neuer Stichtag" nutzen.'
              allowDelete={false}
            />
          )}
        </CardContent>
      </Card>

      {/* Geplant */}
      <Card className="bg-card">
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CalendarPlus className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Geplant fuer die Zukunft ({future.length})
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowNewForm((s) => !s)}
              className="kasten kasten-blue"
              data-tooltip="Neue Werte ab einem Stichtag anlegen"
            >
              {showNewForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {showNewForm ? "Abbrechen" : "Neuer Stichtag"}
            </button>
          </div>

          {showNewForm && current && (
            <NewRowForm
              baseline={current}
              today={today}
              onCreated={() => { setShowNewForm(false); loadAll(); }}
              onCancel={() => setShowNewForm(false)}
            />
          )}

          {future.length === 0 && !showNewForm && (
            <p className="text-xs text-muted-foreground italic">
              Keine geplanten Aenderungen. Fuer neue Saetze (z.B. zum Jahreswechsel) auf "Neuer Stichtag" klicken.
            </p>
          )}

          {future.map((r) => (
            <RowEditor
              key={r.id}
              row={r}
              badge={`Geplant ab ${formatDate(r.effective_from)}`}
              badgeTone="blue"
              onSaved={loadAll}
              readonly={false}
              allowDelete={true}
              onDelete={() => handleDelete(r)}
            />
          ))}
        </CardContent>
      </Card>

      {/* Historie */}
      {past.length > 0 && (
        <Card className="bg-card">
          <CardContent className="p-3 space-y-2">
            <button
              type="button"
              onClick={() => setShowHistory((s) => !s)}
              className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            >
              <History className="h-3.5 w-3.5" />
              Historie ({past.length})
              <span className="ml-1 opacity-60">{showHistory ? "▾" : "▸"}</span>
            </button>
            {showHistory && (
              <div className="space-y-2 pt-1">
                {past.map((r) => (
                  <RowEditor
                    key={r.id}
                    row={r}
                    badge={`gueltig ab ${formatDate(r.effective_from)}`}
                    badgeTone="muted"
                    onSaved={loadAll}
                    readonly={true}
                    allowDelete={false}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {ConfirmModalElement}
    </div>
  );
}

// -------------------------------------------------------------------
// RowEditor — rendert eine Zeile mit inline-editierbaren Feldern.
// Fuer readonly=true werden die Felder disabled + kein OK-Button.
// -------------------------------------------------------------------
function RowEditor({
  row, badge, badgeTone, onSaved, readonly, readonlyReason, editWarning, allowDelete, onDelete,
}: {
  row: Row;
  badge: string;
  badgeTone: "green" | "blue" | "muted";
  onSaved: () => void;
  readonly: boolean;
  readonlyReason?: string;
  editWarning?: string;
  allowDelete: boolean;
  onDelete?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => rowToStringMap(row));
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Bei Row-Aenderung von aussen (z.B. nach loadAll) drafts syncen.
  const rowIdRef = useRef(row.id);
  const rowUpdatedRef = useRef(row.updated_at);
  useEffect(() => {
    if (row.id !== rowIdRef.current || row.updated_at !== rowUpdatedRef.current) {
      setDrafts(rowToStringMap(row));
      rowIdRef.current = row.id;
      rowUpdatedRef.current = row.updated_at;
    }
  }, [row]);

  async function saveField(fieldKey: string) {
    if (readonly) return;
    const raw = drafts[fieldKey];
    const parsed = parseFloat((raw ?? "").replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > (fieldKey === "bvg_threshold_chf" ? 999999 : 100)) {
      toast.error("Ungueltiger Wert");
      return;
    }
    const body: Record<string, unknown> = { id: row.id };
    if (fieldKey === "bvg_threshold_chf") {
      body.bvg_threshold_chf = parsed;
    } else {
      body[colOf(fieldKey)] = parsed;
    }
    setSavingKey(fieldKey);
    const res = await fetch("/api/hr/lohn-defaults", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSavingKey(null);
    const json = await res.json();
    if (!res.ok || !json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Gespeichert");
    onSaved();
  }

  const toneClasses = badgeTone === "green"
    ? "bg-green-500/15 text-green-700 dark:text-green-300"
    : badgeTone === "blue"
      ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
      : "bg-muted text-muted-foreground";

  return (
    <div className={readonly ? "opacity-80" : ""}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${toneClasses}`}>
          {badge}
        </span>
        {allowDelete && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="kasten kasten-red"
            data-tooltip="Geplanten Eintrag loeschen"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {readonly && readonlyReason && (
        <p className="text-[10px] text-muted-foreground italic mb-2">{readonlyReason}</p>
      )}
      {!readonly && editWarning && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 italic mb-2 leading-relaxed">{editWarning}</p>
      )}
      <FieldGroup title="Mitarbeiter-Abzuege (%)" fields={AN_FIELDS} drafts={drafts} setDrafts={setDrafts} savingKey={savingKey} onSave={saveField} readonly={readonly} baseValues={rowToStringMap(row)} />
      <FieldGroup title="Arbeitgeber-Anteil (%)" fields={AG_FIELDS} drafts={drafts} setDrafts={setDrafts} savingKey={savingKey} onSave={saveField} readonly={readonly} baseValues={rowToStringMap(row)} />
      <BvgField row={row} drafts={drafts} setDrafts={setDrafts} onSave={saveField} savingKey={savingKey} readonly={readonly} />
    </div>
  );
}

// -------------------------------------------------------------------
// FieldGroup — 6-spaltige Pct-Inputs mit dirty-basiertem OK-Button.
// -------------------------------------------------------------------
function FieldGroup({
  title, fields, drafts, setDrafts, savingKey, onSave, readonly, baseValues,
}: {
  title: string;
  fields: Array<{ key: string; label: string }>;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingKey: string | null;
  onSave: (k: string) => void;
  readonly: boolean;
  baseValues: Record<string, string>;
}) {
  const sum = fields.reduce((s, f) => s + (parseFloat((drafts[f.key] ?? "0").replace(",", ".")) || 0), 0);
  return (
    <div className="space-y-1.5 mt-2">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70 tabular-nums">Σ {fmtPct(sum)}%</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {fields.map((f) => {
          const draft = drafts[f.key] ?? "";
          const dirty = draft !== baseValues[f.key];
          const saving = savingKey === f.key;
          return (
            <div key={f.key} className="space-y-0.5">
              <label className="text-[10px] text-muted-foreground/70 truncate block">{f.label}</label>
              <div className="flex gap-1">
                <div className="relative flex-1 min-w-0">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={draft}
                    onChange={(e) => setDrafts((p) => ({ ...p, [f.key]: e.target.value }))}
                    disabled={readonly}
                    className="h-8 text-xs pr-7"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">%</span>
                </div>
                {dirty && !readonly && (
                  <button
                    type="button"
                    onClick={() => onSave(f.key)}
                    disabled={saving}
                    className="px-2 h-8 text-[10px] font-semibold rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-500/25 transition-colors shrink-0 flex items-center gap-1"
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "OK"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// BvgField — eigenes Feld weil CHF/Monat (nicht %).
// -------------------------------------------------------------------
function BvgField({
  row, drafts, setDrafts, onSave, savingKey, readonly,
}: {
  row: Row;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSave: (k: string) => void;
  savingKey: string | null;
  readonly: boolean;
}) {
  const draft = drafts.bvg_threshold_chf ?? "";
  const dirty = draft !== String(row.bvg_threshold_chf);
  const saving = savingKey === "bvg_threshold_chf";
  return (
    <div className="mt-3 pt-3 border-t border-border">
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground/70 shrink-0">BVG-Eintrittsschwelle (CHF/Monat)</label>
        <div className="relative w-32">
          <Input
            type="text"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDrafts((p) => ({ ...p, bvg_threshold_chf: e.target.value }))}
            disabled={readonly}
            className="h-8 text-xs pr-10"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">CHF</span>
        </div>
        {dirty && !readonly && (
          <button
            type="button"
            onClick={() => onSave("bvg_threshold_chf")}
            disabled={saving}
            className="px-2 h-8 text-[10px] font-semibold rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-500/25 transition-colors shrink-0 flex items-center gap-1"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "OK"}
          </button>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// NewRowForm — legt eine neue Zeile mit einem Stichtag an.
// Baseline (aktuelle Zeile) wird als Vorbelegung uebernommen.
// -------------------------------------------------------------------
function NewRowForm({
  baseline, today, onCreated, onCancel,
}: {
  baseline: Row;
  today: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  // Default-Vorschlag: 1.1. des kommenden Jahres — der haeufigste Fall
  // (SUVA + andere Praemien wechseln zum Jahreswechsel).
  const defaultDate = useMemo(() => {
    const y = Number(today.slice(0, 4));
    return `${y + 1}-01-01`;
  }, [today]);

  const [effectiveFrom, setEffectiveFrom] = useState<string>(defaultDate);
  const [values, setValues] = useState<Record<string, string>>(() => rowToStringMap(baseline));
  const [notes, setNotes] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      toast.error("Gueltiges Datum eingeben");
      return;
    }
    if (effectiveFrom <= today) {
      toast.error(`Datum muss in der Zukunft liegen (nach ${formatDate(today)})`);
      return;
    }
    const body: Record<string, unknown> = { effective_from: effectiveFrom, notes };
    for (const col of PCT_COLUMNS) {
      const key = col.replace(/^default_/, "");
      body[col] = parseFloat((values[key] ?? "0").replace(",", "."));
    }
    body.bvg_threshold_chf = parseFloat((values.bvg_threshold_chf ?? "0").replace(",", "."));
    setSaving(true);
    const res = await fetch("/api/hr/lohn-defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    const json = await res.json();
    if (!res.ok || !json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Neuer Stichtag angelegt");
    onCreated();
  }

  return (
    <div className="p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Gueltig ab</label>
        <input
          type="date"
          value={effectiveFrom}
          min={today}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          className="h-8 text-xs px-2 rounded-md border border-border bg-background"
        />
        <span className="text-[10px] text-muted-foreground/70">
          Vorbelegt mit aktuellen Werten — nur die geaenderten anpassen.
        </span>
      </div>
      <FieldGroup title="Mitarbeiter-Abzuege (%)" fields={AN_FIELDS} drafts={values} setDrafts={setValues} savingKey={null} onSave={() => {}} readonly={false} baseValues={values} />
      <FieldGroup title="Arbeitgeber-Anteil (%)" fields={AG_FIELDS} drafts={values} setDrafts={setValues} savingKey={null} onSave={() => {}} readonly={false} baseValues={values} />
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground/70 shrink-0">BVG-Schwelle</label>
        <div className="relative w-32">
          <Input
            type="text"
            inputMode="decimal"
            value={values.bvg_threshold_chf ?? ""}
            onChange={(e) => setValues((p) => ({ ...p, bvg_threshold_chf: e.target.value }))}
            className="h-8 text-xs pr-10"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">CHF</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground/70 shrink-0">Notiz</label>
        <Input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="z.B. Neue SUVA-Praemie 2027"
          className="h-8 text-xs flex-1"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="kasten kasten-muted" disabled={saving}>
          Abbrechen
        </button>
        <button type="button" onClick={save} disabled={saving} className="kasten kasten-blue">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Anlegen
        </button>
      </div>
    </div>
  );
}

function rowToStringMap(row: Row): Record<string, string> {
  return {
    ahv_iv_eo_pct: String(row.default_ahv_iv_eo_pct),
    alv_pct: String(row.default_alv_pct),
    nbu_pct: String(row.default_nbu_pct),
    bvg_pct: String(row.default_bvg_pct),
    ktg_pct: String(row.default_ktg_pct),
    quellensteuer_pct: String(row.default_quellensteuer_pct),
    employer_ahv_pct: String(row.default_employer_ahv_pct),
    employer_alv_pct: String(row.default_employer_alv_pct),
    employer_fak_pct: String(row.default_employer_fak_pct),
    employer_bu_pct: String(row.default_employer_bu_pct),
    employer_bvg_pct: String(row.default_employer_bvg_pct),
    employer_verwaltung_pct: String(row.default_employer_verwaltung_pct),
    bvg_threshold_chf: String(row.bvg_threshold_chf),
  };
}
