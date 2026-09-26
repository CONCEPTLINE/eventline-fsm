"use client";

/**
 * Partner-Anfrage-Banner — Admin-Aktion oberhalb aller Tabs.
 *
 * Zwei Faelle:
 *  - NEUE Anfrage: Annehmen (-> offener Auftrag) oder Ablehnen (Grund).
 *  - AENDERUNG einer bestaetigten Anfrage (jobs.partner_aenderung gesetzt,
 *    Vorfall Barakuba 2026-09): Vorher/Nachher-Vergleich der geaenderten
 *    Felder + Termine, Aktion "Aenderung bestaetigen" (zurueck in den
 *    vorherigen Status). Ablehnen gibt es hier bewusst nicht — Unklar-
 *    heiten werden mit dem Partner geklaert, solange bleibt die Anfrage
 *    ausstehend.
 *
 * Self-contained: laedt Aenderungs-Snapshot + aktuelle Werte selbst
 * (die Auftragsseite muss nichts durchreichen).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle, XCircle, ArrowRight, Plus, Minus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/use-confirm";

type Props = {
  jobId: string;
  onDecided: () => void | Promise<void>;
  onOpenReject: () => void;
};

interface TerminLite {
  title: string;
  start_time: string;
  end_time: string | null;
}

interface Aenderung {
  von_status: string;
  vorher: {
    title: string | null;
    description: string | null;
    start_date: string | null;
    end_date: string | null;
    contact_person: string | null;
    contact_phone: string | null;
    contact_email: string | null;
  };
  termine_vorher: TerminLite[];
  eingereicht_at: string;
  eingereicht_von: string;
}

function tag(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
}

function zeit(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function terminLabel(t: TerminLite): string {
  const bis = t.end_time
    ? `–${new Date(t.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`
    : "";
  return `${t.title} · ${zeit(t.start_time)}${bis}`;
}

export function PartnerAnfrageBanner({ jobId, onDecided, onOpenReject }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [aenderung, setAenderung] = useState<Aenderung | null>(null);
  const [aktuell, setAktuell] = useState<Aenderung["vorher"] | null>(null);
  const [termineJetzt, setTermineJetzt] = useState<TerminLite[]>([]);

  const laden = useCallback(async () => {
    const [{ data: job }, { data: termine }] = await Promise.all([
      supabase
        .from("jobs")
        .select("title, description, start_date, end_date, contact_person, contact_phone, contact_email, partner_aenderung")
        .eq("id", jobId)
        .maybeSingle(),
      supabase
        .from("job_appointments")
        .select("title, start_time, end_time")
        .eq("job_id", jobId)
        .order("start_time"),
    ]);
    setAenderung((job?.partner_aenderung as Aenderung | null) ?? null);
    setAktuell(job ? {
      title: job.title, description: job.description, start_date: job.start_date, end_date: job.end_date,
      contact_person: job.contact_person, contact_phone: job.contact_phone, contact_email: job.contact_email,
    } : null);
    setTermineJetzt((termine ?? []) as TerminLite[]);
  }, [supabase, jobId]);

  useEffect(() => { void laden(); }, [laden]);

  const istAenderung = aenderung !== null;

  // ── Diff (nur geaenderte Punkte anzeigen) ──────────────────────
  const diffs: { label: string; vorher: string; nachher: string }[] = [];
  if (istAenderung && aktuell && aenderung) {
    const v = aenderung.vorher;
    if ((v.title ?? "") !== (aktuell.title ?? "")) diffs.push({ label: "Titel", vorher: v.title ?? "—", nachher: aktuell.title ?? "—" });
    const zeitraumVorher = `${tag(v.start_date)}${v.end_date && v.end_date !== v.start_date ? ` – ${tag(v.end_date)}` : ""}`;
    const zeitraumJetzt = `${tag(aktuell.start_date)}${aktuell.end_date && aktuell.end_date !== aktuell.start_date ? ` – ${tag(aktuell.end_date)}` : ""}`;
    if (zeitraumVorher !== zeitraumJetzt) diffs.push({ label: "Datum", vorher: zeitraumVorher, nachher: zeitraumJetzt });
    if ((v.description ?? "") !== (aktuell.description ?? "")) diffs.push({ label: "Beschreibung", vorher: (v.description ?? "—").slice(0, 80), nachher: (aktuell.description ?? "—").slice(0, 80) });
    if ((v.contact_person ?? "") !== (aktuell.contact_person ?? "") || (v.contact_phone ?? "") !== (aktuell.contact_phone ?? "")) {
      diffs.push({
        label: "Kontakt",
        vorher: [v.contact_person, v.contact_phone].filter(Boolean).join(" · ") || "—",
        nachher: [aktuell.contact_person, aktuell.contact_phone].filter(Boolean).join(" · ") || "—",
      });
    }
  }
  // Termine: entfernt / neu / (gleicher Titel, andere Zeit)
  const termineDiff: { art: "neu" | "weg" | "geaendert"; text: string }[] = [];
  if (istAenderung && aenderung) {
    const vorher = aenderung.termine_vorher ?? [];
    for (const t of termineJetzt) {
      const alt = vorher.find((x) => x.title === t.title);
      if (!alt) termineDiff.push({ art: "neu", text: terminLabel(t) });
      else if (alt.start_time !== t.start_time || (alt.end_time ?? "") !== (t.end_time ?? "")) {
        termineDiff.push({ art: "geaendert", text: `${t.title}: ${zeit(alt.start_time)} → ${zeit(t.start_time)}` });
      }
    }
    for (const alt of vorher) {
      if (!termineJetzt.find((x) => x.title === alt.title)) termineDiff.push({ art: "weg", text: terminLabel(alt) });
    }
  }

  async function accept() {
    const ok = await confirm({
      title: istAenderung ? "Änderung bestätigen?" : "Partner-Anfrage annehmen?",
      message: istAenderung
        ? "Der neue Stand gilt — die Anfrage geht zurück in den bestätigten Zustand und der Partner wird informiert. Zugeteilte Termine bitte kurz gegenprüfen."
        : "Die Anfrage wird ein offener Auftrag in eurer Pipeline. Der Partner sieht den Status danach read-only und kann nichts mehr ändern.",
      confirmLabel: istAenderung ? "Änderung bestätigen" : "Annehmen",
      variant: "blue",
    });
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/jobs/${jobId}/partner-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept", message: "" }),
    });
    const json = await res.json();
    setBusy(false);
    if (!json.success) {
      toast.error(json.error ?? "Aktion fehlgeschlagen");
      return;
    }
    toast.success(istAenderung ? "Änderung bestätigt" : "Anfrage angenommen");
    window.dispatchEvent(new Event("jobs:invalidate"));
    await onDecided();
  }

  return (
    <>
      <Card className="bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 mb-6">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
            <div className="text-sm flex-1 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-200">
                {istAenderung ? "Partner-Änderung" : "Partner-Anfrage"}
              </p>
              <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                {istAenderung
                  ? `${aenderung!.eingereicht_von} hat die bestätigte Anfrage am ${zeit(aenderung!.eingereicht_at)} angepasst — Änderung prüfen und bestätigen. Bis dahin gilt sie als ausstehend.`
                  : "Diese Anfrage kam vom Location-Partner. Annahme = wird offener Auftrag. Ablehnung = Partner sieht den Grund."}
              </p>

              {istAenderung && (diffs.length > 0 || termineDiff.length > 0) && (
                <div className="mt-2 rounded-lg bg-white/60 dark:bg-black/20 border border-amber-200/70 dark:border-amber-500/25 px-3 py-2 space-y-1">
                  {diffs.map((d) => (
                    <p key={d.label} className="text-xs text-amber-900 dark:text-amber-100 flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold w-24 shrink-0">{d.label}</span>
                      <span className="line-through opacity-60">{d.vorher}</span>
                      <ArrowRight className="h-3 w-3 shrink-0" />
                      <span className="font-medium">{d.nachher}</span>
                    </p>
                  ))}
                  {termineDiff.map((t, i) => (
                    <p key={i} className="text-xs text-amber-900 dark:text-amber-100 flex items-center gap-1.5">
                      {t.art === "neu" ? <Plus className="h-3 w-3 shrink-0 text-green-600" /> : t.art === "weg" ? <Minus className="h-3 w-3 shrink-0 text-red-600" /> : <ArrowRight className="h-3 w-3 shrink-0" />}
                      <span className="font-semibold w-[5.25rem] shrink-0">{t.art === "neu" ? "Neuer Termin" : t.art === "weg" ? "Entfernt" : "Verschoben"}</span>
                      <span>{t.text}</span>
                    </p>
                  ))}
                </div>
              )}
              {istAenderung && diffs.length === 0 && termineDiff.length === 0 && (
                <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mt-1.5 italic">
                  Bisher keine inhaltliche Abweichung erfasst — der Partner ist evtl. noch am Bearbeiten.
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <button
              type="button"
              onClick={accept}
              disabled={busy}
              className="kasten kasten-green"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              {istAenderung ? "Änderung bestätigen" : "Annehmen"}
            </button>
            {istAenderung ? (
              <span className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
                Unklarheiten? Partner direkt kontaktieren — die Anfrage bleibt bis zur Bestätigung ausstehend.
              </span>
            ) : (
              <button
                type="button"
                onClick={onOpenReject}
                disabled={busy}
                className="kasten kasten-red"
              >
                <XCircle className="h-3.5 w-3.5" />
                Ablehnen
              </button>
            )}
          </div>
        </CardContent>
      </Card>
      {ConfirmModalElement}
    </>
  );
}
