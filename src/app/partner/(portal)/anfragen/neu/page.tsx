"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Upload, FileText, X } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { validateFileList } from "@/lib/file-upload";

// Minimaler Form fuer Partner-Anfrage. Erstellt Job mit status='partner_anfrage'.
// Optional koennen Dokumente direkt mit angehaengt werden — die werden
// erst NACH dem Job-Insert hochgeladen (sonst gibt's keinen job_id-Bezug).
// Termine kann der Partner danach auf der Detail-Page hinzufuegen.

export default function NeueAnfragePage() {
  const router = useRouter();
  const supabase = createClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [partnerLocationId, setPartnerLocationId] = useState<string | null>(null);
  // Datei-Staging: bis zum Save bleiben die Files nur im Browser-RAM.
  // Erst nach erfolgreichem Job-Insert werden sie hochgeladen.
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from("profiles")
        .select("partner_location_id")
        .eq("id", user.id)
        .maybeSingle();
      setPartnerLocationId(data?.partner_location_id ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const validated = validateFileList(files);
    if (!validated) return;
    setStagedFiles((prev) => [...prev, ...validated]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeStaged(idx: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function uploadStagedFiles(jobId: string, userId: string): Promise<number> {
    let okCount = 0;
    for (const file of stagedFiles) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `partner-anfragen/${jobId}/${Date.now()}_${safeName}`;
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (!json.success) {
          TOAST.uploadError(json.error);
          continue;
        }
        const { error: insertErr } = await supabase.from("documents").insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type || null,
          job_id: jobId,
          uploaded_by: userId,
        });
        if (insertErr) {
          TOAST.supabaseError(insertErr, "Dokument konnte nicht gespeichert werden");
          continue;
        }
        okCount++;
      } catch (err) {
        TOAST.uploadError(err instanceof Error ? err.message : "Netzwerkfehler");
      }
    }
    return okCount;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !startDate || !startTime || !endTime) {
      toast.error("Titel, Datum und Uhrzeiten sind Pflicht");
      return;
    }
    if (!contactPerson.trim() || !contactPhone.trim()) {
      toast.error("Ansprechperson und Telefon sind Pflicht");
      return;
    }
    if (!partnerLocationId) {
      toast.error("Deinem Profil ist keine Location zugewiesen — wende dich an Eventline.");
      return;
    }
    const effectiveEndDate = endDate || startDate;
    // Sanity: End-Zeitpunkt muss nach Start-Zeitpunkt liegen
    const startIso = `${startDate}T${startTime}:00`;
    const endIso = `${effectiveEndDate}T${endTime}:00`;
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      toast.error("Endzeit muss nach der Startzeit liegen");
      return;
    }
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    const { data, error } = await supabase
      .from("jobs")
      .insert({
        title: title.trim(),
        description: description.trim() || null,
        start_date: startDate,
        end_date: effectiveEndDate,
        status: "partner_anfrage",
        location_id: partnerLocationId,
        contact_person: contactPerson.trim(),
        contact_phone: contactPhone.trim(),
        contact_email: contactEmail.trim() || null,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error || !data) {
      setSaving(false);
      TOAST.supabaseError(error, "Anfrage konnte nicht erstellt werden");
      return;
    }
    // Termin direkt mit anlegen — wird auf der Job als Veranstaltungs-
    // Termin gefuehrt. Wenn der Partner spaeter mehr Termine braucht
    // (Aufbau, Abbau), kann er die im Detail-View nachziehen.
    const { error: terminErr } = await supabase
      .from("job_appointments")
      .insert({
        job_id: data.id,
        title: title.trim(),
        start_time: startIso,
        end_time: endIso,
        description: null,
      });
    if (terminErr) {
      // Job ist trotzdem da — wir warnen und schicken den User zum Detail,
      // wo er den Termin manuell anlegen kann.
      toast.warning("Anfrage erstellt, aber Termin konnte nicht angelegt werden — bitte auf Detail-Seite manuell hinzufügen");
    }
    if (stagedFiles.length > 0) {
      const ok = await uploadStagedFiles(data.id, user.id);
      if (ok < stagedFiles.length) {
        toast.warning(`${ok}/${stagedFiles.length} Dokumente hochgeladen`);
      }
    }
    setSaving(false);
    if (!terminErr) toast.success("Anfrage erstellt");
    router.push(`/partner/anfragen/${data.id}`);
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.back()}
          className="p-2 rounded-lg hover:bg-foreground/5 dark:hover:bg-foreground/10 transition-colors"
          aria-label="Zurück"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">Neue Anfrage</h1>
      </div>

      <Card className="bg-card">
        <CardContent className="p-5">
          <form onSubmit={save} className="space-y-4">
            <div>
              <label className="text-xs font-medium">Titel *</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="z.B. Hochzeit Müller / Konzert XYZ"
                className="mt-1"
                required
                autoFocus
              />
            </div>

            <div className="space-y-3 p-3 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] border border-foreground/10 dark:border-foreground/15">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Termin</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium">Startdatum *</label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="mt-1"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Startzeit *</label>
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="mt-1"
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium">Enddatum</label>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="mt-1"
                    min={startDate || undefined}
                    placeholder={startDate || undefined}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">Leer = gleicher Tag wie Start</p>
                </div>
                <div>
                  <label className="text-xs font-medium">Endzeit *</label>
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="mt-1"
                    required
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium">Beschreibung</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Was ist geplant? Art der Veranstaltung, Besonderheiten, Anzahl Gäste…"
                rows={4}
                className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
                style={{ fieldSizing: "content" } as React.CSSProperties}
              />
            </div>

            {/* Veranstalter-Kontakt — wie auf der internen Auftrag-Neu-Page.
                Ansprechperson + Telefon Pflicht, Mail optional. Eventline
                kann damit direkt mit dem Endkunden sprechen falls noetig
                (sonst muesste alles ueber den Partner laufen). */}
            <div className="space-y-2 pt-2 border-t border-border">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Veranstalter-Kontakt</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium">Ansprechperson *</label>
                  <Input
                    placeholder="Vor- und Nachname"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                    className="mt-1"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">Telefon *</label>
                  <Input
                    type="tel"
                    inputMode="tel"
                    placeholder="0041 55 556 62 61"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value.replace(/[^0-9+ ]/g, ""))}
                    className="mt-1"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium">E-Mail</label>
                <Input
                  type="email"
                  placeholder="optional"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>

            {/* Anhaenge — Staging im Client, Upload erst nach erfolgreichem Job-Insert */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium">Anhänge</label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving}
                  className="kasten kasten-muted"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Dokument hinzufügen
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                  className="hidden"
                  onChange={onFilesPicked}
                />
              </div>
              {stagedFiles.length === 0 ? (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  Optional — z.B. Anfrage-PDF, Skizzen, Bilder.
                </p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {stagedFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-xs truncate">{f.name}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {(f.size / 1024).toFixed(0)} KB
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeStaged(i)}
                        disabled={saving}
                        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0"
                        aria-label="Anhang entfernen"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => router.back()}
                disabled={saving}
                className="kasten kasten-muted flex-1"
              >
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={saving}
                className="kasten kasten-red flex-1"
              >
                {saving ? "Speichern…" : "Anfrage erstellen"}
              </button>
            </div>

            <p className="text-[11px] text-muted-foreground pt-2">
              Weitere Termine (Aufbau, Abbau, etc.) kannst du nach dem Speichern auf der Anfrage-Detail-Seite hinzufügen.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
