"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { validateFileSize } from "@/lib/file-upload";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Room, RoomContact, RoomPrice } from "@/types";
import {
  Plus, UserPlus, Users, Phone, Mail, Trash2,
  X, Banknote, Wrench, FileText, Upload, Download, Pencil, Eye,
} from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { Loading } from "@/components/ui/spinner";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { PdfPopup } from "@/components/pdf-popup";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";

export default function RaumDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const { can } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [room, setRoom] = useState<Room | null>(null);
  const [contacts, setContacts] = useState<RoomContact[]>([]);
  const [prices, setPrices] = useState<RoomPrice[]>([]);

  // Contact form
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", role: "", email: "", phone: "" });

  // Price form
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [priceForm, setPriceForm] = useState({ label: "", amount: "", notes: "" });

  // Docs
  const [docs, setDocs] = useState<{ name: string; path: string; uploaded_at: string }[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const docRef = useRef<HTMLInputElement>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Doppel-Klick-Guards
  const [deleting, setDeleting] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [addingPrice, setAddingPrice] = useState(false);

  // Tech details edit
  const [editingTech, setEditingTech] = useState(false);
  const [techText, setTechText] = useState("");

  useEffect(() => { loadAll(); }, [id]);

  async function loadAll() {
    const [roomRes, contRes, priceRes] = await Promise.all([
      supabase.from("rooms").select("*").eq("id", id).single(),
      supabase.from("room_contacts").select("*").eq("room_id", id).order("name"),
      supabase.from("room_prices").select("*").eq("room_id", id).order("created_at"),
    ]);
    if (roomRes.data) {
      setRoom(roomRes.data as Room);
      setTechText(roomRes.data.technical_details || "");
      // Docs werden im notes-JSON-Field gespeichert (legacy storage).
      if (roomRes.data.notes) {
        try {
          const parsed = JSON.parse(roomRes.data.notes);
          if (parsed._docs) setDocs(parsed._docs);
        } catch {}
      }
    }
    if (contRes.data) setContacts(contRes.data as RoomContact[]);
    if (priceRes.data) setPrices(priceRes.data as RoomPrice[]);
  }

  async function saveDocs(documents: { name: string; path: string; uploaded_at: string }[]): Promise<boolean> {
    let data: { _docs?: unknown } = {};
    try { data = JSON.parse(room?.notes || "{}"); } catch { data = {}; }
    data._docs = documents;
    const { error } = await supabase.from("rooms").update({ notes: JSON.stringify(data) }).eq("id", id);
    if (error) {
      TOAST.supabaseError(error, "Dokumente konnten nicht gespeichert werden");
      loadAll();
      return false;
    }
    return true;
  }

  async function saveTech() {
    const { error } = await supabase.from("rooms").update({ technical_details: techText || null }).eq("id", id);
    if (error) {
      TOAST.supabaseError(error, "Technische Details konnten nicht gespeichert werden");
      return;
    }
    setEditingTech(false);
    loadAll();
    toast.success("Technische Details gespeichert");
  }

  // Contacts
  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    if (addingContact) return;
    setAddingContact(true);
    try {
      const { error } = await supabase.from("room_contacts").insert({ room_id: id, name: contactForm.name, role: contactForm.role || null, email: contactForm.email || null, phone: contactForm.phone || null });
      if (error) {
        TOAST.supabaseError(error, "Kontakt konnte nicht hinzugefügt werden");
        return;
      }
      setContactForm({ name: "", role: "", email: "", phone: "" });
      setShowContactForm(false);
      loadAll();
      toast.success("Kontaktperson hinzugefügt");
    } finally {
      setAddingContact(false);
    }
  }

  async function deleteContact(contactId: string) {
    const res = await deleteRow("room_contacts", contactId);
    if (!res.ok) {
      TOAST.deleteError(res.error);
      return;
    }
    loadAll();
  }

  // Prices
  async function addPrice(e: React.FormEvent) {
    e.preventDefault();
    if (addingPrice) return;
    setAddingPrice(true);
    try {
      const { error } = await supabase.from("room_prices").insert({ room_id: id, label: priceForm.label, amount: parseFloat(priceForm.amount), notes: priceForm.notes || null });
      if (error) {
        TOAST.supabaseError(error, "Preis konnte nicht hinzugefügt werden");
        return;
      }
      setPriceForm({ label: "", amount: "", notes: "" });
      setShowPriceForm(false);
      loadAll();
      toast.success("Preis hinzugefügt");
    } finally {
      setAddingPrice(false);
    }
  }

  async function deletePrice(priceId: string) {
    const res = await deleteRow("room_prices", priceId);
    if (!res.ok) {
      TOAST.deleteError(res.error);
      return;
    }
    loadAll();
  }

  // Docs
  async function uploadDoc(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!validateFileSize(file)) return;
    setUploadingDoc(true);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `raeume/${id}/${Date.now()}_${safeName}`;
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();
      if (!json.success) { TOAST.uploadError(json.error); setUploadingDoc(false); e.target.value = ""; return; }
    } catch { TOAST.networkError("Upload"); setUploadingDoc(false); e.target.value = ""; return; }
    const newDocs = [...docs, { name: file.name, path, uploaded_at: new Date().toISOString() }];
    const ok = await saveDocs(newDocs);
    if (ok) {
      setDocs(newDocs);
      toast.success("Dokument hochgeladen");
    }
    setUploadingDoc(false);
    e.target.value = "";
  }

  async function deleteDoc(doc: { name: string; path: string }) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${doc.name}" wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error: storageErr } = await supabase.storage.from("documents").remove([doc.path]);
    if (storageErr) {
      TOAST.supabaseError(storageErr, "Dokument konnte nicht gelöscht werden");
      return;
    }
    const newDocs = docs.filter((d) => d.path !== doc.path);
    const saved = await saveDocs(newDocs);
    if (saved) {
      setDocs(newDocs);
      toast.success("Dokument gelöscht");
    }
  }

  // Bucket 'documents' ist private — getPublicUrl() liefert eine URL die
  // 404 'Bucket not found' zurueckgibt. Stattdessen einen signed URL holen.
  async function getDocSignedUrl(path: string): Promise<string | null> {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return null;
    }
    return data.signedUrl;
  }

  async function openDocPreview(doc: { name: string; path: string }) {
    const url = await getDocSignedUrl(doc.path);
    if (url) setPreviewDoc({ url, title: doc.name });
  }

  async function downloadDoc(doc: { name: string; path: string }) {
    const url = await getDocSignedUrl(doc.path);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    a.click();
  }

  async function deleteRoom() {
    const ok = await confirm({
      title: "Raum unwiderruflich löschen?",
      message: `"${room?.name ?? "Dieser Raum"}" wird inkl. Kontakte, Preise und Dokumente entfernt.`,
      confirmLabel: "Endgültig löschen",
      variant: "red",
      confirmDelaySec: 3,
    });
    if (!ok || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/rooms/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success("Raum gelöscht");
        router.push("/locations");
      } else {
        TOAST.deleteError(json.error);
        setDeleting(false);
      }
    } catch {
      TOAST.deleteError();
      setDeleting(false);
    }
  }

  if (!room) return <Loading className="py-20" label="Laden…" />;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <BackButton fallbackHref="/locations" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{room.name}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {[room.address_street, `${room.address_zip || ""} ${room.address_city || ""}`].filter((s) => s?.trim()).join(", ")}
            {room.capacity ? ` · ${room.capacity} Personen` : ""}
          </p>
        </div>
        {can("locations:delete") && (
          <button type="button" className="kasten kasten-red ml-auto" onClick={deleteRoom} disabled={deleting}>
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? "Löschen…" : "Löschen"}
          </button>
        )}
      </div>

      {/* Technische Details */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Wrench className="h-4 w-4" />Technische Details</CardTitle>
          {!editingTech && can("locations:edit") && <button type="button" onClick={() => setEditingTech(true)} className="kasten kasten-purple"><Pencil className="h-3.5 w-3.5" />Bearbeiten</button>}
        </CardHeader>
        <CardContent>
          {editingTech ? (
            <div className="space-y-3">
              <textarea value={techText} onChange={(e) => setTechText(e.target.value)} placeholder="Bühne, Licht, Ton, Strom, Bestuhlung..." className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-muted/40 resize-none focus:outline-none focus:ring-2 focus:ring-red-500/20" rows={4} />
              <div className="flex gap-2">
                <button type="button" onClick={() => { setEditingTech(false); setTechText(room.technical_details || ""); }} className="kasten kasten-muted">Abbrechen</button>
                <button type="button" onClick={saveTech} className="kasten kasten-red">Speichern</button>
              </div>
            </div>
          ) : (
            <p className="text-sm whitespace-pre-wrap">{room.technical_details || <span className="text-muted-foreground">Noch keine technischen Details erfasst.</span>}</p>
          )}
        </CardContent>
      </Card>

      {/* Preise */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Banknote className="h-4 w-4" />Preise ({prices.length})</CardTitle>
          {can("locations:edit") && (
            <button type="button" onClick={() => setShowPriceForm(!showPriceForm)} className="kasten kasten-muted">
              {showPriceForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {showPriceForm ? "Abbrechen" : "Preis hinzufügen"}
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {showPriceForm && (
            <form onSubmit={addPrice} className="p-4 rounded-xl bg-muted/40 border space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Input placeholder="Bezeichnung * (z.B. Tagesmiete)" value={priceForm.label} onChange={(e) => setPriceForm({ ...priceForm, label: e.target.value })} required />
                <Input type="number" step="0.01" placeholder="Betrag (CHF) *" value={priceForm.amount} onChange={(e) => setPriceForm({ ...priceForm, amount: e.target.value })} required />
              </div>
              <Input placeholder="Bemerkung (optional)" value={priceForm.notes} onChange={(e) => setPriceForm({ ...priceForm, notes: e.target.value })} />
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowPriceForm(false)} disabled={addingPrice} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" disabled={addingPrice} className="kasten kasten-red">{addingPrice ? "Speichere…" : "Speichern"}</button>
              </div>
            </form>
          )}
          {prices.length === 0 && !showPriceForm && <p className="text-sm text-muted-foreground py-4 text-center">Noch keine Preise erfasst.</p>}
          {prices.map((p) => (
            <div key={p.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/40 border">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{p.label}</span>
                  <span className="text-sm font-bold text-green-700">CHF {Number(p.amount).toLocaleString("de-CH", { minimumFractionDigits: 2 })}</span>
                </div>
                {p.notes && <p className="text-xs text-muted-foreground mt-0.5">{p.notes}</p>}
              </div>
              {can("locations:edit") && (
                <button onClick={() => deletePrice(p.id)} className="icon-btn icon-btn-red"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Kontaktpersonen */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Users className="h-4 w-4" />Ansprechpartner ({contacts.length})</CardTitle>
          {can("locations:edit") && (
            <button type="button" onClick={() => setShowContactForm(!showContactForm)} className="kasten kasten-muted">
              <UserPlus className="h-3.5 w-3.5" />
              Hinzufügen
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {showContactForm && (
            <form onSubmit={addContact} className="p-4 rounded-xl bg-muted/40 border space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Input placeholder="Name *" value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })} required />
                <Input placeholder="Funktion (z.B. Vermietung)" value={contactForm.role} onChange={(e) => setContactForm({ ...contactForm, role: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input placeholder="E-Mail" type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} />
                <Input placeholder="Telefon" value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowContactForm(false)} disabled={addingContact} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" disabled={addingContact} className="kasten kasten-red">{addingContact ? "Speichere…" : "Speichern"}</button>
              </div>
            </form>
          )}
          {contacts.length === 0 && !showContactForm && <p className="text-sm text-muted-foreground py-4 text-center">Noch keine Ansprechpartner.</p>}
          {contacts.map((c) => (
            <div key={c.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/40 border">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{c.name}</span>
                  {c.role && <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{c.role}</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {c.email && <a href={`mailto:${c.email}`} className="flex items-center gap-1 hover:text-blue-600 transition-colors"><Mail className="h-3 w-3" />{c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:text-blue-600 transition-colors"><Phone className="h-3 w-3" />{c.phone}</a>}
                </div>
              </div>
              {can("locations:edit") && (
                <button onClick={() => deleteContact(c.id)} className="icon-btn icon-btn-red"><Trash2 className="h-4 w-4" /></button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Dokumente */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><FileText className="h-4 w-4" />Dokumente ({docs.length})</CardTitle>
          {can("locations:edit") && (
            <button type="button" onClick={() => docRef.current?.click()} disabled={uploadingDoc} className="kasten kasten-muted">
              <Upload className="h-3.5 w-3.5" />
              {uploadingDoc ? "Hochladen…" : "PDF hochladen"}
            </button>
          )}
          <input ref={docRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png" onChange={uploadDoc} className="hidden" />
        </CardHeader>
        <CardContent className="space-y-3">
          {docs.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">Noch keine Dokumente.</p>}
          {docs.map((d) => (
            <div key={d.path} className="flex items-center justify-between p-3 rounded-xl bg-muted/40 border">
              <button onClick={() => openDocPreview(d)} className="flex items-center gap-3 min-w-0 flex-1 text-left hover:text-blue-600 transition-colors">
                <FileText className="h-5 w-5 text-red-500 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{d.name}</p>
                  <p className="text-xs text-muted-foreground">{new Date(d.uploaded_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}</p>
                </div>
              </button>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <button onClick={() => openDocPreview(d)} className="icon-btn icon-btn-blue" data-tooltip="Vorschau"><Eye className="h-4 w-4" /></button>
                <button onClick={() => downloadDoc(d)} className="icon-btn icon-btn-muted" data-tooltip="Herunterladen"><Download className="h-4 w-4" /></button>
                {can("locations:edit") && (
                  <button onClick={() => deleteDoc(d)} className="icon-btn icon-btn-red" data-tooltip="Löschen"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

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
