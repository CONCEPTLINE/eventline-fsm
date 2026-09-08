"use client";

/**
 * Mitarbeiter-Lohn-Tab: zentrale Liste aller MA mit ihrem aktuellen
 * Lohn-Status. Klick auf einen MA oeffnet den Lohn-Editor (Modal) —
 * dort wird Brutto-Stundenlohn + Standard-vs-Override + die 12 Pcts
 * gepflegt.
 *
 * MA ohne Lohn-Zeile bekommen einen 'Lohn nicht hinterlegt'-Hinweis +
 * Direct-Edit-Button. So sieht der Admin auf einen Blick wo Daten
 * fehlen.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Wallet, AlertTriangle, Pencil, Calendar as CalendarIcon, TrendingUp, Trash2, History, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { todayLocalIso, localDateIso } from "@/lib/swiss-time";
import { Loading } from "@/components/ui/spinner";
import {
  PCT_EMPTY,
  PCT_KEYS,
  DEFAULTS_FALLBACK,
  defaultsToPctMap,
  EditablePctGroup,
  ReadonlyPctGroup,
  LohnPreview,
  CHF,
  AN_FIELDS,
  AG_FIELDS,
  type PctMap,
} from "@/components/hr/loehne/lohn-shared";

interface CompRow {
  id: string;
  hourly_wage_chf: number;
  uses_standard_lohn: boolean;
  /** True = MA wird nicht entgeltet (Inhaber/Praktikant/ehrenamtl.) und
   *  erscheint nicht in der Lohntabelle. */
  wage_exempt: boolean;
  auto_lohnabrechnung: boolean;
  effective_from: string;
  notes: string | null;
  ahv_iv_eo_pct: number | null;
  alv_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ktg_pct: number | null;
  quellensteuer_pct: number | null;
  employer_ahv_pct: number | null;
  employer_alv_pct: number | null;
  employer_fak_pct: number | null;
  employer_bu_pct: number | null;
  employer_bvg_pct: number | null;
  employer_verwaltung_pct: number | null;
  ferienanteil_pct_override: number | null;
}

/** Naechste GEPLANTE Lohn-Zeile (effective_from > heute) — fuer die
 *  "Erhoehung ab X"-Anzeige. Kommt aus dem GET als next_compensation. */
interface NextCompRow {
  id: string;
  hourly_wage_chf: number;
  wage_exempt: boolean;
  effective_from: string;
  notes: string | null;
}

interface EmployeeRow {
  profile_id: string;
  full_name: string;
  role: string;
  email: string;
  birthdate?: string | null;
  compensation: CompRow | null;
  next_compensation: NextCompRow | null;
}

interface HistoryRow {
  id: string;
  hourly_wage_chf: number;
  wage_exempt: boolean;
  uses_standard_lohn: boolean;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** 1. Tag des Folgemonats als YYYY-MM-DD (Zurich-Kalender). */
function firstOfNextMonthIso(): string {
  const [y, m] = todayLocalIso().split("-").map(Number);
  return localDateIso(new Date(Date.UTC(y, m, 1, 12)));
}

/** 1. Tag des LAUFENDEN Monats (Zurich) — frueheste erlaubte Erhoehung.
 *  Rueckwirkend in den laufenden Monat ist safe: der wird erst 7 Tage
 *  nach Monatsende abgerechnet (Cron), es existiert also noch keine PDF
 *  die von der Aenderung abweichen koennte. Weiter zurueck bleibt gesperrt. */
function firstOfCurrentMonthIso(): string {
  const [y, m] = todayLocalIso().split("-");
  return `${y}-${m}-01`;
}

export function MitarbeiterLohnTab() {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [defaults, setDefaults] = useState<PctMap>(DEFAULTS_FALLBACK);
  const [loading, setLoading] = useState(true);
  const [editFor, setEditFor] = useState<EmployeeRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/hr/compensation");
    if (res.ok) {
      const json = await res.json();
      if (json.success) {
        setEmployees(json.employees as EmployeeRow[]);
        if (json.defaults) setDefaults(defaultsToPctMap(json.defaults));
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4" /> Mitarbeiter-Lohn
        </h2>
        <p className="text-xs text-muted-foreground">
          Brutto-Stundenlohn + Abzüge pro Mitarbeiter. Default: Firmen-Standardwerte greifen automatisch (kein Override nötig).
        </p>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              <div className="hidden md:grid items-center gap-x-2 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                style={{ gridTemplateColumns: "minmax(0, 1.5fr) 100px 120px 90px 120px" }}>
                <div>Mitarbeiter</div>
                <div className="text-right">Brutto/h</div>
                <div className="text-center">Lohn-Modus</div>
                <div className="text-center">Gültig ab</div>
                <div className="text-right">Aktion</div>
              </div>
              {employees.map((e) => {
                const hasComp = e.compensation != null;
                const isExempt = hasComp && e.compensation!.wage_exempt;
                const noBirthdate = !e.birthdate;
                return (
                  <div
                    key={e.profile_id}
                    onClick={() => setEditFor(e)}
                    className={`grid items-center gap-x-2 px-4 py-2.5 text-sm hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06] cursor-pointer transition-colors ${isExempt ? "opacity-70" : ""}`}
                    style={{ gridTemplateColumns: "minmax(0, 1.5fr) 100px 120px 90px 120px" }}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate flex items-center gap-2 flex-wrap">
                        {e.full_name}
                        {!hasComp && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">
                            <AlertTriangle className="h-2.5 w-2.5" /> Lohn fehlt
                          </span>
                        )}
                        {isExempt && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-foreground/[0.08] text-muted-foreground"
                            data-tooltip="Kein Lohn — erscheint nicht in der Monats-Lohntabelle."
                          >
                            Nicht entgeltet
                          </span>
                        )}
                        {e.next_compensation && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-foreground/[0.08] text-muted-foreground tabular-nums"
                            data-tooltip={e.next_compensation.notes ? `Geplante Lohnänderung — ${e.next_compensation.notes}` : "Geplante Lohnänderung"}
                          >
                            <CalendarIcon className="h-2.5 w-2.5" />
                            ab {fmtDateShort(e.next_compensation.effective_from)}: CHF {CHF.format(e.next_compensation.hourly_wage_chf)}
                          </span>
                        )}
                        {noBirthdate && hasComp && !isExempt && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                            data-tooltip="Geburtsdatum fehlt — Ferienanteil-Berechnung nimmt Default 8.33% an (Erwachsen). Für U20 wäre das falsch (10.64%)."
                          >
                            <AlertTriangle className="h-2.5 w-2.5" /> Geburtstag fehlt
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">{e.role}</div>
                    </div>
                    <div className="text-right tabular-nums">
                      {isExempt ? (
                        <span className="text-muted-foreground text-[11px]">—</span>
                      ) : hasComp ? (
                        `CHF ${CHF.format(e.compensation!.hourly_wage_chf)}`
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                    <div className="text-center">
                      {isExempt ? (
                        <span className="text-muted-foreground text-[10px]">—</span>
                      ) : hasComp ? (
                        e.compensation!.uses_standard_lohn ? (
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                            Standard
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
                            Override
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground text-[10px]">—</span>
                      )}
                    </div>
                    <div className="text-center text-xs text-muted-foreground tabular-nums">
                      {hasComp ? new Date(e.compensation!.effective_from).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "2-digit" }) : "—"}
                    </div>
                    <div className="text-right">
                      <button
                        type="button"
                        onClick={(ev) => { ev.stopPropagation(); setEditFor(e); }}
                        className="kasten kasten-muted text-xs"
                      >
                        <Pencil className="h-3 w-3" />Bearbeiten
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <LohnEditorModal
        employee={editFor}
        defaults={defaults}
        onClose={() => setEditFor(null)}
        onSaved={() => { setEditFor(null); load(); }}
      />
    </div>
  );
}

/** Lohn-Editor: Brutto + uses_standard_lohn-Toggle + 12 Pcts wenn Override. */
function LohnEditorModal({ employee, defaults, onClose, onSaved }: {
  employee: EmployeeRow | null;
  defaults: PctMap;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [wage, setWage] = useState("");
  const [usesStandard, setUsesStandard] = useState(true);
  const [wageExempt, setWageExempt] = useState(false);
  const [autoLohnabrechnung, setAutoLohnabrechnung] = useState(true);
  const [pcts, setPcts] = useState<PctMap>(PCT_EMPTY);
  const [from, setFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // "Lohnerhoehung planen"-Abschnitt
  const [raiseWage, setRaiseWage] = useState("");
  const [raiseFrom, setRaiseFrom] = useState(firstOfNextMonthIso);
  const [raiseNote, setRaiseNote] = useState("");
  const [savingRaise, setSavingRaise] = useState(false);
  const [deletingRaise, setDeletingRaise] = useState(false);
  // Historie (lazy geladen beim Aufklappen)
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  useEffect(() => {
    if (!employee) return;
    // Plan-/Historie-State pro MA zuruecksetzen.
    setRaiseWage("");
    setRaiseFrom(firstOfNextMonthIso());
    setRaiseNote("");
    setShowHistory(false);
    setHistory(null);
    const c = employee.compensation;
    setFrom(c?.effective_from ?? todayLocalIso());
    setNotes(c?.notes ?? "");
    setWageExempt(c?.wage_exempt === true);
    setAutoLohnabrechnung(c?.auto_lohnabrechnung !== false);
    setWage(c?.hourly_wage_chf != null && c?.wage_exempt !== true ? String(c.hourly_wage_chf) : "");
    setUsesStandard(c?.uses_standard_lohn !== false);
    if (c) {
      const fill = (v: number | null) => v == null ? "" : String(v);
      setPcts({
        ahv_iv_eo_pct: fill(c.ahv_iv_eo_pct),
        alv_pct: fill(c.alv_pct),
        nbu_pct: fill(c.nbu_pct),
        bvg_pct: fill(c.bvg_pct),
        ktg_pct: fill(c.ktg_pct),
        quellensteuer_pct: fill(c.quellensteuer_pct),
        employer_ahv_pct: fill(c.employer_ahv_pct),
        employer_alv_pct: fill(c.employer_alv_pct),
        employer_fak_pct: fill(c.employer_fak_pct),
        employer_bu_pct: fill(c.employer_bu_pct),
        employer_bvg_pct: fill(c.employer_bvg_pct),
        employer_verwaltung_pct: fill(c.employer_verwaltung_pct),
      });
    } else {
      setPcts(PCT_EMPTY);
    }
  }, [employee]);

  async function save() {
    if (!employee) return;
    // Bei wage_exempt=true wird die Zahl ignoriert (Server setzt 0).
    let w = 0;
    if (!wageExempt) {
      w = parseFloat(wage.replace(",", "."));
      if (!Number.isFinite(w) || w < 0) {
        toast.error("Brutto-Stundenlohn ungültig");
        return;
      }
    }
    const pctOrNull = (s: string): number | null => {
      const n = parseFloat(s.replace(",", "."));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
    };
    const pctPayload: Record<string, number | null> = {};
    for (const k of PCT_KEYS) pctPayload[k] = usesStandard ? null : pctOrNull(pcts[k]);

    setSaving(true);
    const res = await fetch("/api/hr/compensation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: employee.profile_id,
        hourly_wage_chf: w,
        uses_standard_lohn: usesStandard,
        wage_exempt: wageExempt,
        auto_lohnabrechnung: autoLohnabrechnung,
        effective_from: from,
        notes: notes.trim() || null,
        ...pctPayload,
      }),
    });
    setSaving(false);
    const json = await res.json();
    if (!res.ok || !json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Lohn gespeichert");
    onSaved();
  }

  /** Erhoehung anlegen — ab Zukunftsdatum (geplant) ODER rueckwirkend bis
   *  zum 1. des laufenden Monats (greift dann sofort fuer diesen Monat).
   *  Erbt die aktuellen Abzugs-Einstellungen (Standard/Override + Pcts +
   *  Auto-Lohnabrechnung + Ferienanteil-Override) — nur Lohn + Datum +
   *  Notiz sind neu. */
  async function planRaise() {
    if (!employee) return;
    const w = parseFloat(raiseWage.replace(",", "."));
    if (!Number.isFinite(w) || w < 0) {
      toast.error("Neuer Stundenlohn ungültig");
      return;
    }
    if (!raiseFrom || raiseFrom < firstOfCurrentMonthIso()) {
      toast.error("Das Gültig-ab-Datum darf frühestens der 1. des laufenden Monats sein — frühere Monate sind bereits abgerechnet.");
      return;
    }
    // Gleicher Tag wie der Beginn der aktuellen Lohn-Zeile: das waere eine
    // Korrektur, kein Roll-over — dafuer ist der Editor oben da. Klare
    // Meldung statt stillem Ueberschreiben der bestehenden Zeile.
    if (employee.compensation && raiseFrom === employee.compensation.effective_from) {
      toast.error(`Die aktuelle Lohn-Zeile beginnt bereits am ${fmtDateShort(raiseFrom)}. Für eine Korrektur den Lohn oben im Editor ändern und speichern.`);
      return;
    }
    const pctOrNull = (s: string): number | null => {
      const n = parseFloat(s.replace(",", "."));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
    };
    const pctPayload: Record<string, number | null> = {};
    for (const k of PCT_KEYS) pctPayload[k] = usesStandard ? null : pctOrNull(pcts[k]);

    setSavingRaise(true);
    const res = await fetch("/api/hr/compensation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: employee.profile_id,
        hourly_wage_chf: w,
        uses_standard_lohn: usesStandard,
        wage_exempt: false,
        auto_lohnabrechnung: autoLohnabrechnung,
        effective_from: raiseFrom,
        notes: raiseNote.trim() || null,
        ferienanteil_pct_override: employee.compensation?.ferienanteil_pct_override ?? null,
        ...pctPayload,
      }),
    });
    setSavingRaise(false);
    const json = await res.json();
    if (!res.ok || !json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success(
      raiseFrom <= todayLocalIso()
        ? `Lohn erhöht: CHF ${CHF.format(w)} ab ${fmtDateShort(raiseFrom)} (gilt bereits für diesen Monat)`
        : `Lohnerhöhung geplant: CHF ${CHF.format(w)} ab ${fmtDateShort(raiseFrom)}`,
    );
    onSaved();
  }

  /** Geplante Erhoehung loeschen — der bisherige Lohn laeuft weiter. */
  async function deleteRaise() {
    if (!employee?.next_compensation) return;
    setDeletingRaise(true);
    const res = await fetch(`/api/hr/compensation?id=${employee.next_compensation.id}`, { method: "DELETE" });
    setDeletingRaise(false);
    const json = await res.json();
    if (!res.ok || !json.success) {
      TOAST.errorOr(json.error);
      return;
    }
    toast.success("Geplante Lohnänderung gelöscht — der bisherige Lohn läuft weiter");
    onSaved();
  }

  async function toggleHistory() {
    if (!employee) return;
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) {
      const res = await fetch(`/api/hr/compensation/history?profile_id=${employee.profile_id}`);
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) setHistory(json.history as HistoryRow[]);
      else setHistory([]);
    }
  }

  if (!employee) return null;
  const nextComp = employee.next_compensation;
  const hasComp = employee.compensation != null;
  // Warnung bei krummem Erhoehungs-Datum: die Abrechnung rechnet monatsweise
  // (Lohn-Zeile die am Monatsanfang gilt) — ein 15. greift erst ab Folgemonat.
  const raiseDayNotFirst = raiseFrom.length === 10 && !raiseFrom.endsWith("-01");

  return (
    <Modal open={!!employee} onClose={() => !saving && onClose()} title={`Lohn — ${employee.full_name}`} size="md">
      <div className="space-y-4">
        {!employee.birthdate && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Geburtsdatum fehlt</p>
              <p className="opacity-80 mt-0.5">
                Ferienanteil wird mit 8.33% (Erwachsene) berechnet. Falls der MA unter 20 Jahre alt ist,
                wäre das falsch (10.64%). Bitte in{" "}
                <a href="/einstellungen?tab=team" className="underline">Einstellungen → Team</a> nachpflegen.
              </p>
            </div>
          </div>
        )}
        {/* Wird-nicht-entgeltet-Toggle. Wenn an: Lohn-Input + Abzuege-
            Sektion + Preview verschwinden; der MA wird nicht mehr in der
            Monats-Lohntabelle angezeigt. */}
        <label className="flex items-start gap-2 p-3 rounded-lg border border-border bg-muted/40 cursor-pointer">
          <input
            type="checkbox"
            checked={wageExempt}
            onChange={(e) => setWageExempt(e.target.checked)}
            className="h-3.5 w-3.5 mt-0.5"
          />
          <div className="min-w-0">
            <span className="text-sm font-medium">Wird nicht entgeltet</span>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Für Inhaber, ehrenamtliche Helfer, unbezahlte Praktikanten. Der Mitarbeiter erscheint dann nicht in der Monats-Lohntabelle.
            </p>
          </div>
        </label>

        {/* Auto-Lohnabrechnung — Cron erstellt 7 Tage nach Monatsende die
            PDF fuer den abgeschlossenen Monat. Bei wage_exempt sinnlos,
            deswegen ausgeblendet. */}
        {!wageExempt && (
          <label className="flex items-start gap-2 p-3 rounded-lg border border-border bg-muted/40 cursor-pointer">
            <input
              type="checkbox"
              checked={autoLohnabrechnung}
              onChange={(e) => setAutoLohnabrechnung(e.target.checked)}
              className="h-3.5 w-3.5 mt-0.5"
            />
            <div className="min-w-0">
              <span className="text-sm font-medium">Lohnabrechnung automatisch erstellen</span>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                7 Tage nach Monatsende wird die PDF für den abgeschlossenen Monat automatisch generiert — auch bei 0 Stunden.
                Bereits vorhandene Abrechnungen werden nicht überschrieben.
              </p>
            </div>
          </label>
        )}

        {!wageExempt && (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Brutto-Stundenlohn (CHF/h, inkl. Ferienanteil)</p>
            <Input
              type="text"
              inputMode="decimal"
              value={wage}
              onChange={(e) => setWage(e.target.value)}
              placeholder="z.B. 22.50"
              autoFocus
            />
          </div>
        )}

        {!wageExempt && (
          <>
            <div className="flex items-center justify-between pt-2 border-t border-foreground/10">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Lohn-Abzüge &amp; AG-Anteil
              </p>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={usesStandard}
                  onChange={(e) => setUsesStandard(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                <span>Firmen-Standard verwenden</span>
              </label>
            </div>

            {usesStandard ? (
              <div className="space-y-3">
                <ReadonlyPctGroup title="Mitarbeiter-Abzüge" fields={AN_FIELDS} values={defaults} />
                <ReadonlyPctGroup title="Arbeitgeber-Anteil" fields={AG_FIELDS} values={defaults} />
                <p className="text-[10px] text-muted-foreground/70 italic">
                  Die 12 Werte werden firmenweit im Standardwerte-Tab gesetzt.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <EditablePctGroup title="Mitarbeiter-Abzüge" fields={AN_FIELDS} values={pcts} setValues={setPcts} defaults={defaults} />
                <EditablePctGroup title="Arbeitgeber-Anteil" fields={AG_FIELDS} values={pcts} setValues={setPcts} defaults={defaults} />
              </div>
            )}

            <LohnPreview wage={wage} values={usesStandard ? defaults : pcts} />
          </>
        )}

        {hasComp ? (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz (optional)</p>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="z.B. 'Korrektur Tippfehler'" maxLength={200} />
            <p className="text-[10px] text-muted-foreground/70 ml-1">
              Speichern korrigiert die aktuelle Lohn-Zeile rückwirkend ab {from ? fmtDateShort(from) : "—"}.
              Für eine Erhöhung ab einem künftigen Datum den Abschnitt unten verwenden.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Gültig ab</p>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz (optional)</p>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="z.B. 'Startlohn'" maxLength={200} />
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">
            Abbrechen
          </button>
          <button type="button" onClick={save} disabled={saving || (!wageExempt && !wage)} className="kasten kasten-red flex-1">
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </div>

        {/* ─── Lohnerhoehung planen ───────────────────────────────────
            Sichtbar wenn der MA eine Lohn-Zeile hat ODER eine geplante
            existiert (letzteres damit der Loesch-Button immer erreichbar
            ist — auch beim Randfall "Erst-Anlage mit Zukunftsdatum").
            Genau EINE geplante Aenderung gleichzeitig (Server erzwingt das). */}
        {(hasComp || nextComp) && !wageExempt && (
          <div className="pt-3 border-t border-foreground/10 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3" />
              Lohnerhöhung planen
            </p>

            {nextComp ? (
              <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-muted/40 text-sm">
                <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="tabular-nums font-medium">CHF {CHF.format(nextComp.hourly_wage_chf)}/h</span>
                <span className="text-muted-foreground text-xs">ab {fmtDateShort(nextComp.effective_from)}</span>
                {nextComp.notes && <span className="text-muted-foreground text-xs italic truncate flex-1">· {nextComp.notes}</span>}
                {!nextComp.notes && <span className="flex-1" />}
                <button
                  type="button"
                  onClick={deleteRaise}
                  disabled={deletingRaise}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 shrink-0 disabled:opacity-50"
                  data-tooltip="Geplante Änderung löschen — bisheriger Lohn läuft weiter"
                  aria-label="Geplante Änderung löschen"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : hasComp ? (
              <>
                <div className="flex flex-wrap items-end gap-1.5">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">CHF</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={raiseWage}
                      onChange={(e) => setRaiseWage(e.target.value)}
                      placeholder="0.00"
                      className="w-20 px-1.5 py-1 text-xs rounded border bg-background tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-ring/40"
                    />
                    <span className="text-[10px] text-muted-foreground">/h ab</span>
                  </div>
                  <input
                    type="date"
                    value={raiseFrom}
                    min={firstOfCurrentMonthIso()}
                    onChange={(e) => setRaiseFrom(e.target.value)}
                    className="w-32 px-1.5 py-1 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring/40"
                  />
                  <input
                    type="text"
                    value={raiseNote}
                    onChange={(e) => setRaiseNote(e.target.value)}
                    placeholder="Notiz (z.B. Lohnrunde 2027)"
                    maxLength={200}
                    className="flex-1 min-w-[110px] px-1.5 py-1 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring/40"
                  />
                  <button
                    type="button"
                    onClick={planRaise}
                    disabled={savingRaise || !raiseWage}
                    className="kasten kasten-red text-xs"
                  >
                    {savingRaise ? "Speichert…" : "Planen"}
                  </button>
                </div>
                {raiseDayNotFirst ? (
                  <p className="text-[10px] text-amber-700 dark:text-amber-300">
                    Hinweis: Die Abrechnung rechnet monatsweise — ein Datum mitten im Monat greift erst ab dem Folgemonat. Empfohlen: 1. des Monats.
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground/70">
                    Ab dem Datum gilt der neue Lohn. Frühere Monate und Abrechnungen bleiben beim bisherigen Lohn.
                  </p>
                )}
              </>
            ) : null}

            {/* Historie: lazy geladen, kompakte Zeilen */}
            <button
              type="button"
              onClick={toggleHistory}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <History className="h-3 w-3" />
              Lohn-Historie
              {showHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {showHistory && (
              history === null ? (
                <p className="text-[10px] text-muted-foreground italic">Lade…</p>
              ) : history.length === 0 ? (
                <p className="text-[10px] text-muted-foreground italic">Keine Historie.</p>
              ) : (
                <div className="space-y-0.5">
                  {history.map((h) => {
                    const current = h.effective_to === null && h.effective_from <= todayLocalIso();
                    const planned = h.effective_from > todayLocalIso();
                    return (
                      <div key={h.id} className="flex items-center gap-2 px-1 py-0.5 text-[11px]">
                        {planned ? (
                          <CalendarIcon className="h-3 w-3 text-muted-foreground shrink-0" data-tooltip="Geplant" />
                        ) : (
                          <span className="w-3 h-3 shrink-0" />
                        )}
                        <span className={`tabular-nums shrink-0 ${current ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                          {h.wage_exempt ? "nicht entgeltet" : `CHF ${CHF.format(h.hourly_wage_chf)}/h`}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          {fmtDateShort(h.effective_from)}
                          {h.effective_to ? ` — ${fmtDateShort(h.effective_to)}` : ""}
                        </span>
                        {h.notes && <span className="text-muted-foreground/70 italic truncate">· {h.notes}</span>}
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
