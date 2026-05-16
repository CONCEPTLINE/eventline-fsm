"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AuftragFormFields,
  type AuftragFormState,
  type Customer,
  type Location,
  type Room,
  todayLocalISO,
} from "@/components/auftrag-form-fields";
import { Save, FileEdit, Paperclip, X } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { scrollToError } from "@/lib/scroll-to-error";
import Link from "next/link";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { JobNumber } from "@/components/job-number";
import { popFormDraft, saveFormDraft } from "@/lib/form-resume";
import { validateFileList } from "@/lib/file-upload";
import { logError } from "@/lib/log";
import { toDbDate } from "@/lib/format";
import { usePermissions } from "@/lib/use-permissions";

const RETURN_PATH = "/auftraege/neu";

function NeuerAuftragPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  // Admins haben keine Vergangenheits-Datumsblockade — koennen Auftraege
  // rueckwirkend erfassen (z.B. nach Event-Wochenende nachpflegen).
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  // Aus Instandhaltung kommend: Titel/Location/Veranstalter-Kontakt fallen
  // weg, "Als Entwurf"-Pfad ebenfalls — eine technische Arbeit am Standort
  // soll nicht als Vermarktungs-Entwurf parkiert werden.
  const fromMaintenance = !!searchParams.get("from_maintenance");
  const [saving, setSaving] = useState<"draft" | "create" | null>(null);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [nextJobNumber, setNextJobNumber] = useState<number | null>(null);
  // Stage-Uploads: Dateien werden client-seitig gehalten und erst NACH der
  // Job-Insertion (wenn die ID feststeht) zur Storage hochgeladen.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const [form, setForm] = useState<AuftragFormState>({
    job_type: "location",
    title: searchParams.get("title") || "",
    description: searchParams.get("description") || "",
    location_id: searchParams.get("location_id") || "",
    customer_id: searchParams.get("customer_id") || "",
    external_address: "",
    room_id: "",
    start_date: "",
    end_date: "",
    urgent: false,
    contact_person: "",
    contact_phone: "",
    contact_email: "",
  });

  // Draft-Restore wenn von /kunden/neu zurueckkommend
  useEffect(() => {
    const newCustomerId = searchParams.get("customerId");
    if (!newCustomerId) return;
    const draft = popFormDraft<AuftragFormState>(RETURN_PATH);
    if (draft) {
      setForm({ ...draft, customer_id: newCustomerId, job_type: "extern" });
    } else {
      setForm((p) => ({ ...p, customer_id: newCustomerId, job_type: "extern" }));
    }
    router.replace(RETURN_PATH, { scroll: false });
  }, [searchParams, router]);

  function startCreateCustomer(query: string) {
    saveFormDraft<AuftragFormState>(RETURN_PATH, form);
    router.push(`/kunden/neu?prefillName=${encodeURIComponent(query)}&return=${encodeURIComponent(RETURN_PATH)}`);
  }

  useEffect(() => {
    async function loadData() {
      const [custRes, locRes, roomRes, maxRes] = await Promise.all([
        supabase.from("customers").select("id, name, address_street, address_zip, address_city").eq("is_active", true).order("name"),
        supabase
          .from("locations")
          .select("id, name, address_street, address_zip, address_city")
          .eq("is_active", true)
          .order("name"),
        supabase
          .from("rooms")
          .select("id, name, address_street, address_zip, address_city")
          .eq("is_active", true)
          .order("name"),
        supabase
          .from("jobs")
          .select("job_number")
          .not("job_number", "is", null)
          .order("job_number", { ascending: false })
          .limit(1),
      ]);
      setCustomers((custRes.data as Customer[]) ?? []);
      setLocations((locRes.data as Location[]) ?? []);
      setRooms((roomRes.data as Room[]) ?? []);
      const maxRow = maxRes.data?.[0] as { job_number: number } | undefined;
      setNextJobNumber(maxRow?.job_number ? maxRow.job_number + 1 : 26200);
    }
    loadData();
  }, []);

  // Validate liefert sowohl die Fehlermeldung als auch die ID des Feldes
  // — damit der submit-Handler beim Fehler an die richtige Stelle scrollen
  // kann (Form ist mehrere Bildschirme lang, Toast allein wird leicht
  // uebersehen).
  function validate(target: "draft" | "create"): { error: string; field?: string } | null {
    if (!form.title.trim()) return { error: "Titel ist Pflicht", field: "title" };
    if (target === "draft") {
      if (form.start_date && form.end_date && form.end_date < form.start_date) {
        return { error: "Enddatum darf nicht vor dem Startdatum liegen", field: "end_date" };
      }
      return null;
    }
    if (form.job_type === "location" && !form.location_id) {
      return { error: "Bitte eine Location auswählen", field: "location_id" };
    }
    if (form.job_type === "extern") {
      if (!form.customer_id) return { error: "Bitte einen Kunden auswählen", field: "customer_id" };
      if (!form.external_address.trim()) return { error: "Bitte einen Ort angeben", field: "external_address" };
    }
    if (form.job_type === "location" && !fromMaintenance) {
      if (!form.contact_person.trim()) return { error: "Bitte Ansprechperson angeben", field: "contact_person" };
      if (!form.contact_phone.trim()) return { error: "Bitte Telefon der Ansprechperson angeben", field: "contact_phone" };
    }
    if (!form.start_date) return { error: "Bitte Startdatum angeben", field: "start_date" };
    if (!form.end_date) return { error: "Bitte Enddatum angeben", field: "end_date" };
    if (!isAdmin) {
      const todayStr = todayLocalISO();
      if (form.start_date < todayStr) return { error: "Startdatum darf nicht in der Vergangenheit liegen", field: "start_date" };
      if (form.end_date < todayStr) return { error: "Enddatum darf nicht in der Vergangenheit liegen", field: "end_date" };
    }
    if (form.end_date < form.start_date) {
      return { error: "Enddatum darf nicht vor dem Startdatum liegen", field: "end_date" };
    }
    return null;
  }

  async function submit(target: "draft" | "create") {
    const err = validate(target);
    if (err) {
      toast.error(err.error);
      scrollToError(err.field);
      return;
    }
    setSaving(target);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const payload = {
      job_type: form.job_type,
      title: form.title.trim(),
      description: form.description.trim() || null,
      status: target === "draft" ? "entwurf" : "offen",
      priority: form.urgent ? "dringend" : "normal",
      customer_id: form.job_type === "extern" && form.customer_id ? form.customer_id : null,
      location_id: form.job_type === "location" && form.location_id ? form.location_id : null,
      room_id: form.job_type === "extern" && form.room_id ? form.room_id : null,
      external_address: form.job_type === "extern" ? form.external_address.trim() || null : null,
      start_date: toDbDate(form.start_date),
      end_date: toDbDate(form.end_date),
      // Kontakt-Felder bleiben im Form-State (UX-Recovery), werden aber
      // bei extern-Auftraegen NICHT persistiert — der Customer ist dort
      // selber der Kontakt.
      contact_person: form.job_type === "location" ? (form.contact_person.trim() || null) : null,
      contact_phone:  form.job_type === "location" ? (form.contact_phone.trim()  || null) : null,
      contact_email:  form.job_type === "location" ? (form.contact_email.trim()  || null) : null,
      created_by: user?.id,
    };

    const { data: inserted, error } = await supabase
      .from("jobs")
      .insert(payload)
      .select("id, job_number")
      .single();

    if (error || !inserted) {
      TOAST.supabaseError(error, "Auftrag konnte nicht angelegt werden");
      setSaving(null);
      return;
    }

    // Wenn der Auftrag aus einer Instandhaltungsarbeit erstellt wurde,
    // verknuepfen wir hier zurueck. Sobald der Auftrag spaeter abgeschlossen
    // wird, gilt die Instandhaltung als erledigt.
    const fromMaintenance = searchParams.get("from_maintenance");
    if (fromMaintenance) {
      await supabase.from("maintenance_tasks").update({ job_id: inserted.id }).eq("id", fromMaintenance);
    }

    // Stage-Files hochladen falls vorhanden — Fehler werden gesammelt und
    // dem User danach als Toast angezeigt, der Job-Insert ist schon durch.
    const uploadFails: string[] = [];
    if (pendingFiles.length > 0 && user) {
      for (const file of pendingFiles) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `jobs/${inserted.id}/${Date.now()}_${safeName}`;
        try {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("path", path);
          const res = await fetch("/api/upload", { method: "POST", body: formData });
          const json = await res.json();
          if (!json.success) {
            logError("auftrag.neu.upload", json.error, { fileName: file.name });
            uploadFails.push(file.name);
            continue;
          }
          await supabase.from("documents").insert({
            name: file.name,
            storage_path: path,
            file_size: file.size,
            mime_type: file.type,
            job_id: inserted.id,
            uploaded_by: user.id,
          });
        } catch (err) {
          logError("auftrag.neu.upload", err, { fileName: file.name });
          uploadFails.push(file.name);
        }
      }
    }
    if (uploadFails.length > 0) {
      const list = uploadFails.length <= 3
        ? uploadFails.join(", ")
        : `${uploadFails.slice(0, 3).join(", ")} +${uploadFails.length - 3} weitere`;
      toast.error(`${uploadFails.length} Datei(en) konnten nicht hochgeladen werden: ${list}. Du kannst sie nachträglich auf der Detail-Seite hochladen.`, {
        duration: 8000,
      });
    }

    if (target === "draft") {
      toast.success(`Entwurf INT-${inserted.job_number} gespeichert`);
      router.push("/auftraege");
    } else {
      toast.success(`Auftrag INT-${inserted.job_number} erstellt`, {
        duration: 5000,
        action: {
          label: "Rückgängig",
          onClick: async () => {
            const { data: updated, error: delErr } = await supabase
              .from("jobs")
              .update({ is_deleted: true })
              .eq("id", inserted.id)
              .select("id");
            if (delErr || !updated || updated.length === 0) {
              toast.error("Konnte nicht rückgängig gemacht werden");
              return;
            }
            toast.success(`INT-${inserted.job_number} verworfen`);
            window.dispatchEvent(new Event("jobs:invalidate"));
          },
        },
      });
      router.push("/auftraege");
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <BackButton fallbackHref="/auftraege" size="sm" />
        {nextJobNumber ? (
          <JobNumber number={nextJobNumber} size="xl" />
        ) : (
          <span className="font-mono text-xl font-semibold text-muted-foreground">INT-…</span>
        )}
      </div>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit("create");
        }}
        className="rounded-xl border bg-card p-5 space-y-5"
      >
        <AuftragFormFields
          form={form}
          onChange={setForm}
          customers={customers}
          locations={locations}
          rooms={rooms}
          onCreateCustomer={startCreateCustomer}
          fromMaintenance={fromMaintenance}
          enforceNoPastDates={!isAdmin}
        />

        <hr className="border-border/50" />

        {/* Dokumente — werden nach dem Speichern unter dem neuen Auftrag
            in Storage hochgeladen + als documents-Row registriert. */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Dokumente</p>
          <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed bg-muted/20 text-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors cursor-pointer">
            <Paperclip className="h-4 w-4" />
            Dateien auswählen…
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                const fs = e.target.files;
                if (!fs || fs.length === 0) return;
                const validated = validateFileList(fs);
                if (validated) setPendingFiles((prev) => [...prev, ...validated]);
                e.target.value = "";
              }}
            />
          </label>
          {pendingFiles.length > 0 && (
            <ul className="space-y-1">
              {pendingFiles.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-sm bg-muted/20 px-3 py-1.5 rounded-lg">
                  <span className="truncate flex-1">{f.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                  <button
                    type="button"
                    onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    aria-label="Entfernen"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-3 pt-2">
          <Link
            href="/auftraege"
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </Link>
          <button
            type="button"
            disabled={saving !== null || fromMaintenance}
            onClick={() => submit("draft")}
            className="kasten kasten-purple flex-1"
            data-tooltip={fromMaintenance ? "Instandhaltungs-Aufträge werden direkt erstellt, nicht als Entwurf gespeichert" : undefined}
          >
            <FileEdit className="h-3.5 w-3.5" />
            {saving === "draft" ? "Speichert…" : "Als Entwurf"}
          </button>
          <button
            type="submit"
            disabled={saving !== null}
            className="kasten kasten-red flex-1"
          >
            <Save className="h-3.5 w-3.5" />
            {saving === "create" ? "Speichert…" : "Auftrag erstellen"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NeuerAuftragPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-muted-foreground">Laden…</div>}>
      <NeuerAuftragPageContent />
    </Suspense>
  );
}
