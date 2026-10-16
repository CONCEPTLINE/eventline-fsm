"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { readImpersonationCookie } from "@/lib/impersonation";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { validateFileList } from "@/lib/file-upload";
import { toLocalIsoString, toDbDate } from "@/lib/format";
import { FormRenderer, validateForm, type FormValues } from "@/components/partner-form/form-renderer";
import { Loading } from "@/components/ui/spinner";
import { extractFormValues } from "@/lib/partner-form/extract";
import { DEFAULT_PARTNER_FORM_SCHEMA } from "@/lib/partner-form/default-schema";
import { resolveSubmitRules, type FormSchema } from "@/lib/partner-form/types";
import { isBlockVisible } from "@/lib/partner-form/conditions";
import { todayLocalISO } from "@/components/auftrag-form-fields";
import { partnerApi } from "@/lib/partner-api";
import { partnerAnhangHochladen } from "@/lib/partner-upload";

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
      // View-As: Location des impersonierten Partners (wie Portal-Layout).
      const profileId = readImpersonationCookie() || user.id;
      const { data: profile } = await supabase
        .from("profiles")
        .select("partner_location_id")
        .eq("id", profileId)
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

  // Primary-Appointment-Status (Convention: termin_date + termin_time_range).
  // Wenn der TimeRange-Block aktuell via visibleIf versteckt ist (z.B.
  // Toggle "EVENTLINE setzt die Zeit" = on), gilt der Termin schon mit
  // nur Datum als "vollstaendig". In dem Fall wird KEIN job_appointment
  // angelegt — der Admin pflegt die Zeit spaeter selbst nach.
  const timeRangeBlock = schema?.blocks.find((b) => b.id === "termin_time_range");
  const timeRangeVisible = !schema || !timeRangeBlock || isBlockVisible(timeRangeBlock, values);
  const apt = schema ? extractFormValues(schema, values).primaryAppointment : {};
  // "Fertig bis"-Termine haben bewusst keine Endzeit — dort reicht
  // Datum + der eine Zeitpunkt.
  const aptDeadline = apt.zeit_modus === "deadline";
  const hasPrimaryAppointment = timeRangeVisible
    ? Boolean(apt.date && apt.start_time && (aptDeadline || apt.end_time))
    : Boolean(apt.date);
  // Termin in der DB anlegen nur wenn date + time vollstaendig — sonst
  // wuerde job_appointments.start_time NOT NULL crashen.
  const willInsertAppointment = Boolean(apt.date && apt.start_time && (aptDeadline || apt.end_time));

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

    // 4) Mode-spezifische Checks — gesteuert von den Schema-Submit-Regeln.
    //    Der Builder erlaubt dem Admin, Termin / Titel / Startdatum / Kontakt
    //    als nicht-Pflicht zu konfigurieren. validateForm() greift fuer
    //    Block-required schon vorher; HIER nur die Mode-Send-Gates.
    const rules = resolveSubmitRules(schema);
    if (mode === "send") {
      if (rules.appointment_required && !hasPrimaryAppointment) {
        toast.error(
          timeRangeVisible
            ? "Zum Absenden ist ein Termin (Datum + Zeit) Pflicht"
            : "Zum Absenden ist ein Termin-Datum Pflicht",
        );
        return;
      }
      if (rules.title_required && !core.title) {
        toast.error("Titel ist Pflicht");
        return;
      }
      if (rules.start_date_required && !core.start_date) {
        toast.error("Veranstaltungs-Startdatum ist Pflicht");
        return;
      }
      if (rules.contact_required && (!core.contact_person || !core.contact_phone)) {
        toast.error("Ansprechperson und Telefon sind Pflicht");
        return;
      }
    }
    // Sanity-Checks (immer): plausible Datumsangaben.
    if (core.start_date && core.start_date < "2020-01-01") {
      toast.error("Startdatum scheint ungültig — bitte korrigieren");
      return;
    }
    if (core.end_date && core.end_date < "2020-01-01") {
      toast.error("Enddatum scheint ungültig — bitte korrigieren");
      return;
    }
    // Wenn Start-Datum nicht gesetzt: heute als Fallback (DB hat NOT NULL,
    // aber bei "nicht Pflicht" ist's egal was drinsteht). Wenn doch Pflicht,
    // ist das schon oben abgefangen.
    const effectiveStartDate = core.start_date || todayLocalISO();
    const effectiveEndDate = core.end_date || effectiveStartDate;
    if (effectiveEndDate < effectiveStartDate) {
      toast.error("Veranstaltungs-Enddatum muss am oder nach Startdatum liegen");
      return;
    }

    // 5) Primary Appointment ggf. zusammenbauen — nur wenn date + time
    //    beide vorhanden. Bei "nur Datum" (TimeRange versteckt) wird kein
    //    job_appointments-Datensatz angelegt.
    let aptStartIso: string | null = null;
    let aptEndIso: string | null = null;
    if (willInsertAppointment) {
      if (primaryAppointment.date! < effectiveStartDate || primaryAppointment.date! > effectiveEndDate) {
        toast.error("Termin-Datum muss innerhalb der Veranstaltung liegen");
        return;
      }
      aptStartIso = toLocalIsoString(primaryAppointment.date!, primaryAppointment.start_time!);
      // "Fertig bis": nur ein Zeitpunkt, keine Endzeit.
      aptEndIso = !aptDeadline && primaryAppointment.end_time
        ? toLocalIsoString(primaryAppointment.date!, primaryAppointment.end_time)
        : null;
      if (aptEndIso && new Date(aptEndIso).getTime() <= new Date(aptStartIso).getTime()) {
        toast.error("Termin-Endzeit muss nach der Startzeit liegen");
        return;
      }
    }

    setSaving(true);
    // Anlegen ueber die Server-Route (eigener Standort, Recht partner:
    // anfragen:create). Fallback-Werte fuer NOT-NULL-Spalten (Titel «Ohne
    // Titel») setzt der Server, wenn der Admin die Pflicht-Regeln deaktiviert
    // hat. Zeitpunkte gehen mit Zeitzone des Browsers mit (toDbDate /
    // toLocalIsoString), wie bisher.
    const r = await partnerApi<{ id: string; warnung?: string }>("/api/partner/anfragen", {
      modus: mode === "send" ? "senden" : "entwurf",
      titel: core.title ?? null,
      beschreibung: core.description ?? null,
      start_date: toDbDate(effectiveStartDate),
      end_date: toDbDate(effectiveEndDate),
      kontakt_person: core.contact_person ?? null,
      kontakt_telefon: core.contact_phone ?? null,
      kontakt_email: core.contact_email ?? null,
      antworten: Object.keys(answers).length > 0 ? answers : null,
      // Schema-Snapshot NUR bei send-Mode — Drafts kommen ggf. wieder
      // in den Editor und sollten beim spaeteren Submit den aktuellen
      // Schema-Stand einfangen, nicht den vom Draft-Anlegen.
      //
      // Effective-Snapshot-Anpassung: wenn TimeRange via visibleIf
      // versteckt war, gilt fuer diesen Job appointment_required=false
      // — sonst wuerde die Absende-Pruefung (partner_submit_anfrage) den
      // hardcoded count>0-Check failen und der Partner kaeme bei einem
      // spaeteren Re-Submit nicht durch.
      schema_snapshot: mode === "send"
        ? (timeRangeVisible
            ? schema
            : { ...schema, submit: { ...(schema.submit ?? {}), appointment_required: false } })
        : null,
      // Termin nur wenn date + time vollstaendig vorhanden waren. Bei «nur
      // Datum»-Anfragen (TimeRange versteckt) wird kein Termin angelegt —
      // der Admin pflegt die Zeit spaeter nach.
      termin: willInsertAppointment && aptStartIso
        ? { start: aptStartIso, ende: aptEndIso, zeit_modus: primaryAppointment.zeit_modus ?? "fix" }
        : null,
    });
    if (!r.ok) {
      setSaving(false);
      TOAST.supabaseError(r.fehler, "Anfrage konnte nicht erstellt werden");
      return;
    }
    const jobId = r.daten.id;
    if (r.daten.warnung) toast.warning(r.daten.warnung);

    // Files hochladen (signierte Upload-URL je Datei, src/lib/partner-upload.ts)
    if (files.length > 0) {
      let ok = 0;
      for (const file of files) {
        const fehler = await partnerAnhangHochladen(jobId, file);
        if (fehler) TOAST.uploadError(fehler);
        else ok++;
      }
      if (ok < files.length) {
        toast.warning(`${ok}/${files.length} Dokumente hochgeladen`);
      }
    }
    setSaving(false);
    if (!r.daten.warnung) toast.success(mode === "send" ? "Anfrage abgeschickt" : "Entwurf gespeichert");
    router.push(`/partner/anfragen/${jobId}`);
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Zurueck-Pfeil und Titel stehen am Handy schon im mobilen Kopf. */}
      <div className="flex items-center gap-3 max-md:hidden">
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
        <CardContent className="p-5 max-md:p-[10px]">
          {!schema ? (
            <Loading label="Form wird geladen…" />
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
