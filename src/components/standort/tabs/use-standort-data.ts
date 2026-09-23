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
import { deleteRow, updateRow } from "@/lib/db-mutations";
import { validateFileSize } from "@/lib/file-upload";
import type { Location, LocationContact, Customer } from "@/types";

// Notizen — freier Textblock oder Link, mit Erstell-Datum. Gespeichert
// im locations.notes-Feld als JSON-Array. Pattern uebernommen vom alten
// FSM, dort hat sich bewaehrt: Codes, Dropbox-Links, Calendar-Embeds.
// `pinned` = auf dem Uebersichts-Tab prominent angezeigt (Tuerschluessel-
// Code, WLAN-Passwort, Besonderheiten die alle sofort sehen sollen).
export type Note = { id: string; content: string; created_at: string; pinned?: boolean };

// Dokumente leben in der zentralen documents-Tabelle (location_id-Zweig,
// Migration 260) — ein Datenmodell fuer alle Dokumente der App.
// `folder` — optionale Ordner-Zuordnung (eine Ebene, frei benannt).
// Fehlend/null = Hauptordner. Kein eigenes Ordner-Objekt: ein Ordner
// existiert, solange Dokumente ihn tragen (siehe ui/doc-folders.tsx).
// path = documents.storage_path, uploaded_at = documents.created_at —
// die Feldnamen bleiben fuer die Aufrufer (notes-docs-tab) stabil.
export type DocEntry = {
  id: string;
  name: string;
  path: string;
  uploaded_at: string;
  folder?: string | null;
};

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
    const [locRes, contRes, custRes, docRes] = await Promise.all([
      supabase.from("locations").select("*").eq("id", id).single(),
      supabase.from("location_contacts").select("*").eq("location_id", id).order("name"),
      supabase.from("customers").select("*").eq("is_active", true).order("name"),
      supabase
        .from("documents")
        .select("id, name, storage_path, created_at, folder")
        .eq("location_id", id)
        .order("created_at", { ascending: false }),
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

    // Dokumente aus der documents-Tabelle (created_at desc = neueste zuerst).
    if (docRes.error) {
      TOAST.supabaseError(docRes.error, "Dokumente konnten nicht geladen werden");
      setDocs([]);
    } else {
      setDocs(
        (docRes.data ?? []).map((d) => ({
          id: d.id as string,
          name: d.name as string,
          path: d.storage_path as string,
          uploaded_at: d.created_at as string,
          folder: (d.folder as string | null) ?? null,
        })),
      );
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
  // Zentrale documents-Tabelle (location_id-Zweig) — gleiches Muster wie
  // der Auftrags-Docs-Tab (src/components/auftrag/tabs/docs-history-tab.tsx).
  const uploadDoc = useCallback(
    async (file: File, folder: string | null = null): Promise<boolean> => {
      if (!validateFileSize(file)) return false;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error("Nicht angemeldet");
        return false;
      }
      // Pfad-Schema unveraendert: standorte/<id>/<ts>_<safeName> im Bucket 'documents'.
      const path = `standorte/${id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error } = await supabase.storage
        .from("documents")
        .upload(path, file, { contentType: file.type });
      if (error) {
        TOAST.supabaseError(error, "Upload fehlgeschlagen");
        return false;
      }
      const { data: inserted, error: insErr } = await supabase
        .from("documents")
        .insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type,
          location_id: id,
          uploaded_by: user.id,
          folder,
        })
        .select("id, name, storage_path, created_at, folder")
        .single();
      if (insErr || !inserted) {
        TOAST.supabaseError(insErr, "Dokument konnte nicht gespeichert werden");
        // Metadaten konnten nicht persistiert werden — Datei im Storage aufraeumen.
        await supabase.storage.from("documents").remove([path]);
        return false;
      }
      // Liste ist created_at-desc sortiert → neues Doc vorne anfuegen.
      setDocs((prev) => [
        {
          id: inserted.id,
          name: inserted.name,
          path: inserted.storage_path,
          uploaded_at: inserted.created_at,
          folder: inserted.folder ?? null,
        },
        ...prev,
      ]);
      toast.success("Dokument hochgeladen");
      return true;
    },
    [id, supabase],
  );

  const deleteDoc = useCallback(
    async (doc: DocEntry) => {
      // Reihenfolge wie im Auftrags-Docs-Tab: erst Storage, dann DB-Row.
      await supabase.storage.from("documents").remove([doc.path]);
      const result = await deleteRow("documents", doc.id);
      if (!result.ok) {
        TOAST.deleteError(result.error);
        return;
      }
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
      toast.success("Dokument gelöscht");
    },
    [supabase],
  );

  /** Dokument in einen Ordner verschieben (null = Hauptordner). */
  const moveDoc = useCallback(
    async (doc: DocEntry, folder: string | null) => {
      const result = await updateRow("documents", doc.id, { folder });
      if (!result.ok) {
        toast.error("Verschieben fehlgeschlagen: " + (result.error ?? "Unbekannter Fehler"));
        return;
      }
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, folder } : d)));
      toast.success(folder ? `In «${folder}» verschoben` : "In den Hauptordner verschoben");
    },
    [],
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
    moveDoc,
    getDocSignedUrl,
    createContact,
    deleteContact,
    linkCustomer,
  };
}
