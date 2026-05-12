"use client";

/**
 * Ticket-Detail-Seite.
 *
 * Zeigt alle Details eines Tickets, Anhaenge mit Download-Link, und
 * fuer Admins die Approve/Ablehnen-Buttons. Approve laeuft ueber RPC
 * apply_ticket(), die bei stempel_aenderung atomisch auch das
 * time_entries-Update macht.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BackButton } from "@/components/ui/back-button";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  Wrench, Receipt, Clock, Package, Calendar, User, FileText, Download, Eye,
  CheckCircle2, XCircle, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { PdfPopup } from "@/components/pdf-popup";
import type { TicketWithRelations, TicketType, TicketStatus, TicketDataBeleg, TicketDataMaterial, TicketDataStempelAenderung, TicketDataIT } from "@/types";

const TYPE_META: Record<TicketType, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  it:               { label: "IT-Problem",        icon: Wrench,  color: "text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-500/15" },
  beleg:            { label: "Beleg",              icon: Receipt, color: "text-amber-600  dark:text-amber-400  bg-amber-50  dark:bg-amber-500/15"  },
  stempel_aenderung:{ label: "Stempel-Änderung",  icon: Clock,   color: "text-green-600  dark:text-green-400  bg-green-50  dark:bg-green-500/15"  },
  material:         { label: "Material",          icon: Package, color: "text-red-600    dark:text-red-400    bg-red-50    dark:bg-red-500/15"    },
};

const STATUS_META: Record<TicketStatus, { label: string; classes: string }> = {
  offen:     { label: "Offen",     classes: "bg-blue-100  text-blue-700  dark:bg-blue-500/20  dark:text-blue-300"  },
  erledigt:  { label: "Erledigt",  classes: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" },
  abgelehnt: { label: "Abgelehnt", classes: "bg-red-100   text-red-700   dark:bg-red-500/20   dark:text-red-300"   },
};

export default function TicketDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [ticket, setTicket] = useState<TicketWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const { can } = usePermissions();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Edit-Mode fuer den Ersteller: Title + Description anpassen solange
  // das Ticket noch offen ist (nach Erledigt/Abgelehnt schliesst sich
  // das Fenster). Vorher gabs keinen Edit-Pfad — Tippfehler war Sackgasse.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // Floating Vorschau (Eye-Button) — non-modal, App bleibt bedienbar.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);
  // Bei Beleg-Tickets: aufgeloester Genehmiger (Person-Name oder verlinktes
  // Material-Ticket mit Nummer + Titel).
  const [belegApproval, setBelegApproval] = useState<{ kind: "person" | "ticket"; label: string; href?: string } | null>(null);
  // Bei Stempel-Aenderung: aufgeloester Auftrag (entweder direkt aus
  // data.job_id, oder via time_entries.job_id bei Korrektur). Null = kein
  // Auftrag (Andere Arbeit) ODER noch nicht geladen.
  const [stempelJob, setStempelJob] = useState<{ id: string; job_number: number; title: string } | null>(null);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("tickets")
      .select(`
        *,
        creator:profiles!created_by(full_name),
        assignee:profiles!assigned_to(full_name),
        resolver:profiles!resolved_by(full_name),
        attachments:ticket_attachments(id, filename, storage_path, mime_type)
      `)
      .eq("id", id)
      .maybeSingle();
    if (data) {
      const t = data as unknown as TicketWithRelations;
      setTicket(t);

      // Beleg-Genehmigung aufloesen — entweder Person-Name oder verlinktes
      // Material-Ticket (mit Nummer + Titel als Klick-Link).
      if (t.type === "beleg") {
        const d = (t.data ?? {}) as { genehmigt_von_user_id?: string; genehmigt_via_ticket_id?: string };
        if (d.genehmigt_von_user_id) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", d.genehmigt_von_user_id)
            .maybeSingle();
          setBelegApproval({ kind: "person", label: prof?.full_name ?? "—" });
        } else if (d.genehmigt_via_ticket_id) {
          const { data: tk } = await supabase
            .from("tickets")
            .select("ticket_number, title")
            .eq("id", d.genehmigt_via_ticket_id)
            .maybeSingle();
          if (tk) {
            setBelegApproval({
              kind: "ticket",
              label: `T-${tk.ticket_number} · ${tk.title}`,
              href: `/tickets/${d.genehmigt_via_ticket_id}`,
            });
          }
        } else {
          setBelegApproval(null);
        }
      } else {
        setBelegApproval(null);
      }

      // Stempel-Aenderung: Auftrag aufloesen.
      // - Korrektur (time_entry_id): time_entries -> job_id -> jobs
      // - Vergessen (job_id direkt): jobs
      // - Andere Arbeit oder kein Bezug: stempelJob bleibt null
      if (t.type === "stempel_aenderung") {
        const sd = (t.data ?? {}) as { time_entry_id?: string; job_id?: string };
        let jobId: string | null = null;
        if (sd.time_entry_id) {
          const { data: te } = await supabase
            .from("time_entries")
            .select("job_id")
            .eq("id", sd.time_entry_id)
            .maybeSingle();
          jobId = te?.job_id ?? null;
        } else if (sd.job_id) {
          jobId = sd.job_id;
        }
        if (jobId) {
          const { data: job } = await supabase
            .from("jobs")
            .select("id, job_number, title")
            .eq("id", jobId)
            .maybeSingle();
          setStempelJob(job ? { id: job.id, job_number: job.job_number, title: job.title } : null);
        } else {
          setStempelJob(null);
        }
      } else {
        setStempelJob(null);
      }
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function getSignedUrl(path: string): Promise<string | null> {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return null;
    }
    return data.signedUrl;
  }

  async function previewAttachment(path: string, filename: string) {
    const url = await getSignedUrl(path);
    if (url) setPreviewDoc({ url, title: filename });
  }

  async function downloadAttachment(path: string, filename: string) {
    const url = await getSignedUrl(path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  }

  function startEdit() {
    if (!ticket) return;
    setEditTitle(ticket.title);
    setEditDescription(ticket.description ?? "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!ticket) return;
    if (!editTitle.trim()) {
      toast.error("Titel ist Pflicht");
      return;
    }
    setSavingEdit(true);
    const { error } = await supabase
      .from("tickets")
      .update({
        title: editTitle.trim(),
        description: editDescription.trim() || null,
      })
      .eq("id", ticket.id);
    setSavingEdit(false);
    if (error) {
      TOAST.supabaseError(error, "Speichern fehlgeschlagen");
      return;
    }
    toast.success("Gespeichert");
    setEditing(false);
    await load();
  }

  async function applyStatus(newStatus: "erledigt" | "abgelehnt") {
    if (!ticket) return;
    const ok = await confirm({
      title: newStatus === "erledigt" ? "Ticket als erledigt markieren?" : "Ticket ablehnen?",
      message:
        newStatus === "erledigt" && ticket.type === "stempel_aenderung"
          ? "Die Stempelzeit wird automatisch entsprechend angepasst. Diese Aktion kann nicht rückgängig gemacht werden."
          : `Status wird auf "${newStatus}" gesetzt. Notiz wird an den Ersteller mitgeschickt.`,
      confirmLabel: newStatus === "erledigt" ? "Erledigt" : "Ablehnen",
      variant: newStatus === "erledigt" ? "blue" : "red",
    });
    if (!ok) return;
    setBusy(true);
    const { error } = await supabase.rpc("apply_ticket", {
      p_ticket_id: id,
      p_new_status: newStatus,
      p_resolution_note: resolutionNote.trim() || null,
    });
    if (error) {
      TOAST.supabaseError(error, "Status konnte nicht geändert werden");
      setBusy(false);
      return;
    }
    // Notification an Ersteller.
    fetch("/api/tickets/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_id: id, event: "status_changed", note: resolutionNote.trim() || null }),
    }).catch(() => {});
    toast.success(newStatus === "erledigt" ? "Erledigt" : "Abgelehnt");
    setResolutionNote("");
    setBusy(false);
    await load();
  }

  async function deleteTicket() {
    if (!ticket) return;
    const ok = await confirm({
      title: "Ticket löschen?",
      message: "Das Ticket und alle Anhänge werden unwiderruflich entfernt.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    setBusy(true);
    // Storage-Files mit-löschen (best effort).
    if (ticket.attachments.length > 0) {
      await supabase.storage.from("documents").remove(ticket.attachments.map((a) => a.storage_path));
    }
    const { error } = await supabase.from("tickets").delete().eq("id", id);
    if (error) {
      TOAST.supabaseError(error, "Ticket konnte nicht gelöscht werden");
      setBusy(false);
      return;
    }
    toast.success("Gelöscht");
    router.push("/tickets");
  }

  if (loading) {
    return <div className="space-y-3">{[1,2,3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-6 h-24" /></Card>)}</div>;
  }
  if (!ticket) {
    return <Card className="bg-card"><CardContent className="py-12 text-center text-muted-foreground">Ticket nicht gefunden.</CardContent></Card>;
  }

  const typeMeta = TYPE_META[ticket.type];
  const Icon = typeMeta.icon;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-4">
        <BackButton fallbackHref="/tickets" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-semibold text-muted-foreground">T-{ticket.ticket_number}</span>
            <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full ${STATUS_META[ticket.status].classes}`}>
              {STATUS_META[ticket.status].label}
            </span>
            {ticket.priority === "dringend" && (
              <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">
                Dringend
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold tracking-tight mt-1">{ticket.title}</h1>
        </div>
        {/* Edit-Button fuer den Ersteller — nur solange das Ticket noch
            offen ist. Nach erledigt/abgelehnt friert der Inhalt ein. */}
        {ticket.status === "offen" && currentUserId === ticket.created_by && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className="kasten kasten-purple shrink-0"
            data-tooltip="Bearbeiten"
          >
            Bearbeiten
          </button>
        )}
      </div>

      {/* Edit-Form — Title + Description anpassen. */}
      {editing && (
        <Card className="bg-card border-foreground/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bearbeiten</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Titel *</p>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                disabled={savingEdit}
                className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-card"
                required
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Beschreibung</p>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={4}
                disabled={savingEdit}
                className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-card resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(false)} disabled={savingEdit} className="kasten kasten-muted flex-1">
                Abbrechen
              </button>
              <button type="button" onClick={saveEdit} disabled={savingEdit || !editTitle.trim()} className="kasten kasten-red flex-1">
                {savingEdit ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Hauptinfos */}
      <Card className="bg-card">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${typeMeta.color}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Typ</p>
              <p className="text-sm font-medium">{typeMeta.label}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><User className="h-3 w-3" />Eingereicht von</p>
              <p className="font-medium mt-0.5">{ticket.creator?.full_name ?? "—"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Calendar className="h-3 w-3" />Eingereicht</p>
              <p className="font-medium mt-0.5">
                {new Date(ticket.created_at).toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
            {ticket.assignee && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Zugewiesen an</p>
                <p className="font-medium mt-0.5">{ticket.assignee.full_name}</p>
              </div>
            )}
          </div>

          {ticket.description && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Beschreibung</p>
              <p className="text-sm whitespace-pre-wrap mt-1">{ticket.description}</p>
            </div>
          )}

          <TicketDataDisplay type={ticket.type} data={ticket.data as Record<string, unknown>} stempelJob={stempelJob} />

          {/* Beleg-Genehmigung — aufgeloest aus genehmigt_von_user_id
              oder genehmigt_via_ticket_id. */}
          {ticket.type === "beleg" && belegApproval && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {belegApproval.kind === "person" ? "Genehmigt von" : "Genehmigt via Material-Ticket"}
              </p>
              {belegApproval.href ? (
                <Link href={belegApproval.href} className="text-sm font-medium mt-0.5 text-blue-600 hover:underline inline-block">
                  {belegApproval.label}
                </Link>
              ) : (
                <p className="text-sm font-medium mt-0.5">{belegApproval.label}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Anhänge */}
      {ticket.attachments.length > 0 && (
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" />Anhänge ({ticket.attachments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {ticket.attachments.map((a) => (
                <div key={a.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border">
                  <div className="min-w-0 flex items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm truncate">{a.filename}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => previewAttachment(a.storage_path, a.filename)}
                      className="kasten kasten-blue"
                      data-tooltip="Vorschau"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadAttachment(a.storage_path, a.filename)}
                      className="kasten kasten-muted"
                      data-tooltip="Herunterladen"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Resolution falls erledigt/abgelehnt */}
      {ticket.status !== "offen" && (
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {ticket.status === "erledigt" ? "Erledigt" : "Abgelehnt"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {ticket.resolved_at
                ? new Date(ticket.resolved_at).toLocaleString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
                : "—"}
              {ticket.resolver?.full_name ? ` · von ${ticket.resolver.full_name}` : ""}
            </p>
            {ticket.resolution_note && (
              <p className="text-sm whitespace-pre-wrap">{ticket.resolution_note}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Manage-Aktionen — vorher hardcoded auf isAdmin, jetzt ueber
          tickets:manage-Permission. So kann eine Custom-Rolle wie
          "Buchhaltung" Tickets verwalten ohne Admin sein zu muessen. */}
      {can("tickets:manage") && ticket.status === "offen" && (
        <Card className="bg-card border-foreground/10">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bearbeiten</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz an Ersteller (optional)</p>
              <textarea
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={3}
                disabled={busy}
                className="w-full px-3 py-2 text-sm rounded-xl border border-border bg-card resize-none"
                placeholder="z.B. Beleg ist erstattet · Reset gemacht · Material bestellt"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => applyStatus("erledigt")} disabled={busy} className="kasten kasten-green flex-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Erledigt
              </button>
              <button type="button" onClick={() => applyStatus("abgelehnt")} disabled={busy} className="kasten kasten-red flex-1">
                <XCircle className="h-3.5 w-3.5" />
                Ablehnen
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lösch-Aktion via tickets:manage — aber nur solange das Ticket noch
          aktiv ist. Erledigte/abgelehnte Tickets sind read-only fuer
          Loeschen (Archiv-Konsistenz mit /auftraege + /todos + /kunden). */}
      {can("tickets:manage") && ticket.status !== "erledigt" && ticket.status !== "abgelehnt" && (
        <div className="flex justify-end">
          <button type="button" onClick={deleteTicket} disabled={busy} className="kasten kasten-red">
            <Trash2 className="h-3.5 w-3.5" />Ticket löschen
          </button>
        </div>
      )}

      {ConfirmModalElement}

      {previewDoc && (
        <PdfPopup
          url={previewDoc.url}
          title={previewDoc.title}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
}

// ---- Sub: type-spezifische Daten anzeigen ----
function TicketDataDisplay({ type, data, stempelJob }: { type: TicketType; data: Record<string, unknown>; stempelJob?: { id: string; job_number: number; title: string } | null }) {
  if (!data || Object.keys(data).length === 0) return null;

  if (type === "it") {
    const d = data as unknown as TicketDataIT;
    if (!d.device) return null;
    return (
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Betroffenes Gerät</p>
        <p className="text-sm font-medium mt-0.5">{d.device}</p>
      </div>
    );
  }

  if (type === "beleg") {
    const d = data as unknown as TicketDataBeleg;
    return (
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Betrag</p>
          <p className="text-sm font-mono font-semibold mt-0.5">CHF {d.betrag_chf?.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Kaufdatum</p>
          <p className="text-sm font-medium mt-0.5">{d.kaufdatum ? new Date(d.kaufdatum).toLocaleDateString("de-CH") : "—"}</p>
        </div>
        {d.lieferant && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Lieferant</p>
            <p className="text-sm font-medium mt-0.5">{d.lieferant}</p>
          </div>
        )}
      </div>
    );
  }

  if (type === "stempel_aenderung") {
    const d = data as unknown as TicketDataStempelAenderung;
    const fmt = (iso?: string) => iso ? new Date(iso).toLocaleString("de-CH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Modus</p>
            <p className="text-sm font-medium mt-0.5">{d.time_entry_id ? "Korrektur eines Eintrags" : "Vergessen einzustempeln"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Auftrag</p>
            {stempelJob ? (
              <Link href={`/auftraege/${stempelJob.id}`} className="text-sm font-medium mt-0.5 text-blue-600 hover:underline inline-block truncate max-w-full">
                INT-{stempelJob.job_number} · {stempelJob.title}
              </Link>
            ) : (
              <p className="text-sm font-medium mt-0.5">
                Andere Arbeit{d.beschreibung ? ` · ${d.beschreibung}` : ""}
              </p>
            )}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Neue Start</p>
            <p className="text-sm font-medium mt-0.5">{fmt(d.neu_start)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Neues Ende</p>
            <p className="text-sm font-medium mt-0.5">{fmt(d.neu_end)}</p>
          </div>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Grund</p>
          <p className="text-sm whitespace-pre-wrap mt-1">{d.grund}</p>
        </div>
      </div>
    );
  }

  if (type === "material") {
    const d = data as unknown as TicketDataMaterial;
    const items = Array.isArray(d.items) ? d.items : [];
    const total = items.reduce((sum, it) => sum + (it.betrag_chf ?? 0) * it.menge, 0);
    return (
      <div className="space-y-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Positionen</p>
          <div className="mt-2 space-y-1.5">
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              items.map((it, i) => (
                <div key={i} className="grid grid-cols-12 gap-3 items-center text-sm">
                  <span className="col-span-7 font-medium truncate">{it.artikel}</span>
                  <span className="col-span-2 text-right font-mono tabular-nums">{it.menge}×</span>
                  <span className="col-span-3 text-right font-mono tabular-nums">
                    {typeof it.betrag_chf === "number" ? `CHF ${it.betrag_chf.toFixed(2)}` : "—"}
                  </span>
                </div>
              ))
            )}
            {items.length > 1 && total > 0 && (
              <div className="grid grid-cols-12 gap-3 items-center text-sm pt-1.5 border-t-2 border-border">
                <span className="col-span-9 font-semibold uppercase text-xs tracking-wider text-muted-foreground">Total</span>
                <span className="col-span-3 text-right font-mono tabular-nums font-semibold">CHF {total.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>
        {d.auftrag_id && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Auftrag</p>
            <Link href={`/auftraege/${d.auftrag_id}`} className="text-sm font-medium mt-0.5 text-blue-600 hover:underline inline-block">
              Auftrag öffnen
            </Link>
          </div>
        )}
      </div>
    );
  }

  return null;
}
