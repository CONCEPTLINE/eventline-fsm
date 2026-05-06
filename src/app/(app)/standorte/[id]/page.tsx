"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { validateFileSize } from "@/lib/file-upload";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Location, LocationContact, MaintenanceTask, Customer } from "@/types";
import {
  Plus, UserPlus, Wrench, Check, MapPin,
  Users, Phone, Mail, Trash2, Camera, Image as ImageIcon, X,
  ClipboardList, Building2, FileText, Upload, Download, Eye,
} from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { usePermissions } from "@/lib/use-permissions";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { useConfirm } from "@/components/ui/use-confirm";
import { PdfPopup } from "@/components/pdf-popup";

interface MaintenanceTaskWithPhoto extends MaintenanceTask {
  photo_url?: string | null;
  job_id?: string | null;
  // Aus Postgres-FK-Join: maintenance_tasks.job_id → jobs.id
  job?: { id: string; status: string } | null;
}

function effectiveTaskStatus(t: MaintenanceTaskWithPhoto): "offen" | "erledigt" {
  if (t.job?.status === "abgeschlossen") return "erledigt";
  return t.status;
}

export default function StandortDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const { can } = usePermissions();
  const [location, setLocation] = useState<Location | null>(null);
  const [contacts, setContacts] = useState<LocationContact[]>([]);
  const [tasks, setTasks] = useState<MaintenanceTaskWithPhoto[]>([]);

  // Contact form
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", role: "", email: "", phone: "" });

  // Task form
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", description: "" });
  const [taskPhoto, setTaskPhoto] = useState<{ file: File; preview: string } | null>(null);
  const taskPhotoRef = useRef<HTMLInputElement>(null);
  const taskCameraRef = useRef<HTMLInputElement>(null);

  const [taskFilter, setTaskFilter] = useState<"all" | "offen" | "erledigt">("all");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [linkedCustomer, setLinkedCustomer] = useState<Customer | null>(null);

  // Dokumente
  const [docs, setDocs] = useState<{ name: string; path: string; uploaded_at: string }[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const docRef = useRef<HTMLInputElement>(null);
  const { confirm, ConfirmModalElement } = useConfirm();
  // Floating PDF/Image-Vorschau — non-modal.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  useEffect(() => { loadAll(); }, [id]);

  async function loadAll() {
    const [locRes, contRes, taskRes, custRes] = await Promise.all([
      supabase.from("locations").select("*").eq("id", id).single(),
      supabase.from("location_contacts").select("*").eq("location_id", id).order("name"),
      supabase.from("maintenance_tasks").select("*, job:jobs(id, status)").eq("location_id", id).order("created_at", { ascending: false }),
      supabase.from("customers").select("*").eq("is_active", true).order("name"),
    ]);
    if (locRes.data) {
      setLocation(locRes.data as Location);
      // Wichtig: linkedCustomer IMMER setzen — auch auf null wenn customer_id
      // entfernt wurde. Sonst bleibt der vorherige State stehen und User
      // muss manuell refreshen damit die Aenderung sichtbar wird.
      if (locRes.data.customer_id && custRes.data) {
        setLinkedCustomer((custRes.data as Customer[]).find((c) => c.id === locRes.data.customer_id) || null);
      } else {
        setLinkedCustomer(null);
      }
    }
    if (contRes.data) setContacts(contRes.data as LocationContact[]);
    if (taskRes.data) setTasks(taskRes.data as MaintenanceTaskWithPhoto[]);
    if (custRes.data) setCustomers(custRes.data as Customer[]);

    // Load documents from technical_details
    if (locRes.data?.technical_details) {
      try {
        const parsed = JSON.parse(locRes.data.technical_details);
        if (Array.isArray(parsed)) setDocs(parsed);
      } catch {}
    }
  }

  async function linkCustomer(customerId: string) {
    await supabase.from("locations").update({ customer_id: customerId || null }).eq("id", id);
    toast.success(customerId ? "Kunde verknüpft" : "Kundenverknüpfung entfernt");
    loadAll();
  }

  async function uploadDoc(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!validateFileSize(file)) return;
    setUploadingDoc(true);
    const ext = file.name.split(".").pop() || "pdf";
    const path = `standorte/${id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error } = await supabase.storage.from("documents").upload(path, file, { contentType: file.type });
    if (error) {
      TOAST.supabaseError(error, "Upload fehlgeschlagen");
      setUploadingDoc(false);
      e.target.value = "";
      return;
    }
    const newDocs = [...docs, { name: file.name, path, uploaded_at: new Date().toISOString() }];
    // Save docs list via admin API
    await fetch(`/api/locations/${id}/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: newDocs }),
    });
    setDocs(newDocs);
    toast.success("Dokument hochgeladen");
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
    await supabase.storage.from("documents").remove([doc.path]);
    const newDocs = docs.filter((d) => d.path !== doc.path);
    await fetch(`/api/locations/${id}/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docs: newDocs }),
    });
    setDocs(newDocs);
    toast.success("Dokument gelöscht");
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

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    await supabase.from("location_contacts").insert({ location_id: id, name: contactForm.name, role: contactForm.role || null, email: contactForm.email || null, phone: contactForm.phone || null });
    setContactForm({ name: "", role: "", email: "", phone: "" });
    setShowContactForm(false);
    loadAll();
    toast.success("Kontaktperson hinzugefügt");
  }

  async function deleteContact(contactId: string) {
    await deleteRow("location_contacts", contactId);
    loadAll();
  }

  function handleTaskPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!validateFileSize(file)) return;
    setTaskPhoto({ file, preview: URL.createObjectURL(file) });
    e.target.value = "";
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    const { data: { user } } = await supabase.auth.getUser();

    let photoUrl: string | null = null;
    if (taskPhoto) {
      const ext = taskPhoto.file.name.split(".").pop() || "jpg";
      const path = `maintenance/${id}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("documents").upload(path, taskPhoto.file, { contentType: taskPhoto.file.type });
      if (!error) photoUrl = path;
    }

    const { error: insertErr } = await supabase.from("maintenance_tasks").insert({
      location_id: id,
      title: taskForm.title,
      description: taskForm.description || null,
      photo_url: photoUrl,
      created_by: user?.id,
    });
    if (insertErr) {
      toast.error("Erstellen fehlgeschlagen: " + insertErr.message);
      return;
    }

    setTaskForm({ title: "", description: "" });
    if (taskPhoto) { URL.revokeObjectURL(taskPhoto.preview); setTaskPhoto(null); }
    setShowTaskForm(false);
    loadAll();
    toast.success("Instandhaltungsarbeit erstellt");
  }

  async function deleteTask(task: MaintenanceTaskWithPhoto) {
    const ok = await confirm({
      title: "Arbeit löschen?",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    if (task.photo_url) {
      await supabase.storage.from("documents").remove([task.photo_url]);
    }
    await deleteRow("maintenance_tasks", task.id);
    loadAll();
    toast.success("Arbeit gelöscht");
  }

  function createJobFromTask(task: MaintenanceTaskWithPhoto) {
    const params = new URLSearchParams();
    params.set("title", `Instandhaltung: ${task.title}`);
    if (task.description) params.set("description", task.description);
    if (id) params.set("location_id", id as string);
    if (location?.customer_id) params.set("customer_id", location.customer_id);
    // Verknuepft den neuen Auftrag bei Submit zurueck mit dieser Instandhaltung
    // — sobald der Auftrag abgeschlossen ist, gilt die Arbeit als erledigt.
    params.set("from_maintenance", task.id);
    router.push(`/auftraege/neu?${params.toString()}`);
  }

  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    async function loadPhotoUrls() {
      const urls: Record<string, string> = {};
      for (const t of tasks) {
        if (t.photo_url) {
          // Bucket ist private — signed URLs noetig, sonst 404.
          const { data } = await supabase.storage.from("documents").createSignedUrl(t.photo_url, 3600);
          if (data?.signedUrl) urls[t.id] = data.signedUrl;
        }
      }
      setPhotoUrls(urls);
    }
    if (tasks.length > 0) loadPhotoUrls();
  }, [tasks]);

  if (!location) return <div className="py-20 text-center text-muted-foreground">Laden...</div>;

  const filteredTasks = tasks.filter((t) => taskFilter === "all" || effectiveTaskStatus(t) === taskFilter);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-4">
        <BackButton fallbackHref="/standorte" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{location.name}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {[location.address_street, `${location.address_zip} ${location.address_city}`].filter(Boolean).join(", ")}
            {location.capacity ? ` · ${location.capacity} Personen` : ""}
          </p>
        </div>
      </div>

      {/* Kunde verknüpfen */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Building2 className="h-4 w-4" />Zugewiesener Kunde</CardTitle>
        </CardHeader>
        <CardContent>
          {linkedCustomer ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center font-bold text-sm">{linkedCustomer.name.charAt(0)}</div>
                <div>
                  <p className="font-medium text-sm">{linkedCustomer.name}</p>
                  {linkedCustomer.address_city && <p className="text-xs text-muted-foreground">{linkedCustomer.address_zip} {linkedCustomer.address_city}</p>}
                </div>
              </div>
              <button type="button" onClick={() => linkCustomer("")} className="kasten kasten-muted">Entfernen</button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <select
                onChange={(e) => { if (e.target.value) linkCustomer(e.target.value); }}
                className="flex-1 h-9 px-3 text-sm rounded-lg border border-border bg-muted/40 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                defaultValue=""
              >
                <option value="">Kunde auswählen...</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dokumente */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><FileText className="h-4 w-4" />Dokumente ({docs.length})</CardTitle>
          <button type="button" onClick={() => docRef.current?.click()} disabled={uploadingDoc} className="kasten kasten-muted">
            <Upload className="h-3.5 w-3.5" />
            {uploadingDoc ? "Hochladen…" : "PDF hochladen"}
          </button>
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
                  <p className="text-xs text-muted-foreground">{new Date(d.uploaded_at).toLocaleDateString("de-CH")}</p>
                </div>
              </button>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <button onClick={() => openDocPreview(d)} className="icon-btn icon-btn-blue" data-tooltip="Vorschau"><Eye className="h-4 w-4" /></button>
                <button onClick={() => downloadDoc(d)} className="icon-btn icon-btn-muted" data-tooltip="Herunterladen"><Download className="h-4 w-4" /></button>
                <button onClick={() => deleteDoc(d)} className="icon-btn icon-btn-red" data-tooltip="Löschen"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Kontaktpersonen */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Users className="h-4 w-4" />Kontaktpersonen ({contacts.length})</CardTitle>
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
                <Input placeholder="Funktion (z.B. Hausmeister)" value={contactForm.role} onChange={(e) => setContactForm({ ...contactForm, role: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input placeholder="E-Mail" type="email" value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })} />
                <Input placeholder="Telefon" value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowContactForm(false)} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" className="kasten kasten-red">Speichern</button>
              </div>
            </form>
          )}
          {contacts.length === 0 && !showContactForm && <p className="text-sm text-muted-foreground py-4 text-center">Noch keine Kontaktpersonen.</p>}
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
              <button onClick={() => deleteContact(c.id)} className="icon-btn icon-btn-red"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Instandhaltung */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Wrench className="h-4 w-4" />Instandhaltung ({tasks.length})</CardTitle>
          {can("locations:edit") && (
            <button
              type="button"
              onClick={() => {
                if (!showTaskForm) {
                  setTaskForm({
                    title: location ? `Instandhaltung ${location.name}` : "Instandhaltung",
                    description: "",
                  });
                }
                setShowTaskForm(!showTaskForm);
              }}
              className="kasten kasten-muted"
            >
              {showTaskForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {showTaskForm ? "Abbrechen" : "Neue Arbeit"}
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filter */}
          <div className="flex gap-2">
            {(["all", "offen", "erledigt"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setTaskFilter(f)} className={taskFilter === f ? "kasten-active" : "kasten-toggle-off"}>
                {f === "all" ? "Alle" : f === "offen" ? "Offen" : "Erledigt"}
              </button>
            ))}
          </div>

          {/* Neue Arbeit Formular */}
          {showTaskForm && (
            <form onSubmit={addTask} className="p-4 rounded-xl bg-muted/40 border space-y-3">
              <Input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} placeholder="Titel *" required />
              <textarea placeholder="Beschreibung *" value={taskForm.description} onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring" rows={2} required />

              {/* Foto */}
              {taskPhoto ? (
                <div className="relative rounded-xl overflow-hidden border border-border w-fit">
                  <img src={taskPhoto.preview} alt="Foto" className="h-32 w-auto object-cover rounded-xl" />
                  <button
                    type="button"
                    onClick={() => { URL.revokeObjectURL(taskPhoto.preview); setTaskPhoto(null); }}
                    className="absolute top-1.5 right-1.5 p-1 rounded-full bg-black/50 text-white hover:bg-red-600 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button type="button" onClick={() => taskCameraRef.current?.click()} className="kasten kasten-muted flex-1 py-2.5">
                    <Camera className="h-4 w-4" />Foto aufnehmen
                  </button>
                  <button type="button" onClick={() => taskPhotoRef.current?.click()} className="kasten kasten-muted flex-1 py-2.5">
                    <ImageIcon className="h-4 w-4" />Aus Galerie
                  </button>
                </div>
              )}

              <input ref={taskCameraRef} type="file" accept="image/*" capture="environment" onChange={handleTaskPhoto} className="hidden" />
              <input ref={taskPhotoRef} type="file" accept="image/*" onChange={handleTaskPhoto} className="hidden" />

              <div className="flex gap-2">
                <button type="button" onClick={() => { setShowTaskForm(false); if (taskPhoto) { URL.revokeObjectURL(taskPhoto.preview); setTaskPhoto(null); } }} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" className="kasten kasten-red">Erstellen</button>
              </div>
            </form>
          )}

          {filteredTasks.length === 0 && !showTaskForm && <p className="text-sm text-muted-foreground py-4 text-center">Keine Instandhaltungsarbeiten.</p>}

          {filteredTasks.map((t) => {
            const status = effectiveTaskStatus(t);
            const done = status === "erledigt";
            return (
              <div key={t.id} className={`p-3 rounded-xl border ${done ? "bg-green-50 border-green-100 dark:bg-green-500/10 dark:border-green-500/20" : "bg-muted/40 border-border"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${done ? "line-through text-muted-foreground" : ""}`}>{t.title}</span>
                      {done && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">
                          <Check className="h-3 w-3" />Erledigt
                        </span>
                      )}
                    </div>
                    {t.description && <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">Erstellt: {new Date(t.created_at).toLocaleDateString("de-CH")}</span>
                      {t.job && <span className="text-xs text-muted-foreground">· Auftrag verknüpft</span>}
                    </div>
                    {t.photo_url && photoUrls[t.id] && (
                      <div className="mt-2">
                        <img
                          src={photoUrls[t.id]}
                          alt="Foto"
                          className="h-24 w-auto rounded-lg border border-border object-cover cursor-pointer hover:opacity-90 transition-opacity"
                          onClick={() => window.open(photoUrls[t.id], "_blank")}
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!done && !t.job_id && (
                      <button onClick={() => createJobFromTask(t)} className="kasten kasten-red">
                        <ClipboardList className="h-3.5 w-3.5" />Zu Auftrag
                      </button>
                    )}
                    <button onClick={() => deleteTask(t)} className="kasten kasten-muted">
                      <Trash2 className="h-3.5 w-3.5" />Löschen
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
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
