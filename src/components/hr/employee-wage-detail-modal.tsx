"use client";

/**
 * Lohn-Detail-Modal pro Mitarbeiter — oeffnet sich beim Klick auf den
 * Namen in der Monatsstunden-Tabelle.
 *
 * Sektionen:
 *   - Stammdaten: Brutto/Netto/Vollkosten/h + Abzuegen-Breakdown
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
import { ChevronLeft, ChevronRight, Moon, CalendarDays, Wallet, AlertTriangle } from "lucide-react";

interface Props {
  open: boolean;
  profileId: string | null;
  initialYear: number;
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
  } | null;
  hours: { stempel_minutes: number; geplant_minutes: number; rapport_minutes: number };
  night: {
    count: number; limit: number;
    dates: { date: string; entries: number }[];
    surcharge_pct: number;
    note: string;
  };
  sunday_holiday: {
    count: number; limit: number;
    dates: { date: string; label: string }[];
    surcharge_pct: number;
    note: string;
  };
  base_wage_for_surcharge: number;
}

const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtHours(min: number): string {
  if (min === 0) return "0 h";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", weekday: "short" });
}

export function EmployeeWageDetailModal({ open, profileId, initialYear, onClose }: Props) {
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
    fetch(`/api/hr/employee-detail?profile_id=${profileId}&year=${year}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) setData(json as DetailResp);
        else setData(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, profileId, year]);

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
              <DateList dates={data.night.dates.map((d) => ({ date: d.date, label: d.entries > 1 ? `${d.entries}×` : "" }))} />
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
              <DateList dates={data.sunday_holiday.dates.map((d) => ({ date: d.date, label: d.label }))} />
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
  const totalDed = c.ahv_iv_eo_pct + c.alv_pct + c.nbu_pct + c.bvg_pct + c.ktg_pct + c.quellensteuer_pct;
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
          <DedRow label="NBU" value={c.nbu_pct} />
          <DedRow label="BVG" value={c.bvg_pct} />
          <DedRow label="KTG" value={c.ktg_pct} />
          <DedRow label="Quellensteuer" value={c.quellensteuer_pct} />
        </div>
        <div className="flex items-baseline justify-between mt-1.5 pt-1.5 border-t border-foreground/10 font-semibold">
          <span>Total Abzüge</span>
          <span className="tabular-nums">{PCT.format(totalDed)}%</span>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Gültig ab {new Date(c.effective_from + "T00:00:00").toLocaleDateString("de-CH")}
        {c.notes && <> · {c.notes}</>}
      </p>
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

function DateList({ dates }: { dates: { date: string; label: string }[] }) {
  return (
    <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <ul className="text-xs divide-y divide-foreground/5">
        {dates.map((d) => (
          <li key={d.date} className="flex items-center justify-between px-3 py-1.5">
            <span>{fmtDate(d.date)}</span>
            {d.label && <span className="text-[10px] text-muted-foreground">{d.label}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
