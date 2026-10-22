"use client";

// /auftraege/mails — Mails an auftrag@in…, die keinem Auftrag sicher
// zugeordnet werden konnten. Ein Admin waehlt den Auftrag (Vorschlag mit
// einem Klick oder Auswahlfeld + «Zuordnen») oder verwirft die Mail.
// Danach laeuft die normale Verarbeitung (Eingang + KI). Laptop-Seite,
// Recht auftraege:see-all (Admin immer).

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Inbox, MailQuestion } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { BackButton } from "@/components/ui/back-button";
import { EmptyState } from "@/components/ui/empty-state";
import type { SelectItem } from "@/components/searchable-select";
import { MailKarte, type WarteMail } from "@/components/auftrag/mails/mail-karte";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/lib/use-permissions";
import { formatLocalDate } from "@/lib/utils";


export default function AuftragsMailsPage() {
  const { can, ready } = usePermissions();
  const darf = can("auftraege:see-all");
  const [mails, setMails] = useState<WarteMail[] | null>(null);
  const [auftraege, setAuftraege] = useState<SelectItem[]>([]);

  const laden = useCallback(async () => {
    try {
      const res = await fetch("/api/auftrag-mails", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMails(json.mails as WarteMail[]);
    } catch (e) {
      toast.error("Mails konnten nicht geladen werden: " + (e instanceof Error ? e.message : String(e)));
      setMails([]);
    }
  }, []);

  useEffect(() => {
    if (!darf) return;
    laden();
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("jobs")
        .select("id, job_number, title, start_date, customer:customers(name)")
        .not("status", "in", "(abgeschlossen,storniert)")
        .not("is_deleted", "is", true)
        .order("start_date", { ascending: false, nullsFirst: true })
        .limit(500);
      if (error) {
        toast.error("Aufträge konnten nicht geladen werden: " + error.message);
        return;
      }
      setAuftraege(
        ((data ?? []) as unknown as { id: string; job_number: number; title: string | null; start_date: string | null; customer: { name: string } | { name: string }[] | null }[]).map((j) => {
          const kunde = Array.isArray(j.customer) ? j.customer[0]?.name : j.customer?.name;
          return {
            id: j.id,
            label: `INT-${j.job_number} · ${j.title ?? ""}`,
            sub: [j.start_date ? formatLocalDate(j.start_date) : null, kunde].filter(Boolean).join(" · ") || undefined,
          };
        }),
      );
    })();
  }, [darf, laden]);

  const entfernen = (id: string) => setMails((m) => (m ?? []).filter((x) => x.id !== id));

  if (ready && !darf) {
    return <EmptyState icon={MailQuestion} title="Keine Berechtigung" description="Diese Seite ist für Konten mit Zugriff auf alle Aufträge." />;
  }

  return (
    <div className="space-y-4 page-enter max-w-5xl">
      <div className="flex items-center gap-4 min-h-9">
        <BackButton fallbackHref="/auftraege" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mails zuordnen</h1>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Weitergeleitete Mails an auftrag@in.eventline-basel.com, die keinem Auftrag sicher zugeordnet werden konnten.
          </p>
        </div>
      </div>

      {mails === null ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : mails.length === 0 ? (
        <EmptyState icon={Inbox} title="Keine Mail wartet" description="Alle Auftrags-Mails sind zugeordnet." />
      ) : (
        <div className="space-y-3">
          {mails.map((m) => (
            <MailKarte key={m.id} mail={m} auftraege={auftraege} onErledigt={() => entfernen(m.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
