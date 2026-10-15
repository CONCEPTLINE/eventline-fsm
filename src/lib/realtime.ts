"use client";

/**
 * Live-Aktualisierung aus der Datenbank (Supabase Realtime, postgres_changes)
 * — der EINE Weg, eine Tabelle zu abonnieren.
 *
 * Je Tabelle ein eigener Kanal: Der Server richtet die postgres_changes-Abos
 * eines Kanals gemeinsam ein. Fehlt EINE Tabelle in der Publication
 * supabase_realtime, lehnt er alle Abos dieses Kanals ab — der Beitritt meldet
 * trotzdem SUBSCRIBED, die Ablehnung kommt nur als system-Nachricht. So lag
 * der fruehere Sammelkanal «global-invalidate» seit Juni 2026 still (eine
 * fehlende Tabelle, keine Aenderung mehr fuer Auftraege, Kunden, Glocke …).
 * Getrennte Kanaele beschraenken einen Fehler auf seine Tabelle. Alle Kanaele
 * teilen sich die eine WebSocket-Verbindung des Browser-Clients.
 *
 * Neue Tabelle abonnieren: erst per Migration in die Publication aufnehmen
 * (Muster 316/317/337), sonst meldet die Konsole «[realtime] <tabelle>:
 * ABGELEHNT».
 *
 * Gesundheit (`beiStatus`): `true` erst, wenn der Server das Abo bestaetigt
 * («Subscribed to PostgreSQL»), `false` bei Ablehnung, Fehler, Zeitueber-
 * schreitung oder Schliessen — je Wechsel einmal, mit console.warn und
 * Tabellenname.
 *
 * Wiederverbindung: Nach Netz- und Verbindungsfehlern tritt realtime-js selbst
 * wieder bei (mit dem aktuellen Login-Token). Schliesst der SERVER den Kanal
 * (z. B. abgelaufenes Token nach langer Hintergrundzeit), baut dieser Helfer
 * ihn mit wachsender Wartezeit neu auf.
 *
 * Das Login-Token VOR dem Beitritt stellt der Browser-Client sicher
 * (src/lib/supabase/client.ts, gilt fuer jeden Kanal).
 */

import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from "@supabase/supabase-js";

export type TabellenAenderung = RealtimePostgresChangesPayload<Record<string, unknown>>;

export interface TabellenAbo {
  /** Tabelle im Schema public — muss in der Publication supabase_realtime stehen. */
  tabelle: string;
  /** Welche Aenderungen (Standard: alle). */
  ereignis?: "*" | "INSERT" | "UPDATE" | "DELETE";
  /** Server-Filter, z. B. `user_id=eq.<uuid>` — nur passende Zeilen kommen an. */
  filter?: string;
  /** Je Aenderung (die RLS liefert nur Zeilen, die die Sitzung sehen darf). */
  beiAenderung: (aenderung: TabellenAenderung) => void;
  /** Gesundheit des Abos, je Wechsel einmal (siehe oben). */
  beiStatus?: (ok: boolean, status: string) => void;
}

/** Wartezeiten fuer den Neuaufbau nach einem Schliessen durch den Server. */
const NEUAUFBAU_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

type SystemNachricht = { extension?: string; status?: string; message?: string };

/** Abonniert eine Tabelle in einem eigenen Kanal. Rueckgabe: Abmelden. */
export function tabelleAbonnieren(supabase: SupabaseClient, abo: TabellenAbo): () => void {
  let kanal: RealtimeChannel | null = null;
  let beendet = false;
  let versuche = 0;
  let neuTimer: ReturnType<typeof setTimeout> | null = null;
  let gemeldet: boolean | null = null;

  const melden = (ok: boolean, status: string, detail?: unknown) => {
    if (gemeldet === ok) return;
    gemeldet = ok;
    if (!ok) console.warn(`[realtime] ${abo.tabelle}: ${status}`, detail ?? "");
    abo.beiStatus?.(ok, status);
  };

  const neuPlanen = () => {
    if (beendet || neuTimer) return;
    const warten = NEUAUFBAU_MS[Math.min(versuche, NEUAUFBAU_MS.length - 1)];
    versuche++;
    neuTimer = setTimeout(aufbauen, warten);
  };

  function aufbauen() {
    neuTimer = null;
    if (beendet) return;
    // Topic je Aufbau eindeutig: removeChannel ist async, ein gleichnamiger
    // Kanal waere beim schnellen Neuaufbau noch «am Gehen».
    const ch = supabase.channel(`tabelle:${abo.tabelle}:${Math.random().toString(36).slice(2, 10)}`);
    kanal = ch;
    ch.on(
      "postgres_changes",
      {
        event: abo.ereignis ?? "*",
        schema: "public",
        table: abo.tabelle,
        ...(abo.filter ? { filter: abo.filter } : {}),
      },
      (aenderung: TabellenAenderung) => {
        if (!beendet) abo.beiAenderung(aenderung);
      },
    )
      .on("system", {}, (nachricht: SystemNachricht) => {
        if (beendet || ch !== kanal || nachricht?.extension !== "postgres_changes") return;
        if (nachricht.status === "ok") {
          versuche = 0;
          melden(true, "SUBSCRIBED");
        } else {
          // Der Server versucht es selbst weiter und meldet Erfolg wieder als «ok».
          melden(false, "ABGELEHNT", nachricht.message);
        }
      })
      .subscribe((status, err) => {
        // SUBSCRIBED heisst nur «Kanal beigetreten» — gesund erst mit der
        // Bestaetigung des Servers (system-Nachricht oben).
        if (beendet || ch !== kanal || status === "SUBSCRIBED") return;
        melden(false, status, err);
        // CHANNEL_ERROR/TIMED_OUT: realtime-js tritt selbst wieder bei.
        // CLOSED ohne eigenes Abmelden: der Server hat geschlossen → neu.
        if (status === "CLOSED") neuPlanen();
      });
  }

  aufbauen();

  return () => {
    beendet = true;
    if (neuTimer) clearTimeout(neuTimer);
    neuTimer = null;
    if (kanal) void supabase.removeChannel(kanal);
    kanal = null;
  };
}
