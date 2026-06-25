"use client";

/**
 * LeadEditor — komplette Detail-/Edit-Ansicht eines Vertrieb-Leads.
 *
 * Lebt auf einer eigenen Page (/vertrieb/[id]) statt als Inline-Overlay
 * ueber der Liste. Hat den ganzen edit-state + alle Modals (Termin,
 * Auftrag, Buchhaltung, Verbesserung, Lost) gekapselt; /vertrieb/page.tsx
 * weiss nichts mehr davon.
 *
 * Page-Wrapper:
 *   const params = useParams();
 *   return <LeadEditor contactId={String(params.id)} onClose={...} />;
 */

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { logError } from "@/lib/log";
import { TOAST } from "@/lib/messages";
import { validateFileSize } from "@/lib/file-upload";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Phone, Mail, Calendar, Check, AlertTriangle, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { BEDARF_LABELS, emptyForm } from "@/app/(app)/vertrieb/constants";
import { parseVertriebNotes, type VertriebDetails, type VertriebNotes } from "@/lib/vertrieb-notes";
import { TerminModalBody } from "@/components/vertrieb/termin-modal-body";
import { AuftragModalBody } from "@/components/vertrieb/auftrag-modal-body";
import { toLocalIsoString, todayLocalDateString, toDbDate } from "@/lib/format";
import { BuchhaltungModalBody } from "@/components/vertrieb/buchhaltung-modal-body";
import { VerbesserungModalBody } from "@/components/vertrieb/verbesserung-modal-body";
import { LostModalBody } from "@/components/vertrieb/lost-modal-body";
import { LeadForm } from "@/components/vertrieb/lead-form";
import { useConfirm } from "@/components/ui/use-confirm";
import { WiedervorlageBlock } from "@/components/vertrieb/wiedervorlage-block";
import type { VertriebContact, VertriebStatus, VertriebPriority } from "@/types";

interface Props {
  contactId: string;
  onClose: () => void;
}

export function LeadEditor({ contactId, onClose }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  // Daten
  const [contact, setContact] = useState<VertriebContact | null>(null);
  const [contacts, setContacts] = useState<VertriebContact[]>([]); // fuer Termin-Liste-Refresh
  const [customers, setCustomers] = useState<{ id: string; name: string; email: string | null; phone: string | null }[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Form
  const [form, setForm] = useState(emptyForm);
  const [editingStep, setEditingStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [visibleBedarf, setVisibleBedarf] = useState<Set<string>>(new Set());

  // Kunden-Anbindung — beim Edit fix auf "neu" weil's eh schon zugewiesen ist
  const [kundenMode, setKundenMode] = useState<"neu" | "bestehend">("neu");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");

  // Modals
  const [showLostModal, setShowLostModal] = useState(false);
  const [lostReason, setLostReason] = useState("");

  const [showBuchhaltung, setShowBuchhaltung] = useState(false);
  const [buchhaltungMessage, setBuchhaltungMessage] = useState("");
  const [sendingBuchhaltung, setSendingBuchhaltung] = useState(false);

  const [showVerbesserung, setShowVerbesserung] = useState(false);
  const [verbesserungText, setVerbesserungText] = useState("");
  const [sendingVerbesserung, setSendingVerbesserung] = useState(false);

  // Offerte
  const [offertePdf, setOffertePdf] = useState<{ name: string; path: string } | null>(null);
  const [uploadingOfferte, setUploadingOfferte] = useState(false);
  const [sendingBestaetigung, setSendingBestaetigung] = useState(false);

  // Termin
  const [showTerminModal, setShowTerminModal] = useState(false);
  const [terminType, setTerminType] = useState<"kunde" | "telefon">("kunde");
  const [terminForm, setTerminForm] = useState({ date: todayLocalDateString(), time: "09:00", end_time: "10:00", note: "" });
  const [savingTermin, setSavingTermin] = useState(false);

  // Auftrag-aus-Lead
  const [showAuftragModal, setShowAuftragModal] = useState(false);
  const [auftragForm, setAuftragForm] = useState({ title: "", priority: "normal", start_date: "", end_date: "", location_id: "" });
  const [creatingAuftrag, setCreatingAuftrag] = useState(false);

  /** Lädt den Contact + Hilfsdaten und befüllt das Form. */
  const load = useCallback(async () => {
    setLoading(true);
    const [contactRes, allContactsRes, custRes, locRes] = await Promise.all([
      supabase.from("vertrieb_contacts").select("*").eq("id", contactId).maybeSingle(),
      supabase.from("vertrieb_contacts").select("*").order("nr").limit(2000),
      supabase.from("customers").select("id, name, email, phone").eq("is_active", true).order("name"),
      supabase.from("locations").select("id, name").eq("is_active", true).order("name"),
    ]);
    const c = contactRes.data as VertriebContact | null;
    if (!c) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    setContact(c);
    setContacts((allContactsRes.data ?? []) as VertriebContact[]);
    setCustomers(custRes.data ?? []);
    setLocations(locRes.data ?? []);
    setEditingStep(c.step || 1);

    // Form aus Contact + parsed details füllen
    const parsed = parseVertriebNotes(c.notizen);
    const details: VertriebDetails = parsed._details ?? {};
    setForm({
      firma: c.firma, branche: c.branche || "", ansprechperson: c.ansprechperson || "",
      position: c.position || "", email: c.email || "", telefon: c.telefon || "",
      event_typ: c.event_typ || "", status: c.status, datum_kontakt: c.datum_kontakt || "",
      notizen: parsed._text ?? "", prioritaet: c.prioritaet, kategorie: c.kategorie || "veranstaltung",
      infrastruktur: details.infrastruktur || "",
      ort: details.ort || "",
      zielgruppe: details.zielgruppe || "",
      programm: details.programm || "",
      bedarf_vor_ort: details.bedarf_vor_ort || "",
      event_start: details.event_start || "",
      event_end: details.event_end || "",
      bedarf: details.bedarf || {},
      create_customer: false,
    });
    setVisibleBedarf(new Set(Object.keys(details.bedarf || {})));
    const pdf = details.offerte_pdf;
    setOffertePdf(pdf && typeof pdf === "object" && "path" in pdf ? pdf : null);
    setLoading(false);
  }, [contactId, supabase]);

  useEffect(() => {
    load();
    // Realtime — gleicher globaler Channel wie /vertrieb/page.tsx
    const handler = () => load();
    window.addEventListener("realtime:vertrieb_contacts", handler);
    return () => window.removeEventListener("realtime:vertrieb_contacts", handler);
  }, [load]);

  // Aktueller Contact mit geparsten Details — fuer alle Mail-Sender und
  // Auftrag-aus-Lead-Konvertierung.
  function currentContactWithDetails(): (VertriebContact & { details: VertriebDetails }) | null {
    if (!contact) return null;
    const details = parseVertriebNotes(contact.notizen)._details ?? {};
    return { ...contact, details };
  }

  function selectExistingCustomer(customerId: string) {
    setSelectedCustomerId(customerId);
    const c = customers.find((x) => x.id === customerId);
    if (c) {
      setForm((f) => ({ ...f, firma: c.name, email: c.email || "", telefon: c.phone || "", create_customer: false }));
    }
  }

  /** Lead speichern — Update statt Insert weil hier ja bereits existiert. */
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !contact) return;
    setSaving(true);

    const details: VertriebDetails = {};
    if (form.event_start) details.event_start = form.event_start;
    if (form.event_end) details.event_end = form.event_end;
    if (form.kategorie === "verwaltung") {
      if (form.infrastruktur) details.infrastruktur = form.infrastruktur;
      if (form.ort) details.ort = form.ort;
      if (form.zielgruppe) details.zielgruppe = form.zielgruppe;
      if (form.programm) details.programm = form.programm;
      if (form.bedarf_vor_ort) details.bedarf_vor_ort = form.bedarf_vor_ort;
    } else {
      const filteredBedarf: Record<string, string> = {};
      Object.entries(form.bedarf).forEach(([k, v]) => { if (v?.trim()) filteredBedarf[k] = v; });
      if (Object.keys(filteredBedarf).length > 0) details.bedarf = filteredBedarf;
    }
    // Bestehende Detail-Felder (offerte_pdf, termine, job_id) erhalten
    const existing = parseVertriebNotes(contact.notizen)._details ?? {};
    const mergedDetails = { ...existing, ...details };
    const notizenStored = (Object.keys(mergedDetails).length > 0 || form.notizen)
      ? JSON.stringify({ _text: form.notizen, _details: mergedDetails })
      : null;

    const { error } = await supabase.from("vertrieb_contacts").update({
      firma: form.firma,
      branche: form.branche || null,
      ansprechperson: form.ansprechperson || null,
      position: form.position || null,
      email: form.email || null,
      telefon: form.telefon || null,
      event_typ: form.event_typ || null,
      status: form.status,
      datum_kontakt: form.datum_kontakt || null,
      notizen: notizenStored,
      prioritaet: form.prioritaet,
      kategorie: form.kategorie,
    }).eq("id", contact.id);
    if (error) { TOAST.supabaseError(error); setSaving(false); return; }
    toast.success("Eintrag aktualisiert");
    setSaving(false);
    await load();
  }

  async function advanceStep() {
    if (!contact) return;
    const next = Math.min(editingStep + 1, 4);
    const newStatus: VertriebStatus =
      next === 2 ? "kontaktiert" :
      next >= 3 ? "gespraech" : "offen";
    await supabase.from("vertrieb_contacts").update({
      step: next, status: newStatus,
      datum_kontakt: todayLocalDateString(),
    }).eq("id", contact.id);
    setEditingStep(next);
    setForm((f) => ({ ...f, status: newStatus, datum_kontakt: todayLocalDateString() }));
    toast.success(`Schritt ${next}`);
    await load();
  }

  // "Erneut kontaktiert": setzt nur das datum_kontakt auf heute, ohne den
  // Step-Tracker zu beeinflussen. Use-case: Kunde wurde im aktuellen Schritt
  // nochmal angerufen/angeschrieben — soll im Aging-Sort nicht rot werden.
  // Inkrementiert recontact_count damit die Vertriebs-Person sieht wie
  // oft schon nachgefasst wurde.
  async function markRecontacted() {
    if (!contact) return;
    const today = todayLocalDateString();
    const nextCount = (contact.recontact_count ?? 0) + 1;
    await supabase.from("vertrieb_contacts").update({
      datum_kontakt: today,
      recontact_count: nextCount,
    }).eq("id", contact.id);
    setForm((f) => ({ ...f, datum_kontakt: today }));
    toast.success(`Kontakt-Datum aktualisiert (${nextCount}. Nachfassung)`);
    await load();
  }

  function openLostModal() { setLostReason(""); setShowLostModal(true); }
  async function markLost() {
    if (!contact || !lostReason.trim()) { toast.error("Grund ist erforderlich"); return; }
    await supabase.from("vertrieb_contacts").update({
      status: "abgesagt", verloren_grund: lostReason.trim(),
    }).eq("id", contact.id);
    toast.success("Auftrag als verloren markiert");
    setShowLostModal(false);
    onClose();
  }

  /** Lead verwerfen: Status 'verworfen' setzen -> Lead verschwindet aus
   *  der aktiven Liste und taucht im /vertrieb/archiv unter "Verworfen"
   *  auf. Nur fuer Leads im Status 'offen' (nie kontaktiert) gedacht. */
  async function discardLead() {
    if (!contact) return;
    const ok = await confirm({
      title: "Lead verwerfen?",
      message: `${contact.firma} wird ins Archiv verschoben. Du findest ihn jederzeit unter Vertrieb-Archiv -> Verworfen.`,
      confirmLabel: "Verwerfen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("vertrieb_contacts").update({
      status: "verworfen",
    }).eq("id", contact.id);
    if (error) { toast.error("Konnte nicht verwerfen: " + error.message); return; }
    toast.success("Lead verworfen — im Archiv");
    onClose();
  }

  async function sendBuchhaltungsBenachrichtigung() {
    const c = currentContactWithDetails();
    if (!c) return;
    setSendingBuchhaltung(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user?.id).single();
    try {
      const res = await fetch("/api/sales/accounting", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "benachrichtigung", contact: c, message: buchhaltungMessage, senderName: profile?.full_name || "Unbekannt" }),
      });
      const json = await res.json();
      if (json.success) { toast.success("Buchhaltung benachrichtigt"); setShowBuchhaltung(false); setBuchhaltungMessage(""); }
      else TOAST.errorOr(json.error);
    } catch { TOAST.sendError(); }
    setSendingBuchhaltung(false);
  }

  async function sendVerbesserung() {
    const c = currentContactWithDetails();
    if (!c || !verbesserungText.trim()) { toast.error("Text ist erforderlich"); return; }
    setSendingVerbesserung(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user?.id).single();
    try {
      const res = await fetch("/api/sales/accounting", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "verbesserung", contact: c, message: verbesserungText, senderName: profile?.full_name || "Unbekannt" }),
      });
      const json = await res.json();
      if (json.success) { toast.success("Verbesserungs-Vorschlag gesendet"); setShowVerbesserung(false); setVerbesserungText(""); }
      else TOAST.errorOr(json.error);
    } catch { TOAST.sendError(); }
    setSendingVerbesserung(false);
  }

  async function uploadOfferte(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !contact) return;
    if (!validateFileSize(file)) return;
    setUploadingOfferte(true);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `vertrieb/${contact.id}/offerte_${Date.now()}_${safeName}`;
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();
      if (!json.success) { TOAST.uploadError(json.error); setUploadingOfferte(false); e.target.value = ""; return; }
      setOffertePdf({ name: file.name, path });
      const obj: VertriebNotes = parseVertriebNotes(contact.notizen);
      if (!obj._details) obj._details = {};
      obj._details.offerte_pdf = { name: file.name, path };
      await supabase.from("vertrieb_contacts").update({ notizen: JSON.stringify(obj) }).eq("id", contact.id);
      await load();
      toast.success("Offerte hochgeladen");
    } catch { TOAST.networkError("Upload"); }
    setUploadingOfferte(false);
    e.target.value = "";
  }

  async function removeOfferte() {
    if (!offertePdf || !contact) return;
    await supabase.storage.from("documents").remove([offertePdf.path]);
    const obj: VertriebNotes = parseVertriebNotes(contact.notizen);
    if (obj._details) delete obj._details.offerte_pdf;
    await supabase.from("vertrieb_contacts").update({ notizen: JSON.stringify(obj) }).eq("id", contact.id);
    setOffertePdf(null);
    await load();
    toast.success("PDF entfernt");
  }

  async function sendOffertenBestaetigung() {
    const c = currentContactWithDetails();
    if (!c) return;
    setSendingBestaetigung(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user?.id).single();
    let pdfBase64: string | null = null;
    let pdfName: string | null = null;
    const offertePath = c.details?.offerte_pdf?.path;
    if (offertePath) {
      const { data: fileData } = await supabase.storage.from("documents").download(offertePath);
      if (fileData) {
        const arrayBuffer = await fileData.arrayBuffer();
        pdfBase64 = Buffer.from(arrayBuffer).toString("base64");
        pdfName = c.details.offerte_pdf?.name ?? null;
      }
    }
    try {
      const res = await fetch("/api/sales/accounting", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "offerte_bestaetigt", contact: c, message: "Die Offerte wurde bestätigt und kann verrechnet werden.",
          senderName: profile?.full_name || "Unbekannt", pdfBase64, pdfName,
        }),
      });
      const json = await res.json();
      if (json.success) toast.success("Offerten-Bestätigung gesendet");
      else TOAST.errorOr(json.error);
    } catch { TOAST.sendError(); }
    setSendingBestaetigung(false);
  }

  function openTerminModal(type: "kunde" | "telefon") {
    setTerminType(type);
    setTerminForm({
      date: todayLocalDateString(),
      time: type === "telefon" ? "10:00" : "14:00",
      end_time: type === "telefon" ? "10:30" : "15:00",
      note: "",
    });
    setShowTerminModal(true);
  }

  async function saveTermin() {
    if (!contact) return;
    setSavingTermin(true);
    const { data: { user } } = await supabase.auth.getUser();
    const title = `${terminType === "telefon" ? "Telefon-Termin" : "Kunden-Termin"}: ${contact.firma}${contact.ansprechperson ? ` (${contact.ansprechperson})` : ""}`;
    const description = [terminForm.note, contact.telefon ? `Tel: ${contact.telefon}` : "", contact.email ? `E-Mail: ${contact.email}` : ""].filter(Boolean).join("\n");
    const { data: newAppt } = await supabase.from("job_appointments").insert({
      job_id: null, title, description: description || null,
      start_time: toLocalIsoString(terminForm.date, terminForm.time),
      end_time: toLocalIsoString(terminForm.date, terminForm.end_time),
      assigned_to: user?.id || null,
    }).select("id").single();

    if (newAppt?.id) {
      const obj: VertriebNotes = parseVertriebNotes(contact.notizen);
      if (!obj._details) obj._details = {};
      if (!obj._details.termine) obj._details.termine = [];
      obj._details.termine.push({
        id: newAppt.id, type: terminType, date: terminForm.date,
        time: terminForm.time, end_time: terminForm.end_time, notes: terminForm.note || undefined,
      });
      await supabase.from("vertrieb_contacts").update({ notizen: JSON.stringify(obj) }).eq("id", contact.id);
      await load();
    }
    toast.success(`${terminType === "telefon" ? "Telefon" : "Kunden"}-Termin im Kalender erstellt`);
    setShowTerminModal(false);
    setSavingTermin(false);
  }

  async function deleteTerminFromLead(terminId: string) {
    if (!contact) return;
    const ok = await confirm({ title: "Termin löschen?", confirmLabel: "Löschen", variant: "red" });
    if (!ok) return;
    await deleteRow("job_appointments", terminId);
    const obj: VertriebNotes = parseVertriebNotes(contact.notizen);
    if (obj._details?.termine) {
      obj._details.termine = obj._details.termine.filter((t) => t.id !== terminId);
      await supabase.from("vertrieb_contacts").update({ notizen: JSON.stringify(obj) }).eq("id", contact.id);
      await load();
    }
    toast.success("Termin gelöscht");
  }

  function openAuftragModal() {
    const c = currentContactWithDetails();
    if (!c) return;
    setAuftragForm({
      title: c.event_typ || c.firma,
      priority: "normal",
      start_date: c.details?.event_start || c.datum_kontakt || todayLocalDateString(),
      end_date: c.details?.event_end || "",
      location_id: "",
    });
    setShowAuftragModal(true);
  }

  async function createAuftrag() {
    const c = currentContactWithDetails();
    if (!c) return;
    setCreatingAuftrag(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user?.id).single();

    let customerId: string | null = null;
    const { data: existingCust } = await supabase.from("customers").select("id").eq("name", c.firma).maybeSingle();
    if (existingCust) {
      customerId = existingCust.id;
    } else {
      const { data: newCust, error: custError } = await supabase.from("customers").insert({
        name: c.firma, type: "company", email: c.email || null, phone: c.telefon || null,
        notes: c.ansprechperson ? `Ansprechperson: ${c.ansprechperson}${c.position ? ` (${c.position})` : ""}` : null,
      }).select("id").single();
      if (custError || !newCust) { TOAST.supabaseError(custError, "Kunde konnte nicht erstellt werden"); setCreatingAuftrag(false); return; }
      customerId = newCust.id;
    }
    if (!customerId) { toast.error("Kunde konnte nicht erstellt werden"); setCreatingAuftrag(false); return; }

    const details = c.details || {};
    const descriptionParts: string[] = [];
    if (details.infrastruktur) descriptionParts.push(`Infrastruktur: ${details.infrastruktur}`);
    if (details.zielgruppe) descriptionParts.push(`Zielgruppe: ${details.zielgruppe}`);
    if (details.programm) descriptionParts.push(`Programm: ${details.programm}`);
    if (details.bedarf_vor_ort) descriptionParts.push(`Bedarf vor Ort: ${details.bedarf_vor_ort}`);
    if (details.bedarf) {
      for (const [k, v] of Object.entries(details.bedarf)) {
        descriptionParts.push(`${BEDARF_LABELS[k] || k}: ${v}`);
      }
    }

    const { data: newJob, error } = await supabase.from("jobs").insert({
      title: auftragForm.title, description: descriptionParts.join("\n\n") || null,
      status: "offen", priority: auftragForm.priority, customer_id: customerId,
      location_id: auftragForm.location_id || details.location_id || null,
      start_date: toDbDate(auftragForm.start_date),
      end_date: toDbDate(auftragForm.end_date || auftragForm.start_date),
      created_by: user?.id,
    }).select("id, job_number, title").single();
    if (error || !newJob) { TOAST.supabaseError(error, "Auftrag konnte nicht angelegt werden"); setCreatingAuftrag(false); return; }

    const obj: VertriebNotes = parseVertriebNotes(c.notizen);
    if (!obj._details) obj._details = {};
    obj._details.job_id = newJob.id;
    obj._details.job_number = newJob.job_number;
    // contact ist hier garantiert nicht null (currentContactWithDetails hat oben
    // schon return false rausgenommen), aber TS sieht das nach awaits nicht.
    if (!contact) return;
    await supabase.from("vertrieb_contacts").update({ notizen: JSON.stringify(obj), status: "gewonnen" }).eq("id", contact.id);

    let emailOk = false;
    try {
      const res = await fetch("/api/sales/new-job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobNumber: newJob.job_number, jobId: newJob.id, title: newJob.title,
          firma: c.firma, ansprechperson: c.ansprechperson, email: c.email, telefon: c.telefon,
          startDate: auftragForm.start_date, endDate: auftragForm.end_date,
          creatorName: profile?.full_name || "Unbekannt",
        }),
      });
      const json = await res.json();
      emailOk = json.success;
      if (!emailOk) logError("vertrieb.send-email", json.error);
    } catch (e) { logError("vertrieb.send-fetch", e); }
    if (emailOk) toast.success(`Auftrag INT-${newJob.job_number} erstellt — Leo benachrichtigt`);
    else toast.error(`Auftrag INT-${newJob.job_number} erstellt — E-Mail an Leo fehlgeschlagen`);
    setShowAuftragModal(false);
    setCreatingAuftrag(false);
    setTimeout(() => router.push(`/auftraege/${newJob.id}`), 600);
  }

  if (loading) {
    return (
      <div className="space-y-3 max-w-4xl mx-auto">
        {[1, 2, 3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-6 h-24" /></Card>)}
      </div>
    );
  }

  if (notFound || !contact) {
    return (
      <div className="max-w-2xl mx-auto">
        <button type="button" onClick={onClose} className="kasten kasten-muted mb-4">
          <ArrowLeft className="h-3.5 w-3.5" />
          Zurück
        </button>
        <Card className="bg-card border-dashed"><CardContent className="py-16 text-center">
          <h3 className="font-semibold text-lg">Lead nicht gefunden</h3>
          <p className="text-sm text-muted-foreground mt-1">Der Eintrag wurde gelöscht oder du hast keinen Zugriff.</p>
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back-Button als eigene Zeile, dezent — Detail-Page-Pattern wie /auftraege/[id] */}
      <button type="button" onClick={onClose} className="kasten kasten-muted">
        <ArrowLeft className="h-3.5 w-3.5" />
        Vertriebs-Liste
      </button>

      <WiedervorlageBlock
        contactId={contact.id}
        wiedervorlageAm={contact.wiedervorlage_am}
        wiedervorlageNote={contact.wiedervorlage_note}
        snoozed={contact.wiedervorlage_snoozed}
        onChange={load}
      />

      <LeadForm
        editingId={contact.id}
        editingStep={editingStep}
        form={form}
        setForm={setForm}
        saving={saving}
        offertePdf={offertePdf}
        uploadingOfferte={uploadingOfferte}
        sendingBestaetigung={sendingBestaetigung}
        visibleBedarf={visibleBedarf}
        setVisibleBedarf={setVisibleBedarf}
        kundenMode={kundenMode}
        setKundenMode={setKundenMode}
        selectedCustomerId={selectedCustomerId}
        setSelectedCustomerId={setSelectedCustomerId}
        customers={customers}
        contacts={contacts}
        onSubmit={save}
        onClose={onClose}
        onAdvanceStep={advanceStep}
        onMarkRecontacted={markRecontacted}
        onOpenLost={openLostModal}
        onDiscard={discardLead}
        onOpenBuchhaltung={() => setShowBuchhaltung(true)}
        onOpenVerbesserung={() => setShowVerbesserung(true)}
        onOpenTermin={openTerminModal}
        onDeleteTermin={deleteTerminFromLead}
        onUploadOfferte={uploadOfferte}
        onRemoveOfferte={removeOfferte}
        onSendBestaetigung={sendOffertenBestaetigung}
        onOpenAuftrag={openAuftragModal}
        onSelectExistingCustomer={selectExistingCustomer}
        currentContactWithDetails={currentContactWithDetails}
      />

      {/* Modals */}
      <Modal open={showTerminModal} onClose={() => setShowTerminModal(false)} title={terminType === "telefon" ? "Telefon-Termin" : "Kunden-Termin"} icon={terminType === "telefon" ? <Phone className="h-4 w-4" /> : <Calendar className="h-4 w-4" />} size="md" closable={!savingTermin}>
        <TerminModalBody terminType={terminType} terminForm={terminForm} setTerminForm={setTerminForm} onSave={saveTermin} onClose={() => setShowTerminModal(false)} saving={savingTermin} />
      </Modal>

      <Modal open={showAuftragModal} onClose={() => setShowAuftragModal(false)} title="Auftrag erstellen" icon={<Check className="h-4 w-4 text-green-600" />} size="lg" closable={!creatingAuftrag}>
        <AuftragModalBody auftragForm={auftragForm} setAuftragForm={setAuftragForm} locations={locations} onCreate={createAuftrag} onClose={() => setShowAuftragModal(false)} creating={creatingAuftrag} />
      </Modal>

      <Modal open={showBuchhaltung} onClose={() => setShowBuchhaltung(false)} title="Benachrichtigung Buchhaltung" icon={<Mail className="h-4 w-4 text-blue-600" />} size="md" closable={!sendingBuchhaltung}>
        <BuchhaltungModalBody buchhaltungMessage={buchhaltungMessage} setBuchhaltungMessage={setBuchhaltungMessage} onSend={sendBuchhaltungsBenachrichtigung} onClose={() => setShowBuchhaltung(false)} sending={sendingBuchhaltung} />
      </Modal>

      <Modal open={showVerbesserung} onClose={() => setShowVerbesserung(false)} title="Verbesserungs-Vorschlag" icon={<Mail className="h-4 w-4 text-green-600" />} size="md" closable={!sendingVerbesserung}>
        <VerbesserungModalBody verbesserungText={verbesserungText} setVerbesserungText={setVerbesserungText} onSend={sendVerbesserung} onClose={() => setShowVerbesserung(false)} sending={sendingVerbesserung} />
      </Modal>

      <Modal open={showLostModal} onClose={() => setShowLostModal(false)} title="Auftrag verloren" icon={<AlertTriangle className="h-4 w-4 text-red-600" />} size="md">
        <LostModalBody lostReason={lostReason} setLostReason={setLostReason} onConfirm={markLost} onClose={() => setShowLostModal(false)} />
      </Modal>

      {ConfirmModalElement}
    </div>
  );
}
