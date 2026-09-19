"use client";

/**
 * Auftrag-Detail: Tab "Uebersicht".
 *
 * Enthaelt Kopf-Info (Kunde / Standort / Datum / Kontakt / Beschreibung),
 * Notizen (Autosave) und die Termine (AppointmentsSection) — Notizen und
 * Termine nebeneinander, damit die Seite ohne Scrollen auskommt.
 *
 * State fuer Notizen lebt bewusst im Parent — beim Tab-Wechsel wird die
 * OverviewTab unmounted; die Feldwerte muessen aber ueber den Tab-Wechsel
 * hinweg erhalten bleiben.
 */

import { MapPin, User, Calendar, UserCheck, StickyNote, Phone, Mail } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BexioButton } from "@/components/bexio-button";
import { AppointmentsSection } from "@/components/auftrag/appointments-section";
import type { JobAppointment, Profile, JobDetailWithRelations, JobStatus } from "@/types";

type Props = {
  jobId: string;
  job: JobDetailWithRelations;
  appointments: JobAppointment[];
  profiles: Profile[];
  autoOpenAppt: boolean;
  onReload: () => void;
  notesText: string;
  setNotesText: (v: string) => void;
};

export function OverviewTab({
  jobId,
  job,
  appointments,
  profiles,
  autoOpenAppt,
  onReload,
  notesText,
  setNotesText,
}: Props) {
  const customer = job.customer ?? job.location?.customer ?? undefined;
  const location = job.location ?? undefined;
  const room = job.room ?? undefined;
  const roomAddress = room
    ? [room.address_street, `${room.address_zip || ""} ${room.address_city || ""}`.trim()].filter(Boolean).join(", ")
    : "";
  const locationAddress = location
    ? [location.address_street, `${location.address_zip || ""} ${location.address_city || ""}`.trim()]
        .filter(Boolean)
        .join(", ")
    : "";
  const customerAddress = job.customer
    ? [job.customer.address_street, `${job.customer.address_zip || ""} ${job.customer.address_city || ""}`.trim()]
        .filter(Boolean)
        .join(", ")
    : "";
  const mapsAddress = locationAddress || roomAddress || job.external_address || customerAddress;
  const mapsQuery = mapsAddress || location?.name || room?.name || customer?.name || "";
  const mapsUrl = mapsQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}` : "";
  const projectLead = job.project_lead;

  // Info-Card (Audit Thema 5, Regel 5): 2-spaltiges Layout.
  //   Links  = WER   (Kunde + Kundenadresse + Veranstalter-Kontakt)
  //   Rechts = WO+WANN (Standort/Raum/Adresse + Event-Datum + EIN
  //                     Maps-Button; MapPin nur EINMAL rendern).
  // Vorher hatten wir bis zu fuenf MapPin-Icons pro Karte (Kundenadresse,
  // Standort, Standort-Adresse, Raum, Raum-Adresse, externe Adresse).
  const placeName = location?.name ?? room?.name ?? job.external_address ?? null;
  const placeLabel = location ? "Standort" : room ? "Raum" : "Ort";
  const placeAddress = locationAddress || roomAddress || (location || room ? "" : job.external_address ?? "");

  return (
    <div className="space-y-3">
      {/* Info */}
      <Card className="bg-card">
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            {/* Spalte WER — Kunde + Adresse + Veranstalter-Kontakt */}
            <div className="space-y-1.5 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Wer
              </p>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium">Kunde:</span>
                    <span className="truncate">{customer?.name ?? "—"}</span>
                  </div>
                  {customerAddress && (
                    <div className="text-xs text-muted-foreground pl-6 truncate">
                      {customerAddress}
                    </div>
                  )}
                </div>
                {job.customer?.id && (
                  <div className="shrink-0">
                    <BexioButton
                      customerId={job.customer.id}
                      bexioContactId={job.customer.bexio_contact_id ?? null}
                      onLinked={onReload}
                    />
                  </div>
                )}
              </div>
              {projectLead && (
                <div className="flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium">Projektleiter:</span>
                  <span className="truncate">{projectLead.full_name}</span>
                </div>
              )}
              {(job.contact_person || job.contact_phone || job.contact_email) && (
                <div className="pt-2 mt-1 border-t space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Veranstalter-Kontakt
                  </p>
                  {job.contact_person && (
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{job.contact_person}</span>
                    </div>
                  )}
                  {job.contact_phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                      <a
                        href={`tel:${job.contact_phone.replace(/\s+/g, "")}`}
                        className="hover:underline tabular-nums truncate"
                      >
                        {job.contact_phone}
                      </a>
                    </div>
                  )}
                  {job.contact_email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <a href={`mailto:${job.contact_email}`} className="hover:underline truncate">
                        {job.contact_email}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Spalte WO+WANN — Ort + Datum + EIN Maps-Button.
                MapPin wird hier genau einmal gerendert (fuer die Ort-Zeile),
                der Maps-Button traegt das Icon in sich. */}
            <div className="space-y-1.5 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Wo &amp; Wann
              </p>
              {placeName ? (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium">{placeLabel}:</span>
                      <span className="truncate">{placeName}</span>
                    </div>
                    {placeAddress && (
                      <div className="text-xs text-muted-foreground pl-6 truncate">
                        {placeAddress}
                      </div>
                    )}
                  </div>
                  {mapsUrl && (
                    <a
                      href={mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="kasten kasten-blue shrink-0"
                      data-tooltip="In Google Maps öffnen"
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      Maps
                    </a>
                  )}
                </div>
              ) : (
                <div className="text-muted-foreground italic">Kein Standort hinterlegt</div>
              )}
              {job.start_date && (
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium">Event-Datum:</span>
                  <span className="tabular-nums">
                    {new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                    {job.end_date && job.end_date !== job.start_date
                      ? ` – ${new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}`
                      : ""}
                  </span>
                </div>
              )}
            </div>
          </div>
          {job.description && (
            <div className="pt-3 mt-3 border-t">
              <p className="text-sm whitespace-pre-wrap">{job.description}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notizen + Termine nebeneinander (breit) — spart eine ganze
          Card-Hoehe, damit die Uebersicht ohne Scrollen auskommt.
          items-start: Karten sizen nach Inhalt, kein Zwang-Strecken. */}
      {/* TODO(audit-umsetzung, 2026-09-05): "Aus Vertrieb"-Section einbauen,
          sobald jobs -> lead-Bezug in der DB existiert. Aktuell ist der
          Bezug NUR umgekehrt gespeichert: vertrieb_contacts.notizen._details
          .job_id zeigt auf den erstellten Auftrag; jobs hat weder lead_id
          noch source_lead_id und jobs.notes ist text (kein jsonb) — also
          keine belastbare Rueckwaerts-Auflaufung ohne Full-Table-Scan.
          Naechster Schritt: Migration `alter table public.jobs add column
          lead_id uuid references public.vertrieb_contacts(id) on delete
          set null` + Setter in lead-editor.tsx, dann hier die collapsed
          Section rendern (Kunden-Name, letzte 3 Notizen, Link
          "/vertrieb?lead={id}"). Tracker: Audit Thema 2 / Bruecke 4. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        {/* Notizen — autosave via Parent-Effekt (Debounce 800ms) */}
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <StickyNote className="h-3.5 w-3.5" />
              Notizen
            </CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              placeholder="Reinschreiben — wird automatisch gespeichert."
              rows={3}
              style={{ fieldSizing: "content" } as React.CSSProperties}
              className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />
          </CardContent>
        </Card>

        <AppointmentsSection
          jobId={jobId}
          jobTitle={job?.title ?? null}
          jobStatus={job.status as JobStatus}
          jobStartDate={job.start_date ?? null}
          appointments={appointments}
          profiles={profiles}
          defaultOpen={autoOpenAppt}
        />
      </div>
    </div>
  );
}
