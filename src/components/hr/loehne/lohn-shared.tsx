"use client";

/**
 * Shared Lohn-Components + Types — wird von LohnStandardwerteCard und
 * MitarbeiterLohnTab gemeinsam genutzt. Definiert die 12 Pct-Felder
 * (6 AN-Abzuege + 6 AG-Anteil) sowie die UI-Bausteine fuer Anzeige +
 * Edit.
 */

import { Input } from "@/components/ui/input";
import { NBU_HINWEIS_KURZ, NBU_HINWEIS_LANG } from "@/lib/nbu-pflicht";

export const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Pct-Feld einer Gruppe; `hint` erscheint als kurzer Hinweis unter der
 *  Gruppe (z. B. NBU: nur bei Ø ≥ 8 h/Woche abgezogen). */
export interface PctFeld {
  key: string;
  label: string;
  hint?: string;
  hintTooltip?: string;
}

/** Kurze Hinweise zu Feldern einer Pct-Gruppe (eine Zeile je Feld mit hint). */
export function PctFeldHinweise({ fields }: { fields: ReadonlyArray<PctFeld> }) {
  const mitHinweis = fields.filter((f) => f.hint);
  if (mitHinweis.length === 0) return null;
  return (
    <>
      {mitHinweis.map((f) => (
        <p key={f.key} className="text-[10px] text-muted-foreground/70" data-tooltip={f.hintTooltip}>
          {f.label} {f.hint}
        </p>
      ))}
    </>
  );
}

/** Pct-Anzeige: min 2 Nachkommastellen, max 4. Strip trailing zeros oberhalb der 2er-Baseline. */
export function fmtPct(n: number): string {
  const fixed4 = n.toFixed(4);
  const trimmed = fixed4.replace(/0+$/, "");
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx < 0) return trimmed + ".00";
  const after = trimmed.length - dotIdx - 1;
  if (after < 2) return trimmed + "0".repeat(2 - after);
  return trimmed.replace(/\.$/, "");
}

export const PCT_KEYS = [
  "ahv_iv_eo_pct", "alv_pct", "nbu_pct", "bvg_pct", "ktg_pct", "quellensteuer_pct",
  "employer_ahv_pct", "employer_alv_pct", "employer_fak_pct", "employer_bu_pct", "employer_bvg_pct", "employer_verwaltung_pct",
] as const;
export type PctKey = typeof PCT_KEYS[number];
export type PctMap = Record<PctKey, string>;

export const PCT_EMPTY: PctMap = {
  ahv_iv_eo_pct: "", alv_pct: "", nbu_pct: "", bvg_pct: "", ktg_pct: "", quellensteuer_pct: "",
  employer_ahv_pct: "", employer_alv_pct: "", employer_fak_pct: "", employer_bu_pct: "", employer_bvg_pct: "", employer_verwaltung_pct: "",
};

export const DEFAULTS_FALLBACK: PctMap = {
  ahv_iv_eo_pct: "5.3", alv_pct: "1.1", nbu_pct: "1.4", bvg_pct: "0", ktg_pct: "0", quellensteuer_pct: "0",
  employer_ahv_pct: "5.3", employer_alv_pct: "1.1", employer_fak_pct: "1.5", employer_bu_pct: "0.5", employer_bvg_pct: "3.0", employer_verwaltung_pct: "0.5",
};

/** Mapper: Lohn-Default-Backend-Format (camelCase) -> snake_case PctMap. */
export function defaultsToPctMap(d: Record<string, unknown>): PctMap {
  const num = (k: string): string => {
    const v = d[k];
    return v == null ? "0" : String(Number(v));
  };
  return {
    ahv_iv_eo_pct: num("ahvIvEoPct"),
    alv_pct: num("alvPct"),
    nbu_pct: num("nbuPct"),
    bvg_pct: num("bvgPct"),
    ktg_pct: num("ktgPct"),
    quellensteuer_pct: num("quellensteuerPct"),
    employer_ahv_pct: num("employerAhvPct"),
    employer_alv_pct: num("employerAlvPct"),
    employer_fak_pct: num("employerFakPct"),
    employer_bu_pct: num("employerBuPct"),
    employer_bvg_pct: num("employerBvgPct"),
    employer_verwaltung_pct: num("employerVerwaltungPct"),
  };
}

/** Gruppe von Pct-Inputs fuer den Standardwerte-Block (inline edit
 *  mit per-Feld 'OK'-Button bei Aenderung). */
export function DefaultsGroup({ title, subtitle, fields, drafts, setDrafts, current, onSave, saving }: {
  title: string;
  subtitle: string;
  fields: Array<PctFeld>;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<PctMap>>;
  current: Record<string, string>;
  onSave: (k: string) => Promise<void>;
  saving: boolean;
}) {
  const sum = fields.reduce((s, f) => s + (parseFloat((drafts[f.key] ?? "0").replace(",", ".")) || 0), 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70">{subtitle} · <span className="font-semibold text-foreground/80 tabular-nums">Σ {fmtPct(sum)}%</span></p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {fields.map((f) => {
          const draft = drafts[f.key] ?? "";
          const dirty = draft !== current[f.key];
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
                    className="h-8 text-xs pr-7"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">%</span>
                </div>
                {dirty && (
                  <button
                    type="button"
                    onClick={() => onSave(f.key)}
                    disabled={saving}
                    className="px-2 h-8 text-[10px] font-semibold rounded-md bg-blue-500/15 text-blue-700 dark:text-blue-300 hover:bg-blue-500/25 transition-colors shrink-0"
                  >
                    OK
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <PctFeldHinweise fields={fields} />
    </div>
  );
}

/** Read-only-Anzeige einer Pct-Gruppe — fuer 'Standard verwenden' im Edit. */
export function ReadonlyPctGroup({ title, fields, values }: {
  title: string;
  fields: Array<PctFeld>;
  values: Record<string, string>;
}) {
  const sum = fields.reduce((s, f) => s + (parseFloat((values[f.key] ?? "0").replace(",", ".")) || 0), 0);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70 tabular-nums">Σ {fmtPct(sum)}%</p>
      </div>
      <div className="grid grid-cols-3 gap-1 text-xs">
        {fields.map((f) => (
          <div key={f.key} className="flex items-center justify-between px-2 py-1 rounded border border-dashed border-border bg-muted/30 text-muted-foreground">
            <span className="truncate text-[10px]">{f.label}</span>
            <span className="tabular-nums">{fmtPct(parseFloat((values[f.key] ?? "0").replace(",", ".")) || 0)}%</span>
          </div>
        ))}
      </div>
      <PctFeldHinweise fields={fields} />
    </div>
  );
}

/** Editierbare Pct-Gruppe im Override-Modus. */
export function EditablePctGroup({ title, fields, values, setValues, defaults }: {
  title: string;
  fields: Array<PctFeld>;
  values: Record<string, string>;
  setValues: React.Dispatch<React.SetStateAction<PctMap>>;
  defaults: Record<string, string>;
}) {
  const sum = fields.reduce((s, f) => {
    const v = parseFloat((values[f.key] || defaults[f.key] || "0").replace(",", ".")) || 0;
    return s + v;
  }, 0);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground/70 tabular-nums">Σ {fmtPct(sum)}%</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {fields.map((f) => (
          <div key={f.key} className="space-y-0.5">
            <label className="text-[10px] text-muted-foreground/70 truncate block">{f.label}</label>
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                className="h-9 text-xs pr-7"
                placeholder={defaults[f.key] ?? "0"}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 pointer-events-none">%</span>
            </div>
          </div>
        ))}
      </div>
      <PctFeldHinweise fields={fields} />
    </div>
  );
}

/** Netto/Vollkosten-Preview. Liest direkt aus dem effektiven Pct-Set
 *  (entweder Override oder Defaults). */
export function LohnPreview({ wage, values }: {
  wage: string;
  values: Record<string, string>;
}) {
  const w = parseFloat(wage.replace(",", "."));
  if (!Number.isFinite(w) || w < 0) return null;
  const num = (k: string) => parseFloat((values[k] ?? "0").replace(",", ".")) || 0;
  const totalAnPct = num("ahv_iv_eo_pct") + num("alv_pct") + num("nbu_pct") + num("bvg_pct") + num("ktg_pct") + num("quellensteuer_pct");
  const totalAgPct = num("employer_ahv_pct") + num("employer_alv_pct") + num("employer_fak_pct") + num("employer_bu_pct") + num("employer_bvg_pct") + num("employer_verwaltung_pct");
  const deductionAmount = w * (totalAnPct / 100);
  const netto = w - deductionAmount;
  const agAmount = w * (totalAgPct / 100);
  const vollkosten = w + agAmount;
  return (
    <div className="space-y-1 px-3 py-2 rounded-lg bg-foreground/[0.04] dark:bg-foreground/[0.06] text-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-muted-foreground">Brutto / h</span>
        <span className="tabular-nums">CHF {CHF.format(w)}</span>
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground">
        <span>− Abzüge ({fmtPct(totalAnPct)}%)</span>
        <span className="tabular-nums">CHF {CHF.format(deductionAmount)}</span>
      </div>
      <div className="flex items-baseline justify-between pt-1 border-t border-foreground/10">
        {/* NBU steckt im Satz, wird aber nur bei Ø ≥ 8 h/Woche abgezogen (Hinweis an der Abzugs-Gruppe). */}
        <span className="font-semibold">Netto / h{num("nbu_pct") > 0 ? " (mit NBU)" : ""}</span>
        <span className="font-semibold tabular-nums">CHF {CHF.format(netto)}</span>
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground pt-1">
        <span>+ AG-Anteil ({fmtPct(totalAgPct)}%)</span>
        <span className="tabular-nums">CHF {CHF.format(agAmount)}</span>
      </div>
      <div className="flex items-baseline justify-between pt-1 border-t border-foreground/10 text-muted-foreground">
        <span>Vollkosten / h</span>
        <span className="tabular-nums">CHF {CHF.format(vollkosten)}</span>
      </div>
    </div>
  );
}

export const AN_FIELDS: Array<PctFeld & { key: PctKey }> = [
  { key: "ahv_iv_eo_pct", label: "AHV/IV/EO" },
  { key: "alv_pct", label: "ALV" },
  // Art. 13 UVV: abgezogen nur bei NBU-Versicherung (@/lib/nbu-pflicht).
  { key: "nbu_pct", label: "NBU", hint: NBU_HINWEIS_KURZ, hintTooltip: NBU_HINWEIS_LANG },
  { key: "bvg_pct", label: "BVG" },
  { key: "ktg_pct", label: "KTG" },
  { key: "quellensteuer_pct", label: "Quellensteuer" },
];

export const AG_FIELDS: Array<PctFeld & { key: PctKey }> = [
  { key: "employer_ahv_pct", label: "AHV/IV/EO" },
  { key: "employer_alv_pct", label: "ALV" },
  { key: "employer_fak_pct", label: "FAK" },
  { key: "employer_bu_pct", label: "BU" },
  { key: "employer_bvg_pct", label: "BVG" },
  { key: "employer_verwaltung_pct", label: "Verwaltung" },
];
