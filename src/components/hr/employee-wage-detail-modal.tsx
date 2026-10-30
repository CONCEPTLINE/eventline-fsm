"use client";

/**
 * Lohn-Detail-Modal pro Mitarbeiter — oeffnet sich beim Klick auf den
 * Namen in der Monatsstunden-Tabelle.
 *
 * Sektionen:
 *   - Stammdaten: Brutto/Netto/Vollkosten/h + Abzüge-Breakdown — NBU nur,
 *     wenn die Person im Bezugsmonat (Monat der Tabelle) NBU-versichert ist
 *     (Art. 13 UVV, gleiche Regel wie die Lohnabrechnung)
 *   - Jahres-Stunden (Stempel/Geplant/Rapport)
 *   - Nachtarbeit-Counter (24/Jahr-Limit) mit Datums-Liste + Zuschlag-Hinweis
 *   - Sonntags-/Feiertagsarbeit-Counter (6/Jahr-Limit) mit Datums-Liste
 *
 * Schweizer ArG-Schwellen werden via Progress-Bar visualisiert: gruen
 * (komfortabel), gelb (>= 80%), rot (>= Limit).
 */

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Loading } from "@/components/ui/spinner";
import { ChevronLeft, ChevronRight, Moon, CalendarDays, Wallet, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";
import { logError } from "@/lib/log";

interface Props {
  open: boolean;
  profileId: string | null;
  initialYear: number;
  /** Bezugsmonat (1–12) fuer den NBU-Status — der Monat der Tabelle. */
  initialMonth: number;
  onClose: () => void;
}

interface DetailResp {
  success: boolean;
  profile: { id: string; full_name: string; role: string; email: string };
  year: number;
  compensation: {
    hourly_wage_chf: number;
    employer_costs_chf_per_hour: number;
    effective_from: string;
    notes: string | null;
    ahv_iv_eo_pct: number;
    alv_pct: number;
    nbu_pct: number;
    bvg_pct: number;
    ktg_pct: number;
    quellensteuer_pct: number;
    /** NBU-Status im Bezugsmonat; nbu_pct wird nur bei versichert abgezogen. */
    nbu: { jahr: number; monat: number; versichert: boolean; hinweis: string };
  } | null;
  /** Bezugsmonat aus dem Rechenkern — dieselben Zahlen wie Lohnabrechnung
   *  und Monatstabelle. Bei `fehler` sind die Beträge null. */
  monat?: {
    jahr: number;
    monat: number;
    fehler: string | null;
    minuten: number;
    brutto: number | null;
    netto: number | null;
    total_abzuege: number | null;
    /** Phase 4: Spesen-Zusatzposten (nach dem Netto) und Auszahlung = Netto + Spesen. */
    spesen?: number | null;
    auszahlungsbetrag?: number | null;
    positionen: MonatsPosition[];
    hinweise: string[];
  };
  hours: { stempel_minutes: number; geplant_minutes: number; rapport_minutes: number };
  night: {
    count: number; limit: number;
    dates: DayWithEntries[];
    surcharge_pct: number;
    note: string;
  };
  sunday_holiday: {
    count: number; limit: number;
    dates: DayWithEntries[];
    surcharge_pct: number;
    note: string;
  };
  base_wage_for_surcharge: number;
}

interface MonatsPosition {
  lohnart: string;
  bezeichnung: string;
  minuten: number | null;
  ansatz: number | null;
  prozent: number | null;
  basis: number | null;
  betrag: number;
}

interface DayWithEntries {
  date: string;
  label?: string;
  entries: { entry_number: number; start_local: string; end_local: string }[];
}

const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function fmtHours(min: number): string {
  if (min === 0) return "0 h";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtDate(iso: string): string {
  // iso ist YYYY-MM-DD (DATE-Spalte) — Date-Mittag UTC + timeZone-Render
  // sind TZ-safe.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", weekday: "short" });
}

export function EmployeeWageDetailModal({ open, profileId, initialYear, initialMonth, onClose }: Props) {
  const [year, setYear] = useState(initialYear);
  const [data, setData] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setYear(initialYear); }, [initialYear, profileId]);

  useEffect(() => {
    // Beim Profile-Wechsel sofort den alten Datensatz wegwerfen — sonst
    // flackert kurz der vorherige Mitarbeiter durch bis das neue Fetch
    // ankommt (Title nutzt data.profile.full_name).
    setData(null);
    if (!open || !profileId) return;
    setLoading(true);
    let cancelled = false;
    fetch(`/api/hr/employee-detail?profile_id=${profileId}&year=${year}&month=${initialMonth}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) setData(json as DetailResp);
        else setData(null);
      })
      .catch((err) => {
        if (cancelled) return;
        logError("employee-wage-detail-modal.load", err, { profileId, year });
        toast.error("Netzwerkfehler beim Laden der Lohn-Details");
        setData(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, profileId, year, initialMonth]);

  return (
    <Modal open={open} onClose={onClose} title={data?.profile.full_name ? `${data.profile.full_name} — Lohn-Details` : "Lohn-Details"} size="lg">
      {!profileId ? null : loading ? (
        <Loading />
      ) : !data ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Keine Daten</p>
      ) : (
        <div className="space-y-4">
          {/* Year-Navigation */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">{data.profile.role} · {data.profile.email}</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setYear((y) => y - 1)} className="p-1 rounded hover:bg-foreground/[0.05]">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-semibold tabular-nums min-w-[3rem] text-center">{year}</span>
              <button type="button" onClick={() => setYear((y) => y + 1)} className="p-1 rounded hover:bg-foreground/[0.05]">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Stammdaten */}
          <Section title="Lohn-Stammdaten" icon={<Wallet className="h-3.5 w-3.5" />}>
            {data.compensation ? (
              <Stammdaten c={data.compensation} />
            ) : (
              <p className="text-xs text-muted-foreground">Noch keine Lohn-Daten hinterlegt.</p>
            )}
          </Section>

          {/* Bezugsmonat (Monat der Tabelle) — Positionen aus dem Rechenkern */}
          {data.monat && <Bezugsmonat m={data.monat} />}

          {/* Jahres-Stunden */}
          <Section title={`Jahres-Stunden ${year}`}>
            <div className="grid grid-cols-3 gap-2">
              <KpiBox label="Stempel" value={fmtHours(data.hours.stempel_minutes)} />
              <KpiBox label="Geplant" value={fmtHours(data.hours.geplant_minutes)} />
              <KpiBox label="Rapport" value={fmtHours(data.hours.rapport_minutes)} />
            </div>
          </Section>

          {/* Nachtarbeit-Counter */}
          <Section title="Nachtarbeit (23:00 – 06:00)" icon={<Moon className="h-3.5 w-3.5" />}>
            <CounterCard
              count={data.night.count}
              limit={data.night.limit}
              surchargePct={data.night.surcharge_pct}
              note={data.night.note}
              baseWage={data.base_wage_for_surcharge}
            />
            {data.night.dates.length > 0 && (
              <DateList dates={data.night.dates} />
            )}
          </Section>

          {/* Sonntag/Feiertag-Counter */}
          <Section title="Sonntags- & Feiertagsarbeit" icon={<CalendarDays className="h-3.5 w-3.5" />}>
            <CounterCard
              count={data.sunday_holiday.count}
              limit={data.sunday_holiday.limit}
              surchargePct={data.sunday_holiday.surcharge_pct}
              note={data.sunday_holiday.note}
              baseWage={data.base_wage_for_surcharge}
            />
            {data.sunday_holiday.dates.length > 0 && (
              <DateList dates={data.sunday_holiday.dates} />
            )}
          </Section>
        </div>
      )}
    </Modal>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function KpiBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 rounded-lg bg-foreground/[0.03] dark:bg-foreground/[0.06] border border-border">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

function Stammdaten({ c }: { c: NonNullable<DetailResp["compensation"]> }) {
  // NBU nur, wenn die Person im Bezugsmonat NBU-versichert ist (Art. 13 UVV).
  const nbuAbzug = c.nbu.versichert ? c.nbu_pct : 0;
  const totalDed = c.ahv_iv_eo_pct + c.alv_pct + nbuAbzug + c.bvg_pct + c.ktg_pct + c.quellensteuer_pct;
  const nbuMonatLabel = `${MONATE[c.nbu.monat - 1] ?? ""} ${c.nbu.jahr}`;
  const netto = c.hourly_wage_chf * (1 - totalDed / 100);
  const vollkosten = c.hourly_wage_chf + c.employer_costs_chf_per_hour;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <KpiBox label="Brutto / h" value={`CHF ${CHF.format(c.hourly_wage_chf)}`} />
        <KpiBox label="Netto / h" value={`CHF ${CHF.format(netto)}`} />
        <KpiBox label="Vollkosten / h" value={`CHF ${CHF.format(vollkosten)}`} />
      </div>
      <div className="px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04] text-xs">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Abzüge (% vom Brutto)</p>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1">
          <DedRow label="AHV/IV/EO" value={c.ahv_iv_eo_pct} />
          <DedRow label="ALV" value={c.alv_pct} />
          <DedRow label="NBU" value={nbuAbzug} />
          <DedRow label="BVG" value={c.bvg_pct} />
          <DedRow label="KTG" value={c.ktg_pct} />
          <DedRow label="Quellensteuer" value={c.quellensteuer_pct} />
        </div>
        <div className="flex items-baseline justify-between mt-1.5 pt-1.5 border-t border-foreground/10 font-semibold">
          <span>Total Abzüge</span>
          <span className="tabular-nums">{PCT.format(totalDed)}%</span>
        </div>
        {c.nbu_pct > 0 && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            NBU {nbuMonatLabel}: {c.nbu.hinweis}
          </p>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Gültig ab {new Date(c.effective_from + "T12:00:00Z").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
        {c.notes && <> · {c.notes}</>}
      </p>
    </div>
  );
}

/** «h:mm» für Positions-Mengen (Minuten). */
function fmtHm(min: number): string {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function Bezugsmonat({ m }: { m: NonNullable<DetailResp["monat"]> }) {
  const label = `${MONATE[m.monat - 1] ?? ""} ${m.jahr}`;
  return (
    <div className="px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04] text-xs space-y-1.5">
      <p className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bezugsmonat {label}:</span>
        {m.fehler ? (
          <span className="text-muted-foreground">nicht gerechnet</span>
        ) : (
          <span className="tabular-nums">
            Brutto <strong>CHF {CHF.format(m.brutto ?? 0)}</strong>
            {m.total_abzuege != null && <span className="text-muted-foreground"> · Abzüge CHF {CHF.format(m.total_abzuege)}</span>}
            {" · "}Netto <strong className="text-emerald-700 dark:text-emerald-300">CHF {CHF.format(m.netto ?? 0)}</strong>
            {m.spesen ? (
              <span className="text-muted-foreground"> · Spesen CHF {CHF.format(m.spesen)} · Auszahlung <strong className="text-foreground">CHF {CHF.format(m.auszahlungsbetrag ?? 0)}</strong></span>
            ) : null}
          </span>
        )}
      </p>
      {m.fehler && (
        <p className="flex items-start gap-1.5 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/[0.08] px-2 py-1 text-red-700 dark:text-red-300">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{m.fehler}</span>
        </p>
      )}
      {m.positionen.length > 0 && (
        <div className="space-y-0.5">
          {m.positionen.map((p, i) => (
            <div key={`${p.lohnart}-${i}`} className="grid grid-cols-[minmax(0,1fr)_56px_96px] gap-x-2 items-baseline">
              <span className="truncate text-muted-foreground">{p.bezeichnung}</span>
              <span className="text-right tabular-nums text-muted-foreground">{p.minuten != null ? fmtHm(p.minuten) : ""}</span>
              <span className="text-right tabular-nums">CHF {CHF.format(p.betrag)}</span>
            </div>
          ))}
        </div>
      )}
      {m.hinweise.length > 0 && (
        <ul className="space-y-0.5 text-[10px] text-muted-foreground">
          {m.hinweise.map((h, i) => (
            <li key={i} className="flex items-start gap-1"><Info className="h-3 w-3 mt-px shrink-0" />{h}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DedRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{PCT.format(value)}%</span>
    </div>
  );
}

function CounterCard({ count, limit, surchargePct, note, baseWage }: {
  count: number; limit: number; surchargePct: number; note: string; baseWage: number;
}) {
  const pct = Math.min(100, (count / limit) * 100);
  const remaining = Math.max(0, limit - count);
  const tone = count >= limit ? "red" : count / limit >= 0.8 ? "amber" : "green";
  const toneClasses = {
    green: { bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-200 dark:border-emerald-500/30", bg: "bg-emerald-50 dark:bg-emerald-500/10" },
    amber: { bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-300", border: "border-amber-200 dark:border-amber-500/30", bg: "bg-amber-50 dark:bg-amber-500/10" },
    red:   { bar: "bg-red-500",   text: "text-red-700 dark:text-red-300",         border: "border-red-200 dark:border-red-500/30",         bg: "bg-red-50 dark:bg-red-500/10" },
  }[tone];
  const surchargeAmount = baseWage * (surchargePct / 100);

  return (
    <div className={`px-3 py-2 rounded-lg border ${toneClasses.border} ${toneClasses.bg} space-y-2`}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className={`text-lg font-bold tabular-nums ${toneClasses.text}`}>
            {count} <span className="text-xs font-normal text-muted-foreground">/ {limit} Einsätze</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {remaining > 0 ? `Noch ${remaining} Einsätze mit ${surchargePct}% Zuschlag möglich` : `Limit erreicht — ab jetzt anderer Modus`}
          </p>
        </div>
        {baseWage > 0 && (
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{surchargePct}% Zuschlag</p>
            <p className="text-xs font-semibold tabular-nums">+ CHF {CHF.format(surchargeAmount)} / h</p>
          </div>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
        <div className={`h-full ${toneClasses.bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[10px] text-muted-foreground flex items-start gap-1">
        {count >= limit && <AlertTriangle className="h-3 w-3 mt-0.5 text-red-600 dark:text-red-400 shrink-0" />}
        <span>{note}</span>
      </p>
    </div>
  );
}

function DateList({ dates }: { dates: DayWithEntries[] }) {
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <ul className="text-xs divide-y divide-foreground/5">
        {dates.map((d) => (
          <li key={d.date} className="px-3 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{fmtDate(d.date)}</span>
              {d.label && <span className="text-[10px] text-muted-foreground">{d.label}</span>}
            </div>
            {d.entries.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-3 border-l border-foreground/10">
                {d.entries.map((e) => (
                  <li key={e.entry_number} className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
                    <code className="text-[10px] tabular-nums text-foreground/60">STM-{String(e.entry_number).padStart(5, "0")}</code>
                    <span className="tabular-nums">{e.start_local}–{e.end_local}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
