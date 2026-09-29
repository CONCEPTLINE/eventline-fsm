"use client";

// Backup-Tab der NAS-Seite: zeigt den Zustand des naechtlichen
// UGREEN-Backups (Meldungen des Backup-Containers via
// /api/nas/backup-status). Bei Problemen mailt zusaetzlich der
// taegliche Cron nas-backup-check alle Admins — dieser Tab ist die
// Sicht-Kontrolle dazu.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, HelpCircle, Loader2, Database, HardDrive, Files } from "lucide-react";

interface RunRow {
  id: string;
  run_date: string;
  status: "ok" | "fehler";
  total_size: string | null;
  db_size: string | null;
  storage_size: string | null;
  reported_at: string;
}
interface StatusResponse {
  success: boolean;
  zustand: "ok" | "stale" | "fehler" | "nie";
  stale_stunden: number;
  letzter_ok: RunRow | null;
  runs: RunRow[];
}

function fmtWann(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function BackupTab() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/nas/backup-status");
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
        setData(json as StatusResponse);
      } catch (e) {
        setFehler(e instanceof Error ? e.message : "Laden fehlgeschlagen");
      }
    })();
  }, []);

  if (fehler) return <p className="text-sm text-red-600 dark:text-red-400">{fehler}</p>;
  if (!data) return <div className="h-40 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;

  const banner = {
    ok: {
      cls: "border-green-300 bg-green-50 dark:bg-green-500/10 dark:border-green-500/30 text-green-800 dark:text-green-300",
      Icon: CheckCircle2,
      titel: "Backup läuft",
      text: `Letzter erfolgreicher Lauf: ${data.letzter_ok ? fmtWann(data.letzter_ok.reported_at) : "—"}. Gesichert wird jede Nacht um 03:00 (Datenbank + alle Dokumente).`,
    },
    stale: {
      cls: "border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/30 text-red-800 dark:text-red-300",
      Icon: AlertTriangle,
      titel: "Backup überfällig",
      text: `Seit über ${data.stale_stunden} Stunden keine erfolgreiche Meldung${data.letzter_ok ? ` (letzter OK-Lauf: ${fmtWann(data.letzter_ok.reported_at)})` : ""}. Bitte auf dem UGREEN das Log des Containers «eventline-backup» prüfen. Die Admins wurden per Mail gewarnt.`,
    },
    fehler: {
      cls: "border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/30 text-red-800 dark:text-red-300",
      Icon: AlertTriangle,
      titel: "Letzter Lauf fehlgeschlagen",
      text: "Der Backup-Container hat den letzten Lauf als fehlgeschlagen gemeldet — bitte auf dem UGREEN das Log des Containers «eventline-backup» prüfen.",
    },
    nie: {
      cls: "border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-200",
      Icon: HelpCircle,
      titel: "Noch keine Meldung empfangen",
      text: "Der Backup-Container hat sich noch nie gemeldet. Entweder lief seit der Einrichtung noch kein Backup (nächster Lauf: 03:00), oder auf dem NAS fehlt noch die aktualisierte Backup-Konfiguration mit der Melde-Funktion.",
    },
  }[data.zustand];

  return (
    <div className="space-y-4">
      <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${banner.cls}`}>
        <banner.Icon className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">{banner.titel}</p>
          <p className="mt-0.5 opacity-90">{banner.text}</p>
        </div>
      </div>

      {data.letzter_ok && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: "Datenbank", wert: data.letzter_ok.db_size, Icon: Database },
            { label: "Dokumente", wert: data.letzter_ok.storage_size, Icon: Files },
            { label: "Gesamt", wert: data.letzter_ok.total_size, Icon: HardDrive },
          ].map((k) => (
            <Card key={k.label} className="bg-card">
              <CardContent className="p-4 flex items-center gap-3">
                <k.Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{k.label}</p>
                  <p className="text-sm font-semibold tabular-nums">{k.wert ?? "—"}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Letzte Läufe</CardTitle>
        </CardHeader>
        <CardContent>
          {data.runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine Meldungen.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.runs.map((r) => (
                <li key={r.id} className="py-2 flex items-center gap-2.5 text-sm">
                  {r.status === "ok"
                    ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    : <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />}
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{r.run_date}</span>
                  <span className="text-xs text-muted-foreground flex-1 truncate">
                    gemeldet {fmtWann(r.reported_at)}
                  </span>
                  {r.total_size && <span className="text-xs tabular-nums shrink-0">{r.total_size}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="h-3 w-3" />
        Automatische Überwachung: bleibt eine erfolgreiche Meldung länger als {data.stale_stunden} Stunden aus, erhalten alle Admins täglich um ca. 08:00 eine Warn-Mail.
      </p>
    </div>
  );
}
