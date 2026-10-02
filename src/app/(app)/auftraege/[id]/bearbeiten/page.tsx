"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AuftragFormFields,
  type AuftragFormState,
  type Customer,
  type Location,
  type Mitarbeiter,
  type Room,
} from "@/components/auftrag-form-fields";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { Save } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import Link from "next/link";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { JobNumber } from "@/components/job-number";
import { popFormDraft, saveFormDraft } from "@/lib/form-resume";
import { JOB_FORM_FIELDS } from "@/lib/constants";
import { toDbDate } from "@/lib/format";
import { localDateIso } from "@/lib/swiss-time";

function dateToISODate(d: string | null): string {
  if (!d) return "";
  // ZRH-Datum zwingend — .slice(0,10) auf timestamptz waere UTC und der
  // <Input type="date">-Picker zeigt dann den Vortag.
  return localDateIso(new Date(d));
}

export default function AuftragBearbeitenPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const jobId = params.id as string;
  const returnPath = `/auftraege/${jobId}/bearbeiten`;
  const supabase = createClient();

  const [saving, setSaving] = useState<boolean>(false);
  const [loadingJob, setLoadingJob] = useState(true);
  const [jobNumber, setJobNumber] = useState<number | null>(null);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [mitarbeiter, setMitarbeiter] = useState<Mitarbeiter[] | null>(null);

  const [form, setForm] = useState<AuftragFormState>({
    job_type: "location",
    title: "",
    description: "",
    location_id: "",
    customer_id: "",
    external_address: "",
    room_id: "",
    start_date: "",
    end_date: "",
    urgent: false,
    contact_person: "",
    contact_phone: "",
    contact_email: "",
    project_lead_id: "",
  });

  useEffect(() => {
    async function loadAll() {
      const [jobRes, custRes, locRes, roomRes, maRes] = await Promise.all([
        supabase
          .from("jobs")
          .select(JOB_FORM_FIELDS)
          .eq("id", jobId)
          .single(),
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
          .from("profiles")
          .select("id, full_name")
          .eq("is_active", true)
          .not("role", "in", PORTAL_ROLLEN_IN)
          .order("full_name"),
      ]);

      setCustomers((custRes.data as Customer[]) ?? []);
      setLocations((locRes.data as Location[]) ?? []);
      setRooms((roomRes.data as Room[]) ?? []);
      setMitarbeiter(((maRes.data ?? []) as Mitarbeiter[]).filter((m) => m.full_name));

      if (jobRes.error || !jobRes.data) {
        toast.error("Auftrag nicht gefunden");
        router.push("/auftraege");
        return;
      }

      const j = jobRes.data;
      setJobNumber(j.job_number);

      // Resume-Pfad: kommen wir gerade von /kunden/neu zurueck, dann ueberschreibt
      // der Draft den DB-Stand und der frische customer_id wird aus der URL gesetzt.
      const newCustomerId = searchParams.get("customerId");
      const draft = newCustomerId ? popFormDraft<AuftragFormState>(returnPath) : null;

      if (draft && newCustomerId) {
        setForm({ ...draft, customer_id: newCustomerId, job_type: "extern" });
        router.replace(returnPath, { scroll: false });
      } else if (newCustomerId) {
        setForm({
          job_type: "extern",
          title: j.title ?? "",
          description: j.description ?? "",
          location_id: j.location_id ?? "",
          customer_id: newCustomerId,
          external_address: j.external_address ?? "",
          room_id: j.room_id ?? "",
          start_date: dateToISODate(j.start_date),
          end_date: dateToISODate(j.end_date),
          urgent: j.priority === "dringend",
          contact_person: j.contact_person ?? "",
          contact_phone: j.contact_phone ?? "",
          contact_email: j.contact_email ?? "",
          project_lead_id: j.project_lead_id ?? "",
        });
        router.replace(returnPath, { scroll: false });
      } else {
        setForm({
          job_type: (j.job_type as "location" | "extern") ?? "location",
          title: j.title ?? "",
          description: j.description ?? "",
          location_id: j.location_id ?? "",
          customer_id: j.customer_id ?? "",
          external_address: j.external_address ?? "",
          room_id: j.room_id ?? "",
          start_date: dateToISODate(j.start_date),
          end_date: dateToISODate(j.end_date),
          urgent: j.priority === "dringend",
          contact_person: j.contact_person ?? "",
          contact_phone: j.contact_phone ?? "",
          contact_email: j.contact_email ?? "",
          project_lead_id: j.project_lead_id ?? "",
        });
      }
      setLoadingJob(false);
    }
    loadAll();
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  function startCreateCustomer(query: string) {
    saveFormDraft<AuftragFormState>(returnPath, form);
    router.push(`/kunden/neu?prefillName=${encodeURIComponent(query)}&return=${encodeURIComponent(returnPath)}`);
  }

  function validate(): string | null {
    if (!form.title.trim()) return "Titel ist Pflicht";
    if (!form.project_lead_id) return "Bitte eine verantwortliche Person wählen";
    // 4-stelliges Jahr erzwingen — verhindert Jahr-0026-Bug.
    const yearOk = (iso: string) => !iso || /^[12]\d{3}-/.test(iso);
    if (!yearOk(form.start_date)) return "Startdatum: bitte ein 4-stelliges Jahr angeben";
    if (!yearOk(form.end_date))   return "Enddatum: bitte ein 4-stelliges Jahr angeben";
    if (form.job_type === "location" && !form.location_id) {
      return "Bitte eine Location auswählen";
    }
    if (form.job_type === "extern") {
      if (!form.customer_id) return "Bitte einen Kunden auswählen";
      if (!form.external_address.trim()) return "Bitte einen Ort angeben";
    }
    // Veranstalter-Kontakt nur bei Location-Auftraegen — bei Firma/Privat
    // ist der Customer der Kontakt.
    if (form.job_type === "location") {
      if (!form.contact_person.trim()) return "Bitte Ansprechperson angeben";
      if (!form.contact_phone.trim()) return "Bitte Telefon der Ansprechperson angeben";
    }
    if (!form.start_date) return "Bitte Startdatum angeben";
    if (!form.end_date) return "Bitte Enddatum angeben";
    if (form.end_date < form.start_date) {
      return "Enddatum darf nicht vor dem Startdatum liegen";
    }
    return null;
  }

  async function submit() {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);

    const payload = {
      job_type: form.job_type,
      title: form.title.trim(),
      description: form.description.trim() || null,
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
      project_lead_id: form.project_lead_id,
    };

    const { data: updated, error } = await supabase
      .from("jobs")
      .update(payload)
      .eq("id", jobId)
      .select("id");

    if (error || !updated || updated.length === 0) {
      TOAST.supabaseError(error, "Auftrag konnte nicht gespeichert werden");
      setSaving(false);
      return;
    }

    toast.success(`Änderungen gespeichert`);
    window.dispatchEvent(new Event("jobs:invalidate"));
    router.push("/auftraege");
  }

  if (loadingJob) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="h-8 w-40 rounded bg-muted animate-pulse mb-4" />
        <div className="h-96 rounded-xl bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <BackButton fallbackHref="/auftraege" size="sm" />
        <h1 className="text-xl font-bold tracking-tight">Auftrag bearbeiten</h1>
        <div className="ml-auto">
          <JobNumber number={jobNumber} />
        </div>
      </div>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="rounded-xl border bg-card p-5 space-y-5"
      >
        <AuftragFormFields
          form={form}
          onChange={setForm}
          customers={customers}
          locations={locations}
          rooms={rooms}
          enforceNoPastDates={false}
          onCreateCustomer={startCreateCustomer}
          mitarbeiter={mitarbeiter}
        />

        {/* Buttons */}
        <div className="flex gap-3 pt-2">
          <Link
            href="/auftraege"
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="kasten kasten-red flex-1"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </form>
    </div>
  );
}
