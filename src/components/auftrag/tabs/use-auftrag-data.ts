"use client";

/**
 * `useAuftragData(id)` — laedt und cached alles was die Detail-Seite braucht:
 * Job + Termine + Dokumente + Profile + Rapporte + Stunden-Audit (admin-only).
 * Bietet zusaetzlich die Notizen- und Verwaltungsaufwand-Felder mit Autosave
 * (Debounce 800ms).
 *
 * Der ausgelagerte Hook haelt page.tsx unter der 400-LOC-Grenze.
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { TOAST } from "@/lib/messages";
import type {
  JobAppointment,
  Profile,
  Document as DocType,
  JobDetailWithRelations,
  ServiceReport,
} from "@/types";

export type ReportWithCreator = ServiceReport & {
  creator: { full_name: string } | null;
};

export type AuditRow = {
  user_id: string;
  user_name: string;
  stempel_minutes: number;
  rapport_minutes: number;
  diff_minutes: number;
};

export function useAuftragData(id: string) {
  const supabase = createClient();

  const [job, setJob] = useState<JobDetailWithRelations | null>(null);
  const [appointments, setAppointments] = useState<JobAppointment[]>([]);
  const [documents, setDocuments] = useState<DocType[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reports, setReports] = useState<ReportWithCreator[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  // Notizen + Verwaltungsaufwand — State + Autosave (Debounce 800ms).
  const [notesText, setNotesText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [verwaltungsText, setVerwaltungsText] = useState("");
  const [savedVerwaltungsText, setSavedVerwaltungsText] = useState("");
  const [verwaltungsMinutes, setVerwaltungsMinutes] = useState<string>("");
  const [savedVerwaltungsMinutes, setSavedVerwaltungsMinutes] = useState<string>("");

  const loadAll = useCallback(async () => {
    const [jobRes, apptRes, docRes, profRes, repRes] = await Promise.all([
      supabase
        .from("jobs")
        .select(
          "*, customer:customers(id, name, address_street, address_zip, address_city, bexio_contact_id), location:locations(id, name, address_street, address_zip, address_city, customer:customers(id, name)), room:rooms(id, name, address_street, address_zip, address_city), project_lead:profiles!project_lead_id(full_name), cancelled_by_profile:profiles!cancelled_by(full_name), customer_contacted_by_profile:profiles!customer_contacted_by(full_name)",
        )
        .eq("id", id)
        .single(),
      supabase
        .from("job_appointments")
        .select("*, assignee:profiles!assigned_to(full_name)")
        .eq("job_id", id)
        .order("start_time"),
      supabase.from("documents").select("*").eq("job_id", id).order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name, role, is_active")
        .eq("is_active", true)
        .neq("role", "partner")
        .order("full_name"),
      supabase
        .from("service_reports")
        .select("*, creator:profiles!created_by(full_name)")
        .eq("job_id", id)
        .order("created_at", { ascending: false }),
    ]);
    if (jobRes.data) {
      setJob(jobRes.data as unknown as JobDetailWithRelations);
      // Notizen: alte JSON-Liste -> joined als Text. Plain-Text bleibt as-is.
      let initial = "";
      if (jobRes.data.notes) {
        try {
          const parsed = JSON.parse(jobRes.data.notes);
          if (Array.isArray(parsed._notes)) {
            initial = parsed._notes.map((n: { content: string }) => n.content).join("\n\n");
          } else {
            initial = jobRes.data.notes;
          }
        } catch {
          initial = jobRes.data.notes;
        }
      }
      setNotesText(initial);
      setSavedText(initial);
      const raw = jobRes.data as {
        verwaltungsaufwand?: string | null;
        verwaltungsaufwand_minutes?: number | null;
      };
      const va = raw.verwaltungsaufwand ?? "";
      setVerwaltungsText(va);
      setSavedVerwaltungsText(va);
      const vm = raw.verwaltungsaufwand_minutes != null ? String(raw.verwaltungsaufwand_minutes) : "";
      setVerwaltungsMinutes(vm);
      setSavedVerwaltungsMinutes(vm);
    }
    if (apptRes.data) setAppointments(apptRes.data as unknown as JobAppointment[]);
    if (docRes.data) setDocuments(docRes.data as DocType[]);
    if (profRes.data) setProfiles(profRes.data as Profile[]);
    if (repRes.data) setReports(repRes.data as unknown as ReportWithCreator[]);

    // Admin-Status + Stundenkontrolle (RPC lehnt Non-Admins mit 403 ab).
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      const admin = profileRow?.role === "admin";
      setIsAdmin(admin);
      if (admin) {
        const { data: auditRows } = await supabase.rpc("get_job_hours_audit", { p_job_id: id });
        setAudit((auditRows as AuditRow[]) ?? []);
      }
    }
  }, [id, supabase]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Realtime: Rapport-Aenderungen (z.B. Signatur in anderem Tab) → Reload.
  useEffect(() => {
    const handler = () => loadAll();
    window.addEventListener("realtime:service_reports", handler);
    return () => window.removeEventListener("realtime:service_reports", handler);
  }, [loadAll]);

  // Notizen autosave.
  // Wichtig: bei Fehler NICHT savedText setzen — sonst denkt der Effect
  // "gespeichert" und der User verliert stumm seine Eingabe (Audit-Finding).
  useEffect(() => {
    if (notesText === savedText) return;
    const handle = setTimeout(async () => {
      const { error } = await supabase.from("jobs").update({ notes: notesText || null }).eq("id", id);
      if (error) {
        TOAST.supabaseError(error, "Notizen konnten nicht gespeichert werden");
        return;
      }
      setSavedText(notesText);
    }, 800);
    return () => clearTimeout(handle);
  }, [notesText, savedText, id, supabase]);

  // Verwaltungsaufwand-Text autosave.
  useEffect(() => {
    if (verwaltungsText === savedVerwaltungsText) return;
    const handle = setTimeout(async () => {
      const { error } = await supabase.from("jobs").update({ verwaltungsaufwand: verwaltungsText || null }).eq("id", id);
      if (error) {
        TOAST.supabaseError(error, "Verwaltungsaufwand konnte nicht gespeichert werden");
        return;
      }
      setSavedVerwaltungsText(verwaltungsText);
    }, 800);
    return () => clearTimeout(handle);
  }, [verwaltungsText, savedVerwaltungsText, id, supabase]);

  // Verwaltungsaufwand-Minuten autosave.
  useEffect(() => {
    if (verwaltungsMinutes === savedVerwaltungsMinutes) return;
    const handle = setTimeout(async () => {
      const trimmed = verwaltungsMinutes.trim();
      const value = trimmed === "" ? null : Math.max(0, parseInt(trimmed, 10) || 0);
      const { error } = await supabase.from("jobs").update({ verwaltungsaufwand_minutes: value }).eq("id", id);
      if (error) {
        TOAST.supabaseError(error, "Aufwand-Minuten konnten nicht gespeichert werden");
        return;
      }
      setSavedVerwaltungsMinutes(verwaltungsMinutes);
    }, 800);
    return () => clearTimeout(handle);
  }, [verwaltungsMinutes, savedVerwaltungsMinutes, id, supabase]);

  return {
    job,
    appointments,
    documents,
    profiles,
    reports,
    isAdmin,
    audit,
    setDocuments,
    notesText,
    setNotesText,
    verwaltungsText,
    setVerwaltungsText,
    verwaltungsMinutes,
    setVerwaltungsMinutes,
    loadAll,
  };
}
