"use client";

/**
 * Stundenkontrolle pro Auftrag (admin-only).
 *
 * Zeigt pro Mitarbeiter, der entweder gestempelt ODER im Rapport gelistet
 * ist:  Gestempelte Stunden | Rapport-Stunden | Differenz
 *
 * Differenz farbcodiert nach Toleranz:
 *   |diff| ≤ 15 min  → gruen (Rundungs-Toleranz)
 *   |diff| ≤ 60 min  → gelb  (kleine Abweichung, evtl. Pause-Buchung)
 *   |diff| >  60 min → rot   (echtes Audit-Signal)
 *
 * Daten kommen aus dem RPC public.get_job_hours_audit(p_job_id), der
 * intern is_admin() checkt — also kein UI-seitiger admin-Guard noetig
 * neben dem `if (isAdmin)` im Parent.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Scale } from "lucide-react";

export interface HoursAuditRow {
  user_id: string;
  user_name: string;
  stempel_minutes: number;
  /** Verrechenbare Rapport-Minuten (ohne not_billable Ranges). */
  rapport_minutes: number;
  /** Bewusst nicht-verrechnete Rapport-Minuten — fliessen NICHT in diff_minutes. */
  not_billable_minutes?: number;
  diff_minutes: number;
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return "0h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatDiff(minutes: number): string {
  if (minutes === 0) return "0";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  return `${sign}${formatHours(abs)}`;
}

// Farbe der Differenz nach Toleranz-Stufen.
function diffTone(minutes: number): { text: string; bg: string } {
  const abs = Math.abs(minutes);
  if (abs <= 15) return { text: "text-green-700 dark:text-green-400", bg: "bg-green-50 dark:bg-green-500/10" };
  if (abs <= 60) return { text: "text-amber-700 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-500/10" };
  return { text: "text-red-700 dark:text-red-400", bg: "bg-red-50 dark:bg-red-500/10" };
}

interface Props {
  rows: HoursAuditRow[];
}

export function HoursAuditCard({ rows }: Props) {
  const totalStempel = rows.reduce((s, r) => s + r.stempel_minutes, 0);
  const totalRapport = rows.reduce((s, r) => s + r.rapport_minutes, 0);
  const totalNotBillable = rows.reduce((s, r) => s + (r.not_billable_minutes ?? 0), 0);
  const totalDiff = totalRapport - totalStempel;
  const totalTone = diffTone(totalDiff);
  const hasNotBillable = totalNotBillable > 0;

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Scale className="h-4 w-4" />
          Stundenkontrolle
          <span className="text-[10px] font-normal text-muted-foreground/60 ml-1">
            Stempel vs. Rapport
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                <th className="text-left font-medium pb-2">Mitarbeiter</th>
                <th className="text-right font-medium pb-2">Gestempelt</th>
                <th className="text-right font-medium pb-2">Rapport</th>
                {hasNotBillable && (
                  <th className="text-right font-medium pb-2 text-yellow-700 dark:text-yellow-400">Nicht verr.</th>
                )}
                <th className="text-right font-medium pb-2">Differenz</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const tone = diffTone(r.diff_minutes);
                const nb = r.not_billable_minutes ?? 0;
                return (
                  <tr key={r.user_id}>
                    <td className="py-2 font-medium">{r.user_name}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatHours(r.stempel_minutes)}</td>
                    <td className="py-2 text-right font-mono tabular-nums">{formatHours(r.rapport_minutes)}</td>
                    {hasNotBillable && (
                      <td className="py-2 text-right">
                        {nb > 0 ? (
                          <span className="inline-block px-2 py-0.5 rounded-md font-mono tabular-nums text-xs font-semibold bg-yellow-100 text-yellow-900 dark:bg-yellow-500/20 dark:text-yellow-200">
                            {formatHours(nb)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    )}
                    <td className="py-2 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded-md font-mono tabular-nums text-xs font-semibold ${tone.bg} ${tone.text}`}>
                        {formatDiff(r.diff_minutes)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr className="border-t-2 border-border">
                  <td className="pt-2 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Total</td>
                  <td className="pt-2 text-right font-mono tabular-nums font-semibold">{formatHours(totalStempel)}</td>
                  <td className="pt-2 text-right font-mono tabular-nums font-semibold">{formatHours(totalRapport)}</td>
                  {hasNotBillable && (
                    <td className="pt-2 text-right">
                      <span className="inline-block px-2 py-0.5 rounded-md font-mono tabular-nums text-xs font-bold bg-yellow-100 text-yellow-900 dark:bg-yellow-500/20 dark:text-yellow-200">
                        {formatHours(totalNotBillable)}
                      </span>
                    </td>
                  )}
                  <td className="pt-2 text-right">
                    <span className={`inline-block px-2 py-0.5 rounded-md font-mono tabular-nums text-xs font-bold ${totalTone.bg} ${totalTone.text}`}>
                      {formatDiff(totalDiff)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="text-[10px] text-muted-foreground/70 mt-3">
          Differenz = Rapport (verrechenbar) − Stempel. Gruen ≤ 15min (Rundung), gelb bis 1h, rot &gt; 1h.
          {hasNotBillable && " Bewusst nicht verrechnete Stunden sind separat ausgewiesen und fliessen NICHT in die Differenz."}
        </p>
      </CardContent>
    </Card>
  );
}
