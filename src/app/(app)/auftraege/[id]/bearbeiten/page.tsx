"use client";

import { useEffect, useRef, useState } from "react";
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
import { Loader2, Save } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { JobNumber } from "@/components/job-number";
import { popFormDraft, saveFormDraft } from "@/lib/form-resume";
import { JOB_FORM_FIELDS } from "@/lib/constants";
import { bearbeitenPayload } from "@/lib/auftrag-bearbeiten";
import { localDateIso } from "@/lib/swiss-time";
import { usePermissions } from "@/lib/use-permissions";
import { auftragArchiviert, AUFTRAG_ARCHIV_MELDUNG } from "@/lib/archiv";

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
  const auftragPath = `/auftraege/${jobId}`;
  // Vom «Bearbeiten»-Knopf im Auftragskopf geoeffnet (?von=auftrag): dann
  // fuehren Speichern/Abbrechen per Browser-Zurueck in den Auftrag — mit dem
  // vorher offenen Tab und ohne doppelten History-Eintrag.
  const vonAuftrag = searchParams.get("von") === "auftrag";
  const supabase = createClient();
  const { can, ready: permsReady } = usePermissions();
  const darfBearbeiten = can("auftraege:edit"); // Admin immer (hasPermission)

  // DB-Stand beim Laden (Formular-Form) — Basis fuer den Nur-Aenderungen-Payload.
  const geladenRef = useRef<AuftragFormState | null>(null);
  const keinRechtGemeldet = useRef(false);

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
      // Archiv = nur lesen (src/lib/archiv.ts): abgeschlossene/stornierte
      // Auftraege lassen sich nicht bearbeiten — zurueck in den Auftrag.
      if (auftragArchiviert(j.status)) {
        toast.error(AUFTRAG_ARCHIV_MELDUNG);
        router.replace(auftragPath);
        return;
      }
      setJobNumber(j.job_number);

      // DB-Stand in Formular-Form — Vergleichsbasis fuer «was hat der Nutzer
      // wirklich geaendert» (bearbeitenPayload). Immer der DB-Stand, auch
      // wenn unten ein Entwurf aus /kunden/neu das Formular vorbelegt.
      const geladen: AuftragFormState = {
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
      };
      geladenRef.current = geladen;

      // Resume-Pfad: kommen wir gerade von /kunden/neu zurueck, dann ueberschreibt
      // der Draft den DB-Stand und der frische customer_id wird aus der URL gesetzt.
      const newCustomerId = searchParams.get("customerId");
      const draft = newCustomerId ? popFormDraft<AuftragFormState>(returnPath) : null;

      if (draft && newCustomerId) {
        setForm({ ...draft, customer_id: newCustomerId, job_type: "extern" });
        router.replace(returnPath, { scroll: false });
      } else if (newCustomerId) {
        setForm({ ...geladen, job_type: "extern", customer_id: newCustomerId });
        router.replace(returnPath, { scroll: false });
      } else {
        setForm(geladen);
      }
      setLoadingJob(false);
    }
    loadAll();
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rechte-Check: ohne auftraege:edit (z.B. zugeteilter Techniker, der die
  // URL direkt aufruft) zurueck in den Auftrag. Die RLS jobs_update_assigned
  // (Migration 265) wuerde das Speichern sonst zulassen.
  useEffect(() => {
    if (!permsReady || darfBearbeiten) return;
    if (!keinRechtGemeldet.current) {
      keinRechtGemeldet.current = true;
      toast.error("Keine Berechtigung, Aufträge zu bearbeiten");
    }
    router.replace(auftragPath);
  }, [permsReady, darfBearbeiten, router, auftragPath]);

  function zurueckInDenAuftrag() {
    if (vonAuftrag && typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.replace(auftragPath);
    }
  }

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
    const geladen = geladenRef.current;
    if (!geladen) return; // Formular ist erst nach dem Laden sichtbar

    // Nur Felder, die der Nutzer wirklich geaendert hat — kein Feld darf
    // ohne Nutzeraktion seinen Wert aendern (src/lib/auftrag-bearbeiten.ts).
    const payload = bearbeitenPayload(form, geladen);
    if (Object.keys(payload).length === 0) {
      toast.info("Keine Änderungen");
      zurueckInDenAuftrag();
      return;
    }

    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);

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
    // Zurueck in den Auftrag (nicht in die Liste); die Detailseite laedt
    // beim erneuten Anzeigen frisch aus der DB.
    zurueckInDenAuftrag();
  }

  // Skelett auch, solange die Rechte laden bzw. ohne Recht (Weiterleitung laeuft).
  if (loadingJob || !permsReady || !darfBearbeiten) {
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
        <BackButton fallbackHref={auftragPath} size="sm" />
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
          <button
            type="button"
            onClick={zurueckInDenAuftrag}
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
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </form>
    </div>
  );
}
