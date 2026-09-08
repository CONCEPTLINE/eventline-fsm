"use client";

/**
 * /entwuerfe/[id] — Detail eines Auftrags-Entwurfs.
 *
 * Layout analog zu /auftraege/[id] und /projekte/[id]:
 *   - Sticky-Header (Nummer ENT-XXX, Titel, Status-Chip, Action-Bar, TabsNav)
 *   - 2 Tabs: Uebersicht | Notizen
 *   - Modals via useConfirm (Storno, In-Auftrag-Umwandlung)
 *
 * Tab-State lebt in der URL (?tab=uebersicht|notizen) — §10 Reload-Persistent.
 *
 * Owner + Kunde + Location + Datum + General-Notes sind INLINE editierbar
 * ueber SearchableSelect / Input / Textarea mit onBlur-Autosave. Kein
 * "Bearbeiten"-Modal weil ein Draft von Iteration lebt — jeder soll
 * jederzeit was aendern koennen ohne Modal-Overhead.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRightCircle,
  Calendar,
  FileText,
  Info,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Trash2,
  User as UserIcon,
  Users,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { BackButton } from "@/components/ui/back-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/spinner";
import { TabsNav } from "@/components/ui/tabs-nav";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { createClient } from "@/lib/supabase/client";

type TabKey = "uebersicht" | "notizen";
type NoteKind = "notiz" | "anruf" | "mail" | "meeting";

interface DraftDetail {
  id: string;
  draft_number: number;
  title: string;
  description: string | null;
  status: "aktiv" | "wartet_auf_kunde" | "storniert" | "umgewandelt";
  source: string;
  customer_id: string | null;
  customer_name: string | null;
  contact_person: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  location_id: string | null;
  location_name: string | null;
  room_id: string | null;
  expected_start_date: string | null;
  expected_end_date: string | null;
  guest_count: number | null;
  owner_id: string | null;
  general_notes: string | null;
  converted_to_job_id: string | null;
  converted_at: string | null;
  created_at: string;
  updated_at: string;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  location: {
    id: string;
    name: string;
    address_street: string | null;
    address_zip: string | null;
    address_city: string | null;
  } | null;
  room: { id: string; name: string } | null;
  owner: { id: string; full_name: string } | null;
}

interface DraftNote {
  id: string;
  draft_id: string;
  author_id: string | null;
  kind: NoteKind;
  body: string;
  created_at: string;
  author: { id: string; full_name: string } | null;
}

interface Customer {
  id: string;
  name: string;
}
interface Location {
  id: string;
  name: string;
  address_street?: string | null;
  address_zip?: string | null;
  address_city?: string | null;
}
interface OwnerOption {
  id: string;
  full_name: string;
}

const STATUS_CHIP: Record<DraftDetail["status"], { label: string; color: string }> = {
  aktiv: { label: "Aktiv", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  wartet_auf_kunde: { label: "Wartet auf Kunde", color: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  storniert: { label: "Storniert", color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
  umgewandelt: { label: "Umgewandelt", color: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" },
};

const NOTE_KIND_META: Record<NoteKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  notiz: { label: "Notiz", icon: FileText },
  anruf: { label: "Anruf", icon: Phone },
  mail: { label: "Mail", icon: Mail },
  meeting: { label: "Meeting", icon: Users },
};

function formatDateRange(from: string | null, to: string | null): string {
  if (!from && !to) return "—";
  const fmt = (iso: string) =>
    new Date(iso + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
  if (from && to && from !== to) return `${fmt(from)} – ${fmt(to)}`;
  return fmt(from ?? to!);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
}

// Inline editable-text helper — kommt in Kunde/Location/Notes-Card zurueck.
function InlineTextarea({
  value,
  onSave,
  placeholder,
  rows = 3,
  disabled = false,
}: {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <textarea
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== value) onSave(local);
      }}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      style={{ fieldSizing: "content" } as React.CSSProperties}
      className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring disabled:opacity-60"
    />
  );
}

export default function EntwurfDetailPage() {
  const { id } = useParams<{ id: string }>();
  const draftId = id;
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [draft, setDraft] = useState<DraftDetail | null>(null);
  const [notes, setNotes] = useState<DraftNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [convertBusy, setConvertBusy] = useState(false);

  const [newNoteKind, setNewNoteKind] = useState<NoteKind>("notiz");
  const [newNoteBody, setNewNoteBody] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);

  const urlTab = searchParams.get("tab") as TabKey | null;
  const activeTab: TabKey = urlTab === "notizen" ? "notizen" : "uebersicht";

  const setTab = useCallback(
    (t: TabKey) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", t);
      router.replace(`/entwuerfe/${draftId}?${params.toString()}`, { scroll: false });
    },
    [router, searchParams, draftId],
  );

  // Reload-Counter fuer Race-Sicherheit: schnelle onBlur-Autosaves
  // triggern mehrere load()-Aufrufe kurz nacheinander — nur die zuletzt
  // gestartete Antwort darf den State ueberschreiben.
  const loadReqIdRef = useRef(0);
  const load = useCallback(async () => {
    const myId = ++loadReqIdRef.current;
    try {
      const res = await fetch(`/api/entwuerfe/${draftId}`, { cache: "no-store" });
      const json = await res.json();
      if (loadReqIdRef.current !== myId) return;
      if (!json.success) {
        toast.error(json.error ?? "Konnte Entwurf nicht laden");
        setDraft(null);
        return;
      }
      setDraft(json.draft as DraftDetail);
      setNotes(json.notes as DraftNote[]);
    } catch (err) {
      if (loadReqIdRef.current !== myId) return;
      toast.error(err instanceof Error ? err.message : "Netzwerk-Fehler");
    } finally {
      if (loadReqIdRef.current === myId) setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    load();
  }, [load]);

  // Referenz-Daten fuer die inline-Selects. Wird einmalig geladen.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [c, l, o] = await Promise.all([
        supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
        supabase
          .from("locations")
          .select("id, name, address_street, address_zip, address_city")
          .eq("is_active", true)
          .order("name"),
        supabase.rpc("get_assignable_users"),
      ]);
      if (!alive) return;
      setCustomers((c.data as Customer[]) ?? []);
      setLocations((l.data as Location[]) ?? []);
      setOwners((o.data as OwnerOption[]) ?? []);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!draft) return;
      // Optimistischer Merge auf den flachen Feldern → onBlur-Autosave
      // flackert nicht. Nested Refs (customer/location/owner) werden
      // durch das nachfolgende race-safe load() aufgefrischt.
      setDraft((prev) => (prev ? ({ ...prev, ...fields } as DraftDetail) : prev));
      setSaving(true);
      try {
        const res = await fetch(`/api/entwuerfe/${draft.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        });
        const json = await res.json();
        if (!json.success) {
          toast.error(json.error ?? "Speichern fehlgeschlagen");
        }
        await load();
      } finally {
        setSaving(false);
      }
    },
    [draft, load],
  );

  async function cancelDraft() {
    if (!draft) return;
    const ok = await confirm({
      title: "Entwurf stornieren?",
      message:
        "Der Entwurf wird als storniert markiert und aus der Aktiv-Liste entfernt. Über den Segment-Toggle bleibt er auffindbar.",
      confirmLabel: "Stornieren",
      variant: "red",
    });
    if (!ok) return;
    await patch({ status: "storniert" });
    toast.success("Entwurf storniert");
  }

  async function reactivateDraft() {
    if (!draft) return;
    await patch({ status: "aktiv" });
    toast.success("Entwurf wieder aktiv");
  }

  async function convertToJob() {
    if (!draft) return;
    const ok = await confirm({
      title: "Entwurf in Auftrag umwandeln?",
      message: `ENT-${draft.draft_number} wird archiviert (Status: umgewandelt) und ein neuer Auftrag entsteht daraus. Die Notizen-Historie bleibt am Entwurf. Der neue Auftrag öffnet sich anschliessend.`,
      confirmLabel: "In Auftrag umwandeln",
      variant: "blue",
    });
    if (!ok) return;
    setConvertBusy(true);
    try {
      const res = await fetch(`/api/entwuerfe/${draft.id}/convert`, { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        toast.error(json.error ?? "Umwandlung fehlgeschlagen");
        return;
      }
      toast.success(
        json.customerCreated
          ? `Auftrag angelegt · Kunde neu erstellt`
          : `Auftrag angelegt`,
      );
      window.dispatchEvent(new Event("jobs:invalidate"));
      router.push(json.redirectUrl as string);
    } finally {
      setConvertBusy(false);
    }
  }

  async function addNote() {
    if (!newNoteBody.trim() || !draft) return;
    setNoteBusy(true);
    try {
      const res = await fetch(`/api/entwuerfe/${draft.id}/notizen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: newNoteKind, body: newNoteBody }),
      });
      const json = await res.json();
      if (!json.success) {
        toast.error(json.error ?? "Notiz konnte nicht angelegt werden");
        return;
      }
      setNewNoteBody("");
      await load();
      toast.success("Notiz hinzugefügt");
    } finally {
      setNoteBusy(false);
    }
  }

  async function deleteNote(noteId: string) {
    if (!draft) return;
    const ok = await confirm({
      title: "Notiz löschen?",
      message: "Die Notiz wird unwiderruflich entfernt.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const res = await fetch(`/api/entwuerfe/${draft.id}/notizen/${noteId}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.success) {
      toast.error(json.error ?? "Löschen fehlgeschlagen");
      return;
    }
    await load();
  }

  const tabs = useMemo(
    () => [
      { key: "uebersicht", label: "Übersicht", icon: <Info className="h-4 w-4" /> },
      {
        key: "notizen",
        label: "Notizen",
        icon: <MessageSquare className="h-4 w-4" />,
        badge: notes.length > 0 ? notes.length : undefined,
      },
    ],
    [notes.length],
  );

  if (loading) return <Loading className="py-20" label="Laden…" />;
  if (!draft)
    return (
      <div className="max-w-5xl mx-auto py-10 text-sm text-muted-foreground">
        Entwurf nicht gefunden.
      </div>
    );

  const statusChip = STATUS_CHIP[draft.status];
  const isArchived = draft.status === "storniert" || draft.status === "umgewandelt";

  return (
    <div className="max-w-5xl mx-auto page-enter">
      {/* Sticky-Header */}
      <div className="sticky top-0 z-20 bg-[#f5f5f7]/85 dark:bg-[#0a0a0a]/85 backdrop-blur-md pt-1 pb-4 mb-8">
        <div className="flex items-start gap-3">
          <BackButton fallbackHref="/entwuerfe" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center font-mono font-semibold rounded-md bg-card border border-foreground/10 dark:border-foreground/15 text-[13px] px-2 py-0.5 tabular-nums whitespace-nowrap">
                ENT-{draft.draft_number}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full ${statusChip.color}`}
              >
                {statusChip.label}
              </span>
              {draft.converted_to_job_id && (
                <Link
                  href={`/auftraege/${draft.converted_to_job_id}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300 hover:opacity-80"
                  data-tooltip="Zum umgewandelten Auftrag"
                >
                  <ArrowRightCircle className="h-3 w-3" />
                  Auftrag oeffnen
                </Link>
              )}
              {saving && (
                <span className="text-[11px] text-muted-foreground italic">wird gespeichert…</span>
              )}
            </div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate mt-0.5">
              {draft.title}
            </h1>
            {(draft.customer?.name || draft.customer_name || draft.location?.name || draft.location_name || draft.expected_start_date || draft.expected_end_date) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-1">
                {(draft.customer?.name || draft.customer_name) && (
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <UserIcon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{draft.customer?.name ?? draft.customer_name}</span>
                  </span>
                )}
                {(draft.location?.name || draft.location_name) && (
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <MapPin className="h-3 w-3 shrink-0" />
                    <span className="truncate">{draft.location?.name ?? draft.location_name}</span>
                  </span>
                )}
                {(draft.expected_start_date || draft.expected_end_date) && (
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="h-3 w-3 shrink-0" />
                    <span className="tabular-nums">
                      {formatDateRange(draft.expected_start_date, draft.expected_end_date)}
                    </span>
                  </span>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">
              Angelegt {formatDateTime(draft.created_at)}
              {draft.updated_at !== draft.created_at && (
                <> · Zuletzt bearbeitet {formatDateTime(draft.updated_at)}</>
              )}
            </p>
          </div>
        </div>

        {/* Aktions-Bar */}
        {!isArchived && (
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              type="button"
              onClick={convertToJob}
              disabled={convertBusy}
              className="kasten kasten-green"
              data-tooltip="Entwurf zu einem echten Auftrag machen"
            >
              <ArrowRightCircle className="h-4 w-4" />
              {convertBusy ? "Umwandeln…" : "In Auftrag umwandeln"}
            </button>
            {/* Status wartet_auf_kunde/aktiv-Toggle. Ein einziger Button — Klick
                dreht den Status. */}
            {draft.status === "aktiv" ? (
              <button
                type="button"
                onClick={() => patch({ status: "wartet_auf_kunde" })}
                className="kasten kasten-muted"
              >
                Wartet auf Kunde
              </button>
            ) : draft.status === "wartet_auf_kunde" ? (
              <button
                type="button"
                onClick={() => patch({ status: "aktiv" })}
                className="kasten kasten-muted"
              >
                Als aktiv markieren
              </button>
            ) : null}
            <button type="button" onClick={cancelDraft} className="kasten kasten-red">
              <XCircle className="h-4 w-4" />
              Stornieren
            </button>
          </div>
        )}
        {draft.status === "storniert" && (
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" onClick={reactivateDraft} className="kasten kasten-muted">
              Wieder aktivieren
            </button>
          </div>
        )}

        {/* TabsNav */}
        <TabsNav
          tabs={tabs}
          active={activeTab}
          onChange={(k) => setTab(k as TabKey)}
          className="mt-3"
          ariaLabel="Entwurf-Bereiche"
        />
      </div>

      {/* Tab-Inhalt */}
      {activeTab === "uebersicht" && (
        <div className={`space-y-4 ${isArchived ? "opacity-80" : ""}`}>
          {/* Kunde + Kontakt */}
          <Card className="bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Kunde & Kontakt
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    Kunde
                  </label>
                  {/* EIN Feld: Dropdown zeigt gewaehlten Kunden ODER
                      Freitext (customer_name) im selben Trigger. Das
                      separate Freitext-Input darunter war verwirrend —
                      User dachte Text sei verloren (Leo 2026-09-06). */}
                  <SearchableSelect
                    value={draft.customer_id ?? ""}
                    onChange={(id) =>
                      // Auswahl-Aenderung raeumt Freitext IMMER: Item picken
                      // ODER X-Button = beide Wahrheiten koennen nicht
                      // gleichzeitig gelten.
                      patch({
                        customer_id: id || null,
                        customer_name: null,
                      })
                    }
                    items={customers.map((c) => ({ id: c.id, label: c.name }))}
                    placeholder="Kunde wählen oder eintippen…"
                    clearable
                    freeTextDisplay={draft.customer_name ?? ""}
                    onCreateNew={(q) =>
                      patch({ customer_id: null, customer_name: q })
                    }
                    createNewLabel="Neuer Kunde"
                    commitFreeTextOnBlur
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    Ansprechperson
                  </label>
                  <Input
                    defaultValue={draft.contact_person ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (draft.contact_person ?? "")) patch({ contact_person: v || null });
                    }}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    E-Mail
                  </label>
                  <Input
                    type="email"
                    defaultValue={draft.contact_email ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (draft.contact_email ?? "")) patch({ contact_email: v || null });
                    }}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    Telefon
                  </label>
                  <Input
                    type="tel"
                    defaultValue={draft.contact_phone ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (draft.contact_phone ?? "")) patch({ contact_phone: v || null });
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Location */}
          <Card className="bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5" />
                Location
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {/* EIN Feld (analog Kunde): Dropdown zeigt gewaehlte Location
                  ODER Freitext (location_name) im gleichen Trigger. Text
                  bleibt via freeTextDisplay nach Enter/Blur sichtbar. */}
              <SearchableSelect
                value={draft.location_id ?? ""}
                onChange={(id) =>
                  patch({
                    location_id: id || null,
                    // Item picken ODER X-Button raeumt Freitext IMMER.
                    location_name: null,
                  })
                }
                items={locations.map((l) => ({
                  id: l.id,
                  label: l.name,
                  sub: [l.address_street, l.address_zip, l.address_city]
                    .filter(Boolean)
                    .join(", "),
                }))}
                placeholder="Location wählen oder eintippen…"
                clearable
                freeTextDisplay={draft.location_name ?? ""}
                onCreateNew={(q) =>
                  patch({ location_id: null, location_name: q })
                }
                createNewLabel="Externer Ort"
                commitFreeTextOnBlur
              />
              {draft.location && (
                <p className="text-xs text-muted-foreground">
                  {[draft.location.address_street, draft.location.address_zip, draft.location.address_city]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Datum + Gäste */}
          <Card className="bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <Calendar className="h-3.5 w-3.5" />
                Erwartetes Datum & Gäste
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    Start
                  </label>
                  <Input
                    type="date"
                    defaultValue={draft.expected_start_date ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value || null;
                      if (v !== draft.expected_start_date) patch({ expected_start_date: v });
                    }}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    Ende
                  </label>
                  <Input
                    type="date"
                    defaultValue={draft.expected_end_date ?? ""}
                    min={draft.expected_start_date ?? undefined}
                    onBlur={(e) => {
                      const v = e.target.value || null;
                      if (v !== draft.expected_end_date) patch({ expected_end_date: v });
                    }}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">
                    Gäste
                  </label>
                  <Input
                    type="number"
                    min={1}
                    defaultValue={draft.guest_count ?? ""}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const v = raw ? parseInt(raw, 10) : null;
                      if (v !== draft.guest_count) patch({ guest_count: v });
                    }}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Aktuell: {formatDateRange(draft.expected_start_date, draft.expected_end_date)}
                {draft.guest_count ? ` · ${draft.guest_count} Gäste` : ""}
              </p>
            </CardContent>
          </Card>

          {/* Owner */}
          <Card className="bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                <UserIcon className="h-3.5 w-3.5" />
                Verantwortlich
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SearchableSelect
                value={draft.owner_id ?? ""}
                onChange={(id) => patch({ owner_id: id || null })}
                items={owners.map((o) => ({ id: o.id, label: o.full_name }))}
                placeholder="— niemand zugewiesen —"
                searchable={owners.length > 8}
                clearable
              />
            </CardContent>
          </Card>

          {/* Notizen-Freitextsammlung */}
          <Card className="bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Notizen / Rahmenbedingungen
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <InlineTextarea
                value={draft.general_notes ?? ""}
                onSave={(v) => patch({ general_notes: v.trim() || null })}
                placeholder="Budget, Sonderwuensche, allgemeine Info…"
                rows={4}
                disabled={isArchived}
              />
              <p className="text-[11px] text-muted-foreground">
                Fuer chronologische Anruf-/Mail-Historie den Notizen-Tab verwenden.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "notizen" && (
        <div className="space-y-4">
          {/* Add-Notiz */}
          {!isArchived && (
            <Card className="bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Neue Notiz
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col md:flex-row gap-2">
                  <div className="w-full md:w-44">
                    <SearchableSelect
                      value={newNoteKind}
                      onChange={(v) => setNewNoteKind(v as NoteKind)}
                      items={(Object.keys(NOTE_KIND_META) as NoteKind[]).map((k) => ({
                        id: k,
                        label: NOTE_KIND_META[k].label,
                      }))}
                      searchable={false}
                      clearable={false}
                    />
                  </div>
                </div>
                <textarea
                  value={newNoteBody}
                  onChange={(e) => setNewNoteBody(e.target.value)}
                  placeholder="Was ist passiert? (z.B. Kunde hat sich zurückgemeldet, Preisrahmen abgestimmt…)"
                  rows={3}
                  style={{ fieldSizing: "content" } as React.CSSProperties}
                  className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={addNote}
                    disabled={noteBusy || !newNoteBody.trim()}
                    className="kasten kasten-blue"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    {noteBusy ? "Speichere…" : "Hinzufügen"}
                  </button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Notizen-Historie */}
          {notes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-foreground/15 dark:border-foreground/20 bg-card">
              <EmptyState
                icon={MessageSquare}
                title="Noch keine Notizen"
                description={
                  isArchived
                    ? "Für diesen Entwurf wurden keine Notizen festgehalten."
                    : "Halte hier chronologisch fest: Anrufe, Mails, Meetings, allgemeine Notizen."
                }
              />
            </div>
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => {
                const meta = NOTE_KIND_META[n.kind] ?? NOTE_KIND_META.notiz;
                const Icon = meta.icon;
                return (
                  <li
                    key={n.id}
                    className="rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06] border border-foreground/10 dark:border-foreground/15 p-3 flex items-start gap-3"
                  >
                    <span className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-foreground/[0.06] dark:bg-foreground/[0.12] text-muted-foreground shrink-0">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
                        <span className="font-semibold text-foreground">{meta.label}</span>
                        <span>·</span>
                        <span>{n.author?.full_name ?? "Unbekannt"}</span>
                        <span>·</span>
                        <span className="tabular-nums">{formatDateTime(n.created_at)}</span>
                      </div>
                      <p className="text-sm mt-1 whitespace-pre-wrap break-words">{n.body}</p>
                    </div>
                    {!isArchived && (
                      <button
                        type="button"
                        onClick={() => deleteNote(n.id)}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-red-600 hover:bg-red-500/10 transition-colors shrink-0"
                        aria-label="Notiz löschen"
                        data-tooltip="Notiz löschen"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {ConfirmModalElement}
    </div>
  );
}
