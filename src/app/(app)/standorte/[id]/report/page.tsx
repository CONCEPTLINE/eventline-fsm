/**
 * Location-Rentabilitaets-Report — Print-optimierte Ansicht.
 *
 * Trigger: /standorte/[id]/report (Link aus Standort-Detail-Header).
 * Rendert HTML das ueber @media print sauber auf A4 kommt. User klickt
 * oben "Als PDF drucken" -> window.print() -> Dialog "Als PDF speichern".
 *
 * Seit Migration 223 (Verrechnungssaetze pro Standort):
 *   - Umsatz = Sum (Stunden × Tier-Preis[historisch])
 *   - Marge  = Umsatz − Personal-Vollkosten
 *   - Aufschluesselung nach Modus (Normal/Pikett/Admin/...)
 *   - Wenn Location keine Tiers hat: Umsatz/Marge werden AUSGEBLENDET
 *     (keine Fantasie-Zahlen) — nur die Kosten-Seite wird gezeigt.
 */

import { notFound, redirect } from "next/navigation";
import { loadLocationReport } from "@/lib/location-report";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "./print-button";
import Link from "next/link";
import { ArrowLeft, Users, Briefcase, Clock, Wallet, MapPin, Phone, Mail, Calendar, FileText, Handshake } from "lucide-react";
import Image from "next/image";
import { JOB_STATUS } from "@/lib/constants";

export const dynamic = "force-dynamic";

async function ensureAdmin(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (data?.role !== "admin") redirect("/dashboard");
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}

/**
 * Zurich-Datum als "YYYY-MM-DD" (CLAUDE.md §4: NIE toISOString().slice(0,10)
 * — das ist UTC). Wir vergleichen mit start_date (auch Zurich-normalisiert).
 */
const zurichDateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" });
function toZurichDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return zurichDateFmt.format(new Date(iso));
}

function isoDateOffset(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return toZurichDate(d.toISOString());
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtDateLong(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function fmtChf(v: number): string {
  return v.toLocaleString("de-CH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtChfCompact(v: number): string {
  return v.toLocaleString("de-CH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtHours(mins: number): string {
  const h = mins / 60;
  return h.toLocaleString("de-CH", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function fmtYm(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 15));
  return d.toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    month: "short",
    year: "2-digit",
  });
}

export default async function LocationReportPage({ params, searchParams }: Props) {
  await ensureAdmin();
  const { id } = await params;
  const sp = await searchParams;
  // Default: letzte 24 Monate + naechste 6 Monate.
  const from = sp.from ?? isoDateOffset(-24 * 30);
  const to = sp.to ?? isoDateOffset(6 * 30);

  const data = await loadLocationReport(id, from, to);
  if (!data) notFound();

  const { location, kpis, jobs, people, contacts, partner_users, pipeline, months, tier_breakdown } = data;
  const generatedAt = toZurichDate(new Date().toISOString());
  const showUmsatz = location.has_rate_tiers;

  // ---- Vergangene vs. zukuenftige Auftraege trennen.
  // WICHTIG: start_date ist timestamptz ("YYYY-MM-DDTHH:MM:SS+00:00"),
  // today ist "YYYY-MM-DD". Ohne .slice/toZurichDate wuerde
  // "2026-09-07T00:00:00+00:00" > "2026-09-07" → jeder Auftrag mit Start
  // heute landet faelschlich in futureJobs.
  const today = data.period.today;
  const pastJobs = jobs.filter((j) => toZurichDate(j.start_date) <= today);
  const futureJobs = jobs.filter((j) => toZurichDate(j.start_date) > today);

  // ---- Monatsverlauf: max fuer Balken-Skalierung
  const maxMonthMinutes = Math.max(1, ...months.map((m) => m.minutes));
  // Bei vielen Monaten (24m Historie) wuerden Labels overlappen. Wir
  // labeln dann nur jeden n-ten Monat und lassen Hours-Labels weg.
  const monthCount = months.length;
  const labelStride = monthCount >= 18 ? 3 : monthCount >= 10 ? 2 : 1;
  const showHoursLabels = monthCount <= 14;
  const chartMaxWidth = monthCount <= 3 ? 420 : null;

  // ---- Adresse zusammenbauen
  const addressLine = [
    location.address_street,
    [location.address_zip, location.address_city].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ") || "—";

  return (
    <div className="report-root">
      {/* Print-CSS + Screen-Layout — alles in einem <style> weil eng verwoben. */}
      <style>{`
        /* ---------- Screen ---------- */
        .report-root {
          padding: 24px 16px;
          min-height: 100vh;
          background: var(--muted);
        }
        .report-page {
          max-width: 920px;
          margin: 0 auto;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 36px 40px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03);
        }
        .dark .report-page {
          box-shadow: 0 1px 2px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.2);
        }

        /* Section-Rhythmus */
        .r-section { margin-bottom: 28px; }
        .r-section:last-child { margin-bottom: 0; }
        .r-section-head {
          display: flex; align-items: baseline; justify-content: space-between;
          padding-bottom: 6px; margin-bottom: 12px;
          border-bottom: 1px solid var(--border);
        }
        .r-section-title {
          font-size: 11px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--foreground);
        }
        .r-section-meta {
          font-size: 10px; color: var(--muted-foreground);
          font-variant-numeric: tabular-nums;
        }

        /* Echtes EVENTLINE-Logo — Light-/Dark-/Print-Handling */
        .r-logo { display: block; height: auto; width: auto; }
        .r-logo-light { display: block; }
        .r-logo-dark { display: none; }
        :root:not([data-theme="light"]) .r-logo-light { display: none; }
        :root:not([data-theme="light"]) .r-logo-dark { display: block; }
        :root[data-theme="dark"] .r-logo-light { display: none; }
        :root[data-theme="dark"] .r-logo-dark { display: block; }

        /* Tabellen */
        .r-table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .r-table thead th {
          font-size: 9.5px; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase;
          color: var(--muted-foreground);
          text-align: left; padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          background: var(--muted);
        }
        .r-table thead th.num { text-align: right; font-variant-numeric: tabular-nums; }
        .r-table tbody td {
          padding: 7px 10px; border-bottom: 1px solid var(--border);
          vertical-align: middle;
        }
        .r-table tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
        .r-table tbody tr:nth-child(odd) td { background: color-mix(in oklab, var(--muted) 40%, transparent); }
        .r-table tbody tr:last-child td { border-bottom: none; }

        /* Chip / Badge */
        .r-chip {
          display: inline-flex; align-items: center;
          padding: 1px 7px; border-radius: 9999px;
          font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em;
          white-space: nowrap;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        .r-chip-green { background: rgba(0,168,107,0.14); color: #14532d; }
        .dark .r-chip-green { color: #86efac; background: rgba(0,168,107,0.22); }
        .r-chip-muted { background: var(--muted); color: var(--muted-foreground); }

        /* KPI */
        .r-kpi {
          border: 1px solid var(--border); border-radius: 10px;
          padding: 14px 16px; background: var(--card);
        }
        .r-kpi-primary { background: color-mix(in oklab, var(--muted) 40%, var(--card)); }
        .r-kpi-label {
          font-size: 9.5px; font-weight: 600; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--muted-foreground);
        }
        .r-kpi-value {
          font-size: 22px; font-weight: 700; letter-spacing: -0.01em;
          font-variant-numeric: tabular-nums; margin-top: 4px;
          color: var(--foreground); line-height: 1.1;
        }
        .r-kpi-primary .r-kpi-value { font-size: 28px; }
        .r-kpi-unit { font-size: 12px; font-weight: 500; color: var(--muted-foreground); margin-left: 2px; }
        .r-kpi-hint { font-size: 10px; color: var(--muted-foreground); margin-top: 4px; }

        /* Team-Cards */
        .r-card {
          border: 1px solid var(--border); border-radius: 10px;
          padding: 14px 16px; background: var(--card);
        }
        .r-card-title {
          font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase; color: var(--muted-foreground);
          margin-bottom: 10px;
        }

        /* Timeline (Pipeline) */
        .r-timeline { position: relative; padding-left: 22px; }
        .r-timeline::before {
          content: ""; position: absolute;
          left: 6px; top: 6px; bottom: 6px; width: 1px;
          background: var(--border);
        }
        .r-timeline-item {
          position: relative; padding: 6px 0 10px;
          display: grid; grid-template-columns: 80px 1fr auto; gap: 12px;
          align-items: baseline;
          font-size: 11px;
        }
        .r-timeline-item::before {
          content: ""; position: absolute;
          left: -19px; top: 12px; width: 9px; height: 9px;
          border-radius: 999px; background: var(--foreground);
          border: 2px solid var(--card);
        }
        .r-timeline-date {
          font-variant-numeric: tabular-nums;
          font-weight: 600; color: var(--foreground);
        }
        .r-timeline-kind {
          font-size: 9px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--muted-foreground);
        }

        /* Monats-Balken-Chart */
        .r-bars {
          display: grid; gap: 4px;
          align-items: end;
          height: 110px;
          padding-bottom: 4px;
          border-bottom: 1px solid var(--border);
        }
        .r-bar {
          background: color-mix(in oklab, #F53C3A 78%, transparent);
          border-radius: 3px 3px 0 0;
          min-height: 2px;
          position: relative;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        .r-bar-empty {
          background: repeating-linear-gradient(
            45deg,
            var(--border) 0 2px,
            transparent 2px 6px
          );
          height: 4px !important;
          align-self: end;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        .r-bar-labels {
          display: grid; gap: 4px;
          margin-top: 6px;
        }
        .r-bar-label {
          text-align: center;
          font-size: 8.5px; color: var(--muted-foreground);
          letter-spacing: 0.02em;
          font-variant-numeric: tabular-nums;
        }
        .r-bar-hours {
          text-align: center;
          font-size: 8.5px; color: var(--foreground);
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }

        /* Kontakt-List Zeile */
        .r-contact {
          display: grid; grid-template-columns: 1fr auto; gap: 8px;
          padding: 6px 0; border-bottom: 1px dashed var(--border);
          font-size: 11px;
        }
        .r-contact:last-child { border-bottom: none; }
        .r-contact-name { font-weight: 600; }
        .r-contact-role { font-size: 10px; color: var(--muted-foreground); margin-left: 6px; font-weight: 400; }
        .r-contact-meta { font-size: 10px; color: var(--muted-foreground); text-align: right; font-variant-numeric: tabular-nums; }

        /* Meta-Table (Kopf) */
        .r-meta-table {
          display: grid; grid-template-columns: max-content 1fr;
          gap: 4px 16px; font-size: 11px; line-height: 1.5;
        }
        .r-meta-key { color: var(--muted-foreground); }
        .r-meta-val { color: var(--foreground); }

        /* Empty */
        .r-empty {
          padding: 14px; text-align: center; font-size: 11px;
          color: var(--muted-foreground); font-style: italic;
        }

        /* ---------- Print ---------- */
        @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
        @media print {
          .no-print { display: none !important; }
          html, body { background: white !important; }
          .report-root { background: white !important; padding: 0 !important; min-height: 0 !important; }
          .report-page {
            max-width: none !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            box-shadow: none !important;
            background: white !important;
            color: #111 !important;
          }
          .r-kpi, .r-card, .r-table, .r-timeline { background: white !important; }
          .r-kpi { background: white !important; }
          .r-kpi-primary { background: #fafafa !important; }
          .r-section { page-break-inside: auto; }
          .r-section-head, .r-kpi, .r-card, .r-bar-chart, .r-print-head {
            break-inside: avoid; page-break-inside: avoid;
          }
          .r-table thead {
            display: table-header-group; /* Header wiederholt sich auf jeder Seite */
          }
          .r-table tbody tr { break-inside: avoid; page-break-inside: avoid; }
          .r-table tbody tr:nth-child(odd) td { background: #f7f7f7 !important; }
          .r-table thead th { background: #f2f2f2 !important; color: #333 !important; }
          .r-chip { border: 0.5px solid #ddd; }
          .r-chip-green { background: #d1fae5 !important; color: #14532d !important; }
          .r-chip-muted { background: #f3f4f6 !important; color: #6b7280 !important; }
          /* Im Print immer die schwarze Logo-Variante — Papier ist weiss. */
          .r-logo-light { display: block !important; }
          .r-logo-dark  { display: none !important; }
          .r-print-head {
            padding-bottom: 10px;
            margin-bottom: 18px;
            border-bottom: 2px solid #111 !important;
          }
          .r-section-head { border-color: #ccc !important; }
          .r-table thead th { border-color: #ccc !important; }
          .r-table tbody td { border-color: #eee !important; }
          .r-timeline::before { background: #ccc !important; }
          .r-timeline-item::before { background: #111 !important; border-color: white !important; }
          .r-bars { border-color: #ccc !important; }
          .r-bar { background: #F53C3A !important; }
        }
      `}</style>

      <div className="report-page">
        {/* ---------- Toolbar (nicht im Print) ---------- */}
        <div className="no-print flex items-center justify-between gap-3 mb-6">
          <Link
            href={`/standorte/${id}`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Zurück zum Standort
          </Link>
          <PrintButton />
        </div>

        {/* ================================================================ */}
        {/* Print-Kopf: Wortmarke + Report-Titel + Meta                      */}
        {/* ================================================================ */}
        <div className="r-print-head r-section">
          <div className="flex items-start justify-between gap-6 mb-4">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-1">
                Standort-Rapport
              </p>
              <h1 className="text-2xl font-bold text-balance leading-tight">
                {location.name}
              </h1>
              <p className="text-xs text-muted-foreground mt-1">
                {addressLine}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <Image
                src="/logo-gmbh-black.png"
                alt="EVENTLINE GmbH"
                width={160}
                height={30}
                className="r-logo r-logo-light"
                style={{ height: 30, width: "auto" }}
                priority
              />
              <Image
                src="/logo-gmbh.png"
                alt="EVENTLINE GmbH"
                width={160}
                height={30}
                className="r-logo r-logo-dark"
                style={{ height: 30, width: "auto" }}
              />
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mt-1">Basel</p>
            </div>
          </div>

          <div className="r-meta-table mt-3">
            <span className="r-meta-key">Zeitraum</span>
            <span className="r-meta-val">{fmtDateLong(data.period.from)} — {fmtDateLong(data.period.to)}</span>
            <span className="r-meta-key">Stand</span>
            <span className="r-meta-val">{fmtDateLong(data.period.today)}</span>
            {location.customer_name ? (
              <>
                <span className="r-meta-key">Kunde</span>
                <span className="r-meta-val">{location.customer_name}</span>
              </>
            ) : null}
            {location.capacity ? (
              <>
                <span className="r-meta-key">Kapazität</span>
                <span className="r-meta-val">{location.capacity} Plätze</span>
              </>
            ) : null}
            {location.default_hourly_rate_chf ? (
              <>
                <span className="r-meta-key">Verrechnungssatz</span>
                <span className="r-meta-val">CHF {fmtChf(location.default_hourly_rate_chf)}/h</span>
              </>
            ) : null}
          </div>
        </div>

        {/* ================================================================ */}
        {/* KPI-Grid                                                          */}
        {/* ================================================================ */}
        <div className="r-section">
          <div className="r-section-head">
            <span className="r-section-title">Kennzahlen im Zeitraum</span>
            <span className="r-section-meta">{pastJobs.length} vergangen · {futureJobs.length} geplant</span>
          </div>

          {/* Primaer-Reihe: mit Tiers = Marge + Umsatz + Kosten + Stunden (4).
              Ohne Tiers = Kosten + Stunden (2). Marge ist die Kern-KPI. */}
          {showUmsatz ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
              <div className="r-kpi r-kpi-primary" style={{ backgroundColor: (kpis.marge_chf ?? 0) >= 0 ? "rgba(0,168,107,0.08)" : "rgba(220,38,38,0.08)" }}>
                <div className="flex items-center gap-2">
                  <Wallet className="h-3.5 w-3.5" style={{ color: (kpis.marge_chf ?? 0) >= 0 ? "rgb(0,120,80)" : "rgb(185,28,28)" }} />
                  <span className="r-kpi-label">Marge</span>
                </div>
                <p className="r-kpi-value" style={{ color: (kpis.marge_chf ?? 0) >= 0 ? "rgb(0,120,80)" : "rgb(185,28,28)" }}>
                  CHF <span>{fmtChf(kpis.marge_chf ?? 0)}</span>
                </p>
                <p className="r-kpi-hint">Umsatz − Personal-Vollkosten</p>
              </div>
              <div className="r-kpi r-kpi-primary">
                <div className="flex items-center gap-2">
                  <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="r-kpi-label">Umsatz</span>
                </div>
                <p className="r-kpi-value">CHF <span>{fmtChf(kpis.umsatz_chf ?? 0)}</span></p>
                <p className="r-kpi-hint">Stunden × Verrechnungssatz (historisch)</p>
              </div>
              <div className="r-kpi r-kpi-primary">
                <div className="flex items-center gap-2">
                  <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="r-kpi-label">Personal-Vollkosten</span>
                </div>
                <p className="r-kpi-value">CHF <span>{fmtChf(kpis.personal_vollkosten_chf)}</span></p>
                <p className="r-kpi-hint">Brutto × (1 + AG-Anteil %)</p>
              </div>
              <div className="r-kpi r-kpi-primary">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="r-kpi-label">Gearbeitete Stunden</span>
                </div>
                <p className="r-kpi-value">{fmtHours(kpis.total_minutes)}<span className="r-kpi-unit">h</span></p>
                <p className="r-kpi-hint">Stempel + Rapport (Pausen abgezogen)</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div className="r-kpi r-kpi-primary">
                <div className="flex items-center gap-2">
                  <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="r-kpi-label">Personal-Vollkosten</span>
                </div>
                <p className="r-kpi-value">CHF <span>{fmtChf(kpis.personal_vollkosten_chf)}</span></p>
                <p className="r-kpi-hint">Brutto-Lohn × (1 + AG-Anteil %) · alle gearbeiteten Stunden im Zeitraum</p>
              </div>
              <div className="r-kpi r-kpi-primary">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="r-kpi-label">Gearbeitete Stunden</span>
                </div>
                <p className="r-kpi-value">{fmtHours(kpis.total_minutes)}<span className="r-kpi-unit">h</span></p>
                <p className="r-kpi-hint">Aus Zeiterfassung + Einsatzrapport-Zeiten</p>
              </div>
            </div>
          )}

          {/* Sekundaer-Reihe (5 klein) */}
          <div className="grid grid-cols-5 gap-3">
            <div className="r-kpi">
              <div className="flex items-center gap-1.5"><Briefcase className="h-3 w-3 text-muted-foreground" /><span className="r-kpi-label">Aufträge</span></div>
              <p className="r-kpi-value" style={{ fontSize: 20 }}>{kpis.total_jobs}</p>
            </div>
            <div className="r-kpi">
              <div className="r-kpi-label">Abgeschlossen</div>
              <p className="r-kpi-value" style={{ fontSize: 20 }}>{kpis.jobs_completed}</p>
            </div>
            <div className="r-kpi">
              <div className="r-kpi-label">Storniert</div>
              <p className="r-kpi-value" style={{ fontSize: 20 }}>{kpis.jobs_cancelled}</p>
            </div>
            <div className="r-kpi">
              <div className="r-kpi-label">Geplant</div>
              <p className="r-kpi-value" style={{ fontSize: 20 }}>{kpis.jobs_planned_future}</p>
            </div>
            <div className="r-kpi">
              <div className="flex items-center gap-1.5"><Users className="h-3 w-3 text-muted-foreground" /><span className="r-kpi-label">Team</span></div>
              <p className="r-kpi-value" style={{ fontSize: 20 }}>{kpis.team_size}</p>
              <p className="r-kpi-hint">MA + Partner</p>
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/* Aufschluesselung nach Modus (Normal / Pikett / Admin / ...)      */}
        {/* Nur wenn Location Rate-Tiers hat.                                */}
        {/* ================================================================ */}
        {showUmsatz && tier_breakdown.some((t) => t.minutes > 0) && (
          <div className="r-section">
            <div className="r-section-head">
              <span className="r-section-title">Aufschlüsselung nach Modus</span>
              <span className="r-section-meta">Wo wurde gearbeitet — und was rechnet welcher Modus ein</span>
            </div>
            <table className="r-table">
              <thead>
                <tr>
                  <th>Modus</th>
                  <th className="num" style={{ width: 70 }}>Std.</th>
                  <th className="num" style={{ width: 70 }}>Anteil</th>
                  <th className="num" style={{ width: 100 }}>Umsatz</th>
                  <th className="num" style={{ width: 100 }}>Kosten</th>
                  <th className="num" style={{ width: 100 }}>Marge</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const totalMin = tier_breakdown.reduce((s, t) => s + t.minutes, 0);
                  return tier_breakdown.filter((t) => t.minutes > 0).map((t) => {
                    const share = totalMin > 0 ? (t.minutes / totalMin) * 100 : 0;
                    return (
                      <tr key={t.tier_id}>
                        <td style={{ fontWeight: 500 }}>{t.label}</td>
                        <td className="num">{fmtHours(t.minutes)}</td>
                        <td className="num">{share.toFixed(0)}%</td>
                        <td className="num">{fmtChf(t.umsatz_chf)}</td>
                        <td className="num">{fmtChf(t.personal_vollkosten_chf)}</td>
                        <td
                          className="num"
                          style={{
                            fontWeight: 600,
                            color: t.marge_chf >= 0 ? "rgb(0,120,80)" : "rgb(185,28,28)",
                          }}
                        >
                          {fmtChf(t.marge_chf)}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}

        {/* ================================================================ */}
        {/* Vergangene Auftraege                                              */}
        {/* ================================================================ */}
        <div className="r-section">
          <div className="r-section-head">
            <span className="r-section-title">Vergangene Aufträge</span>
            <span className="r-section-meta">
              {pastJobs.length} · Σ {fmtHours(pastJobs.reduce((s, j) => s + j.minutes, 0))} h · Kosten CHF {fmtChfCompact(pastJobs.reduce((s, j) => s + j.personal_vollkosten_chf, 0))}
              {showUmsatz && (
                <> · Umsatz CHF {fmtChfCompact(pastJobs.reduce((s, j) => s + (j.umsatz_chf ?? 0), 0))} · Marge CHF {fmtChfCompact(pastJobs.reduce((s, j) => s + (j.marge_chf ?? 0), 0))}</>
              )}
            </span>
          </div>
          {pastJobs.length === 0 ? (
            <div className="r-empty">Keine vergangenen Aufträge im Zeitraum.</div>
          ) : (
            <table className="r-table">
              <thead>
                <tr>
                  <th style={{ width: 68 }}>Nr.</th>
                  <th style={{ width: 88 }}>Datum</th>
                  <th>Titel</th>
                  <th>Kunde</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th className="num" style={{ width: 55 }}>Std.</th>
                  <th className="num" style={{ width: 90 }}>Kosten</th>
                  {showUmsatz && <th className="num" style={{ width: 90 }}>Umsatz</th>}
                  {showUmsatz && <th className="num" style={{ width: 90 }}>Marge</th>}
                  <th style={{ width: 84 }}>Rechnung</th>
                </tr>
              </thead>
              <tbody>
                {pastJobs.map((j) => {
                  const sMeta = JOB_STATUS[j.status as keyof typeof JOB_STATUS];
                  return (
                    <tr key={j.id}>
                      <td className="num" style={{ textAlign: "left", color: "var(--muted-foreground)" }}>INT-{j.job_number}</td>
                      <td>{fmtDate(j.start_date)}</td>
                      <td style={{ fontWeight: 500 }}>{j.title}</td>
                      <td>{j.customer_name ?? "—"}</td>
                      <td>
                        {sMeta ? (
                          <span className={`inline-flex px-1.5 py-0 text-[9.5px] font-medium rounded-full ${sMeta.color}`}>
                            {sMeta.label}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">{j.status}</span>
                        )}
                      </td>
                      <td className="num">{fmtHours(j.minutes)}</td>
                      <td className="num">{fmtChf(j.personal_vollkosten_chf)}</td>
                      {showUmsatz && (
                        <td className="num">
                          {j.umsatz_chf !== null && j.umsatz_chf > 0 ? fmtChf(j.umsatz_chf) : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      {showUmsatz && (
                        <td
                          className="num"
                          style={{
                            fontWeight: 600,
                            color: j.marge_chf === null
                              ? "var(--muted-foreground)"
                              : j.marge_chf >= 0
                              ? "rgb(0,120,80)"
                              : "rgb(185,28,28)",
                          }}
                        >
                          {j.marge_chf !== null ? fmtChf(j.marge_chf) : <span className="text-muted-foreground">—</span>}
                        </td>
                      )}
                      <td>
                        {j.status === "storniert" ? (
                          // Storniert → wird nicht mehr verrechnet, deshalb
                          // weder "verrechnet" noch "offen". Nur Trennstrich.
                          <span className="text-muted-foreground">—</span>
                        ) : j.invoiced_at ? (
                          <span className="r-chip r-chip-green">verrechnet</span>
                        ) : (
                          <span className="r-chip r-chip-muted">offen</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ================================================================ */}
        {/* Monatsverlauf (Balken)                                            */}
        {/* ================================================================ */}
        {months.length > 0 && (
          <div className="r-section r-bar-chart">
            <div className="r-section-head">
              <span className="r-section-title">Monatsverlauf</span>
              <span className="r-section-meta">
                Gearbeitete Stunden je Monat{labelStride > 1 ? ` · Beschriftung jeden ${labelStride}. Monat` : ""}
              </span>
            </div>
            <div style={{ maxWidth: chartMaxWidth ?? undefined, margin: chartMaxWidth ? "0 auto" : undefined }}>
              <div
                className="r-bars"
                style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
              >
                {months.map((m) => {
                  const h = m.minutes > 0
                    ? Math.max(4, Math.round((m.minutes / maxMonthMinutes) * 100))
                    : 0;
                  return h > 0 ? (
                    <div
                      key={m.ym}
                      className="r-bar"
                      style={{ height: `${h}%` }}
                      title={`${fmtYm(m.ym)}: ${fmtHours(m.minutes)}h, ${m.jobs} Aufträge`}
                    />
                  ) : (
                    <div key={m.ym} className="r-bar-empty" />
                  );
                })}
              </div>
              {showHoursLabels && (
                <div
                  className="r-bar-labels"
                  style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
                >
                  {months.map((m) => (
                    <div key={m.ym + "-h"} className="r-bar-hours">
                      {m.minutes > 0 ? fmtHours(m.minutes) : "–"}
                    </div>
                  ))}
                </div>
              )}
              <div
                className="r-bar-labels"
                style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))`, marginTop: showHoursLabels ? 2 : 6 }}
              >
                {months.map((m, i) => (
                  <div key={m.ym + "-l"} className="r-bar-label">
                    {i % labelStride === 0 ? fmtYm(m.ym) : ""}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ================================================================ */}
        {/* Team + Kontakte                                                   */}
        {/* ================================================================ */}
        <div className="r-section">
          <div className="r-section-head">
            <span className="r-section-title">Team & Kontakte</span>
            <span className="r-section-meta">{people.length} MA · {partner_users.length} Partner-User · {contacts.length} Kontakte</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Linke Karte: Mitarbeiter */}
            <div className="r-card">
              <p className="r-card-title flex items-center gap-1.5">
                <Users className="h-3 w-3" />
                Mitarbeiter (nach Stunden)
              </p>
              {people.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">Keine Stunden erfasst.</p>
              ) : (
                <table className="r-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="num">Std.</th>
                      <th className="num">CHF/h</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.id}>
                        <td style={{ fontWeight: 500 }}>{p.full_name}</td>
                        <td className="num">{fmtHours(p.minutes)}</td>
                        <td className="num" style={{ color: p.hourly_vollkosten_chf > 0 ? "var(--foreground)" : "var(--muted-foreground)" }}>
                          {p.hourly_vollkosten_chf > 0 ? fmtChf(p.hourly_vollkosten_chf) : "—"}
                        </td>
                        <td className="num" style={{ fontWeight: 600 }}>{fmtChf(p.personal_vollkosten_chf)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Rechte Karte: Partner + Kontakte */}
            <div className="r-card">
              <p className="r-card-title flex items-center gap-1.5">
                <Handshake className="h-3 w-3" />
                Partner-User ({partner_users.length})
              </p>
              {partner_users.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic mb-3">Keine Partner-User zugeordnet.</p>
              ) : (
                <div className="mb-3">
                  {partner_users.map((u) => (
                    <div key={u.id} className="r-contact">
                      <div>
                        <span className={u.is_active ? "r-contact-name" : "r-contact-name text-muted-foreground italic"}>
                          {u.full_name}
                        </span>
                        {!u.is_active && <span className="r-contact-role">(deaktiviert)</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="r-card-title flex items-center gap-1.5" style={{ marginTop: partner_users.length ? 14 : 0 }}>
                <MapPin className="h-3 w-3" />
                Location-Kontakte ({contacts.length})
              </p>
              {contacts.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">Keine Kontakte hinterlegt.</p>
              ) : (
                <div>
                  {contacts.map((c) => (
                    <div key={c.id} className="r-contact">
                      <div>
                        <span className="r-contact-name">{c.name}</span>
                        {c.role && <span className="r-contact-role">{c.role}</span>}
                      </div>
                      <div className="r-contact-meta">
                        {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-2.5 w-2.5" />{c.email}</span>}
                        {c.email && c.phone && <span className="mx-1">·</span>}
                        {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{c.phone}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ================================================================ */}
        {/* Pipeline (Timeline)                                               */}
        {/* ================================================================ */}
        <div className="r-section">
          <div className="r-section-head">
            <span className="r-section-title">Pipeline</span>
            <span className="r-section-meta">Kommende Termine, Aufträge & Anfragen · {pipeline.length}</span>
          </div>
          {pipeline.length === 0 ? (
            <div className="r-empty">Keine geplanten Aktivitäten.</div>
          ) : (
            <div className="r-timeline">
              {pipeline.map((p) => (
                <div key={`${p.kind}-${p.id}`} className="r-timeline-item">
                  <span className="r-timeline-date">{fmtDate(p.date)}</span>
                  <span>
                    <span style={{ fontWeight: 500 }}>{p.title}</span>
                    {p.extra ? <span className="text-muted-foreground text-[10px] ml-2">· {p.extra}</span> : null}
                  </span>
                  <span className="r-timeline-kind inline-flex items-center gap-1">
                    {p.kind === "job" && <Briefcase className="h-2.5 w-2.5" />}
                    {p.kind === "rental" && <FileText className="h-2.5 w-2.5" />}
                    {p.kind === "event" && <Calendar className="h-2.5 w-2.5" />}
                    {p.kind === "job" ? "Auftrag" : p.kind === "rental" ? "Mietanfrage" : "Termin"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Technik & Notizen-Section entfernt: locations.technical_details
            und locations.notes speichern JSON-Rohdaten (Dokumenten-Array
            bzw. Notiz-Array), nicht formatierten Text — im Rapport war
            das nur unlesbarer JSON-Dump. */}

        {/* ================================================================ */}
        {/* Footer                                                            */}
        {/* ================================================================ */}
        <div className="r-section" style={{ marginTop: 24 }}>
          <div className="border-t border-border pt-3">
            <div className="flex items-start justify-between gap-4 text-[9.5px] text-muted-foreground leading-relaxed">
              <div>
                {showUmsatz ? (
                  <>
                    <p style={{ fontWeight: 600 }} className="mb-1">Umsatz-Rechnung</p>
                    <p>
                      Umsatz = Stunden × Verrechnungssatz zum Zeitpunkt der Stempelung
                      (historisch aus den Modus-Preisen). Weicht i.d.R. leicht von der
                      Bexio-Rechnungssumme ab (Rundung, Sondervereinbarungen).
                    </p>
                  </>
                ) : (
                  <>
                    <p style={{ fontWeight: 600 }} className="mb-1">Umsatz nicht enthalten</p>
                    <p>
                      Keine Verrechnungssätze für diesen Standort hinterlegt — leg unter
                      „Einstellungen · Verrechnungssätze" ein Preisschema an, damit Umsatz +
                      Marge automatisch berechnet werden.
                    </p>
                  </>
                )}
              </div>
              <div className="text-right shrink-0">
                <p>Generiert am {fmtDate(generatedAt)}</p>
                <div className="mt-1 inline-flex items-center gap-1.5">
                  <Image
                    src="/logo-gmbh-black.png"
                    alt="EVENTLINE GmbH"
                    width={90}
                    height={16}
                    className="r-logo r-logo-light"
                    style={{ height: 14, width: "auto" }}
                  />
                  <Image
                    src="/logo-gmbh.png"
                    alt="EVENTLINE GmbH"
                    width={90}
                    height={16}
                    className="r-logo r-logo-dark"
                    style={{ height: 14, width: "auto" }}
                  />
                  <span>· Basel</span>
                </div>
              </div>
            </div>
            <p className="text-[9px] text-muted-foreground mt-2">
              Vollkosten = Brutto-Stundenlohn × (1 + Summe Arbeitgeber-Anteil %) je Mitarbeiter zum
              Zeitpunkt der Stempelung. AG-Anteile: AHV/IV/EO, ALV, FAK, BU, BVG, Verwaltung.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
