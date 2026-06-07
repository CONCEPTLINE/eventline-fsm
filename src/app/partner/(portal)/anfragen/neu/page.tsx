"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { validateFileList } from "@/lib/file-upload";
import { toLocalIsoString, toDbDate } from "@/lib/format";
import { FormRenderer, validateForm, type FormValues } from "@/components/partner-form/form-renderer";
import { extractFormValues } from "@/lib/partner-form/extract";
import { DEFAULT_PARTNER_FORM_SCHEMA } from "@/lib/partner-form/default-schema";
import type { FormSchema } from "@/lib/partner-form/types";

// Partner-Anfrage-Form — komplett vom Admin im Builder konfiguriert.
// Loadet partner_form_template.live_schema (Fallback Default-Schema)
// und rendert das via FormRenderer. Auf Submit werden die FormValues
// in Job-Spalten + form_answers gesplittet (siehe extract.ts).

export default function NeueAnfragePage() {
  const router = useRouter();
  const supabase = createClient();
  const [schema, setSchema] = useState<FormSchema | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [saving, setSaving] = useState(false);
  const [partnerLocationId, setPartnerLocationId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("partner_location_id")
        .eq("id", user.id)
        .maybeSingle();
      const locId = profile?.partner_location_id ?? null;
      setPartnerLocationId(locId);

      // Schema-Loading-Priority: Location-Override → Global → Default.
      // Eine OR-Query holt beide in einem Roundtrip.
      let live: FormSchema = DEFAULT_PARTNER_FORM_SCHEMA;
      if (locId) {
        const { data: rows } = await supabase
          .from("partner_form_template")
          .select("scope, location_id, live_schema")
          .or(`scope.eq.global,and(scope.eq.location,location_id.eq.${locId})`);
        const locRow = rows?.find((r) => r.scope === "location" && r.location_id === locId);
        const globRow = rows?.find((r) => r.scope === "global");
        live = (locRow?.live_schema as FormSchema | null)
          ?? (globRow?.live_schema as FormSchema | null)
          ?? DEFAULT_PARTNER_FORM_SCHEMA;
      } else {
        const { data: globRow } = await supabase
          .from("partner_form_template")
          .select("live_schema")
          .eq("scope", "global")
          .maybeSingle();
        live = (globRow?.live_schema as FormSchema | null) ?? DEFAULT_PARTNER_FORM_SCHEMA;
      }
      setSchema(live);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Primary-Appointment-Status (Convention: termin_date + termin_time_range)
  // entscheidet, ob "Anfrage senden" aktiv ist.
  const apt = schema ? extractFormValues(schema, values).primaryAppointment : {};
  const hasPrimaryAppointment = Boolean(apt.date && apt.start_time && apt.end_time);

  async function save(mode: "draft" | "send") {
    if (!schema) return;
    setErrors({});

    // 1) Schema-Validation
    const formErrors = validateForm(schema, values);
    if (Object.keys(formErrors).length > 0) {
      setErrors(formErrors);
      toast.error("Bitte Pflichtfelder ausfüllen");
      return;
    }

    // 2) Partner muss Location haben
    if (!partnerLocationId) {
      toast.error("Deinem Profil ist keine Location zugewiesen — wende dich an EVENTLINE.");
      return;
    }

    // 3) Files validieren (size/type)
    const { core, answers, files, primaryAppointment } = extractFormValues(schema, values);
    if (files.length > 0) {
      // Re-Validate via project-Helper (size/MIME)
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const validated = validateFileList(dt.files);
      if (!validated) return;
    }

    // 4) Mode-spezifische Checks
    if (mode === "send" && !hasPrimaryAppointment) {
      toast.error("Zum Absenden ist ein Termin (Datum + Zeit) Pflicht");
      return;
    }
    if (!core.title) {
      toast.error("Titel ist Pflicht");
      return;
    }
    if (!core.start_date) {
      toast.error("Veranstaltungs-Startdatum ist Pflicht");
      return;
    }
    if (!core.contact_person || !core.contact_phone) {
      toast.error("Ansprechperson und Telefon sind Pflicht");
      return;
    }
    const effectiveEndDate = core.end_date || core.start_date;
    if (effectiveEndDate < core.start_date) {
      toast.error("Veranstaltungs-Enddatum muss am oder nach Startdatum liegen");
      return;
    }

    // 5) Primary Appointment ggf. zusammenbauen
    let aptStartIso: string | null = null;
    let aptEndIso: string | null = null;
    if (hasPrimaryAppointment) {
      if (primaryAppointment.date! < core.start_date || primaryAppointment.date! > effectiveEndDate) {
        toast.error("Termin-Datum muss innerhalb der Veranstaltung liegen");
        return;
      }
      aptStartIso = toLocalIsoString(primaryAppointment.date!, primaryAppointment.start_time!);
      aptEndIso = toLocalIsoString(primaryAppointment.date!, primaryAppointment.end_time!);
      if (new Date(aptEndIso).getTime() <= new Date(aptStartIso).getTime()) {
        toast.error("Termin-Endzeit muss nach der Startzeit liegen");
        return;
      }
    }

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    const targetStatus = mode === "send" ? "partner_anfrage" : "partner_entwurf";
    const { data, error } = await supabase
      .from("jobs")
      .insert({
        title: core.title.trim(),
        description: core.description?.trim() || null,
        start_date: toDbDate(core.start_date),
        end_date: toDbDate(effectiveEndDate),
        status: targetStatus,
        location_id: partnerLocationId,
        contact_person: core.contact_person.trim(),
        contact_phone: core.contact_phone.trim(),
        contact_email: core.contact_email?.trim() || null,
        created_by: user.id,
        form_answers: Object.keys(answers).length > 0 ? answers : null,
      })
      .select("id")
      .single();
    if (error || !data) {
      setSaving(false);
      TOAST.supabaseError(error, "Anfrage konnte nicht erstellt werden");
      return;
    }

    // Termin nur anlegen wenn ausgefuellt
    let aptErr: { message: string } | null = null;
    if (hasPrimaryAppointment && aptStartIso && aptEndIso) {
      const { error: tErr } = await supabase.from("job_appointments").insert({
        job_id: data.id,
        title: core.title.trim(),
        start_time: aptStartIso,
        end_time: aptEndIso,
        description: null,
      });
      if (tErr) {
        aptErr = tErr;
        toast.warning("Anfrage erstellt, aber Termin konnte nicht angelegt werden — bitte auf Detail-Seite manuell hinzufügen");
      }
    }

    // Files hochladen
    if (files.length > 0) {
      const ok = await uploadFiles(files, data.id, user.id);
      if (ok < files.length) {
        toast.warning(`${ok}/${files.length} Dokumente hochgeladen`);
      }
    }
    setSaving(false);
    if (!aptErr) toast.success(mode === "send" ? "Anfrage abgeschickt" : "Entwurf gespeichert");
    router.push(`/partner/anfragen/${data.id}`);
  }

  async function uploadFiles(files: File[], jobId: string, userId: string): Promise<number> {
    let okCount = 0;
    for (const file of files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `partner-anfragen/${jobId}/${Date.now()}_${safeName}`;
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (!json.success) { TOAST.uploadError(json.error); continue; }
        const { error: insertErr } = await supabase.from("documents").insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type || null,
          job_id: jobId,
          uploaded_by: userId,
        });
        if (insertErr) { TOAST.supabaseError(insertErr, "Dokument konnte nicht gespeichert werden"); continue; }
        okCount++;
      } catch (err) {
        TOAST.uploadError(err instanceof Error ? err.message : "Netzwerkfehler");
      }
    }
    return okCount;
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
          {!schema ? (
            <p className="text-sm text-muted-foreground">Form wird geladen…</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); save(hasPrimaryAppointment ? "send" : "draft"); }} className="space-y-4">
              <FormRenderer schema={schema} values={values} onChange={setValues} />

              {Object.keys(errors).length > 0 && (
                <div className="px-3 py-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 text-xs text-red-800 dark:text-red-300">
                  <p className="font-semibold mb-1">Bitte korrigieren:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {Object.entries(errors).map(([k, v]) => <li key={k}>{v}</li>)}
                  </ul>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => router.back()}
                  disabled={saving}
                  className="kasten kasten-muted flex-1"
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={() => save("draft")}
                  disabled={saving}
                  className="kasten kasten-muted flex-1"
                >
                  {saving ? "Speichern…" : (schema.submit?.draft_label ?? "Als Entwurf speichern")}
                </button>
                <button
                  type="button"
                  onClick={() => save("send")}
                  disabled={saving || !hasPrimaryAppointment}
                  className="kasten kasten-red flex-1"
                  data-tooltip={!hasPrimaryAppointment ? "Termin (Datum + Zeit) nötig zum Absenden" : undefined}
                >
                  {saving ? "Sendet…" : (schema.submit?.send_label ?? "Anfrage senden")}
                </button>
              </div>

              <p className="text-[11px] text-muted-foreground pt-2">
                Ohne Termin landet die Anfrage als Entwurf in „Meine Anfragen“. Sobald du einen Termin eingegeben hast, kannst du „Anfrage senden“ drücken — EVENTLINE bekommt sie dann zur Prüfung.
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
