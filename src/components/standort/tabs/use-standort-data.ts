"use client";

/**
 * `useStandortData(id)` — laedt und cached alles was die Standort-Detail-Seite
 * braucht: Standort + Kontaktpersonen + Wartungs-Tasks (inkl. job-Join und
 * signed Photo-URLs) + Dokumente-Liste + Notizen-Blocks + Kunden-Verknuepfung.
 *
 * Der ausgelagerte Hook haelt page.tsx unter der 100-LOC-Grenze und bietet
 * eine einzige `loadAll()`-Funktion sowie die kompletten CRUD-Aktionen
 * (createContact/deleteContact/createTask/deleteTask/uploadDoc/deleteDoc/
 * addNote/deleteNote/linkCustomer/unlinkCustomer) fuer die Tab-Komponenten.
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { deleteRow } from "@/lib/db-mutations";
import { validateFileSize } from "@/lib/file-upload";
import type { Location, LocationContact, Customer } from "@/types";

// Notizen — freier Textblock oder Link, mit Erstell-Datum. Gespeichert
// im locations.notes-Feld als JSON-Array. Pattern uebernommen vom alten
// FSM, dort hat sich bewaehrt: Codes, Dropbox-Links, Calendar-Embeds.
// `pinned` = auf dem Uebersichts-Tab prominent angezeigt (Tuerschluessel-
// Code, WLAN-Passwort, Besonderheiten die alle sofort sehen sollen).
export type Note = { id: string; content: string; created_at: string; pinned?: boolean };

export type DocEntry = { name: string; path: string; uploaded_at: string };

export function useStandortData(id: string) {
  const supabase = createClient();

  const [location, setLocation] = useState<Location | null>(null);
  const [contacts, setContacts] = useState<LocationContact[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [linkedCustomer, setLinkedCustomer] = useState<Customer | null>(null);
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const [locRes, contRes, custRes] = await Promise.all([
      supabase.from("locations").select("*").eq("id", id).single(),
      supabase.from("location_contacts").select("*").eq("location_id", id).order("name"),
      supabase.from("customers").select("*").eq("is_active", true).order("name"),
    ]);

    if (locRes.data) {
      setLocation(locRes.data as Location);
      // linkedCustomer IMMER setzen — auch auf null wenn customer_id entfernt
      // wurde. Sonst bleibt der vorherige State stehen und User muss manuell
      // refreshen damit die Aenderung sichtbar wird.
      if (locRes.data.customer_id && custRes.data) {
        setLinkedCustomer(
          (custRes.data as Customer[]).find((c) => c.id === locRes.data.customer_id) || null,
        );
      } else {
        setLinkedCustomer(null);
      }
    }
    if (contRes.data) setContacts(contRes.data as LocationContact[]);
    if (custRes.data) setCustomers(custRes.data as Customer[]);

    // Dokumente aus technical_details laden (JSON-Array).
    if (locRes.data?.technical_details) {
      try {
        const parsed = JSON.parse(locRes.data.technical_details);
        if (Array.isArray(parsed)) setDocs(parsed as DocEntry[]);
        else setDocs([]);
      } catch {
        setDocs([]);
      }
    } else {
      setDocs([]);
    }

    // Notizen — JSON-Array im notes-Feld. Bei Legacy-Daten (raw text statt
    // JSON) konvertieren wir den Text in einen einzelnen Block.
    if (locRes.data?.notes) {
      try {
        const parsed = JSON.parse(locRes.data.notes);
        if (Array.isArray(parsed)) setNotes(parsed as Note[]);
        else setNotes([]);
      } catch {
        const raw = String(locRes.data.notes).trim();
        if (raw) {
          setNotes([{ id: crypto.randomUUID(), content: raw, created_at: new Date().toISOString() }]);
        } else {
          setNotes([]);
        }
      }
    } else {
      setNotes([]);
    }
    setLoading(false);
  }, [id, supabase]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ─── Notizen ─────────────────────────────────────────────────────
  const saveNotes = useCallback(
    async (next: Note[]) => {
      setNotes(next);
      const { error } = await supabase
        .from("locations")
        .update({ notes: JSON.stringify(next) })
        .eq("id", id);
      if (error) {
        TOAST.supabaseError(error, "Notiz konnte nicht gespeichert werden");
        // Bei Fehler revert via reload
        loadAll();
      }
    },
    [id, supabase, loadAll],
  );

  const addNote = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return false;
      const newNote: Note = {
        id: crypto.randomUUID(),
        content: trimmed,
        created_at: new Date().toISOString(),
      };
      await saveNotes([...notes, newNote]);
      return true;
    },
    [notes, saveNotes],
  );

  const deleteNote = useCallback(
    async (noteId: string) => {
      await saveNotes(notes.filter((n) => n.id !== noteId));
    },
    [notes, saveNotes],
  );

  /** Pin-Zustand einer Notiz togglen. Gepinnte Notizen erscheinen auf dem
   *  Uebersichts-Tab prominent (Turschluessel-Code, WLAN, Besonderheiten). */
  const togglePinNote = useCallback(
    async (noteId: string) => {
      await saveNotes(notes.map((n) => n.id === noteId ? { ...n, pinned: !n.pinned } : n));
    },
    [notes, saveNotes],
  );

  /** Notiz inhaltlich aendern (In-Place-Edit im UI). */
  const updateNote = useCallback(
    async (noteId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      await saveNotes(notes.map((n) => n.id === noteId ? { ...n, content: trimmed } : n));
    },
    [notes, saveNotes],
  );

  // ─── Dokumente ───────────────────────────────────────────────────
  // Speichert die Dokumenten-Liste in locations.technical_details (JSON-Array).
  const saveDocsList = useCallback(
    async (newDocs: DocEntry[]): Promise<boolean> => {
      const res = await fetch(`/api/locations/${id}/docs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docs: newDocs }),
      });
      if (!res.ok) {
        let msg: string | undefined;
        try {
          msg = (await res.json())?.error;
        } catch {
          /* keine strukturierte Antwort */
        }
        TOAST.errorOr(msg, "Dokumente konnten nicht gespeichert werden");
        return false;
      }
      return true;
    },
    [id],
  );

  const uploadDoc = useCallback(
    async (file: File): Promise<boolean> => {
      if (!validateFileSize(file)) return false;
      const path = `standorte/${id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error } = await supabase.storage
        .from("documents")
        .upload(path, file, { contentType: file.type });
      if (error) {
        TOAST.supabaseError(error, "Upload fehlgeschlagen");
        return false;
      }
      const newDocs = [...docs, { name: file.name, path, uploaded_at: new Date().toISOString() }];
      const saved = await saveDocsList(newDocs);
      if (saved) {
        setDocs(newDocs);
        toast.success("Dokument hochgeladen");
        return true;
      }
      // Metadaten konnten nicht persistiert werden — Datei im Storage aufraeumen.
      await supabase.storage.from("documents").remove([path]);
      return false;
    },
    [id, supabase, docs, saveDocsList],
  );

  const deleteDoc = useCallback(
    async (doc: { name: string; path: string }) => {
      const { error: storageErr } = await supabase.storage.from("documents").remove([doc.path]);
      if (storageErr) {
        TOAST.supabaseError(storageErr, "Dokument konnte nicht gelöscht werden");
        return;
      }
      const newDocs = docs.filter((d) => d.path !== doc.path);
      const saved = await saveDocsList(newDocs);
      if (saved) {
        setDocs(newDocs);
        toast.success("Dokument gelöscht");
      }
    },
    [docs, supabase, saveDocsList],
  );

  // Bucket 'documents' ist private — getPublicUrl() liefert 404, deshalb
  // signed URL holen (1h Guelt.).
  const getDocSignedUrl = useCallback(
    async (path: string): Promise<string | null> => {
      const { data, error } = await supabase.storage
        .from("documents")
        .createSignedUrl(path, 3600);
      if (error || !data?.signedUrl) {
        toast.error("Datei nicht verfügbar");
        return null;
      }
      return data.signedUrl;
    },
    [supabase],
  );

  // ─── Kontaktpersonen ─────────────────────────────────────────────
  const createContact = useCallback(
    async (input: { name: string; role?: string; email?: string; phone?: string }) => {
      const { error } = await supabase.from("location_contacts").insert({
        location_id: id,
        name: input.name,
        role: input.role || null,
        email: input.email || null,
        phone: input.phone || null,
      });
      if (error) {
        TOAST.supabaseError(error, "Kontakt konnte nicht hinzugefügt werden");
        return false;
      }
      await loadAll();
      toast.success("Kontaktperson hinzugefügt");
      return true;
    },
    [id, supabase, loadAll],
  );

  const deleteContact = useCallback(
    async (contactId: string) => {
      const res = await deleteRow("location_contacts", contactId);
      if (!res.ok) {
        TOAST.deleteError(res.error);
        return;
      }
      await loadAll();
    },
    [loadAll],
  );

  // ─── Kunden-Verknuepfung ─────────────────────────────────────────
  const linkCustomer = useCallback(
    async (customerId: string | null) => {
      const { error } = await supabase
        .from("locations")
        .update({ customer_id: customerId || null })
        .eq("id", id);
      if (error) {
        TOAST.supabaseError(error, "Kundenverknüpfung fehlgeschlagen");
        return;
      }
      toast.success(customerId ? "Kunde verknüpft" : "Kundenverknüpfung entfernt");
      await loadAll();
    },
    [id, supabase, loadAll],
  );

  return {
    // Data
    location,
    contacts,
    docs,
    notes,
    customers,
    linkedCustomer,
    loading,
    // Actions
    loadAll,
    addNote,
    deleteNote,
    togglePinNote,
    updateNote,
    uploadDoc,
    deleteDoc,
    getDocSignedUrl,
    createContact,
    deleteContact,
    linkCustomer,
  };
}
