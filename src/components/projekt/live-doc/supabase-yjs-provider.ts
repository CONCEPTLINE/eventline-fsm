"use client";

/**
 * SupabaseYjsProvider — synchronisiert ein Yjs-Dokument (Live-Dokument)
 * zwischen allen offenen Browsern ueber Supabase Realtime BROADCAST.
 *
 * Ablauf:
 *  - Jede lokale Aenderung (Y.Doc "update") wird als base64 an den Kanal
 *    `livedoc:<docId>` gesendet; Empfaenger wenden sie mit origin "remote"
 *    an (verhindert Echo-Schleifen).
 *  - Beim Beitritt sendet der Client "syncreq"; wer schon drin ist,
 *    antwortet mit seinem KOMPLETTEN Zustand ("syncstate"). Yjs merged
 *    idempotent — doppelte Antworten sind harmlos.
 *  - Cursor/Namen laufen als Awareness-Updates (y-protocols) ueber
 *    denselben Kanal. Beim Verlassen wird der eigene Awareness-State
 *    entfernt, sonst bleiben Geister-Cursor stehen.
 *
 * Persistenz (DB-Snapshot) macht bewusst NICHT der Provider, sondern der
 * Editor (word-editor.tsx) — der kennt HTML-Snapshot + updated_by.
 */

import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RealtimeChannel } from "@supabase/supabase-js";

function toBase64(u8: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export class SupabaseYjsProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private channel: RealtimeChannel;
  private connected = false;
  private destroyed = false;

  /** Wird nach dem ersten erfolgreichen Subscribe true — UI kann darauf warten. */
  onStatus?: (connected: boolean) => void;
  /** Titel-Aenderungen anderer Clients (Titel lebt in der DB, nicht im Y.Doc). */
  onRemoteTitle?: (title: string) => void;

  constructor(supabase: SupabaseClient, docId: string, doc: Y.Doc) {
    this.doc = doc;
    this.awareness = new Awareness(doc);

    this.channel = supabase.channel(`livedoc:${docId}`, {
      config: { broadcast: { self: false } },
    });

    this.channel
      .on("broadcast", { event: "yupdate" }, ({ payload }) => {
        if (payload?.u) Y.applyUpdate(this.doc, fromBase64(payload.u), "remote");
      })
      .on("broadcast", { event: "syncstate" }, ({ payload }) => {
        if (payload?.u) Y.applyUpdate(this.doc, fromBase64(payload.u), "remote");
      })
      .on("broadcast", { event: "syncreq" }, () => {
        // Neuling versorgen: kompletter Zustand + eigener Cursor.
        this.send("syncstate", { u: toBase64(Y.encodeStateAsUpdate(this.doc)) });
        this.broadcastAwareness([this.doc.clientID]);
      })
      .on("broadcast", { event: "awareness" }, ({ payload }) => {
        if (payload?.u) applyAwarenessUpdate(this.awareness, fromBase64(payload.u), "remote");
      })
      .on("broadcast", { event: "title" }, ({ payload }) => {
        if (typeof payload?.title === "string") this.onRemoteTitle?.(payload.title);
      })
      .subscribe((status) => {
        const ok = status === "SUBSCRIBED";
        if (ok && !this.connected) {
          this.connected = true;
          this.onStatus?.(true);
          // Zustand der anderen anfordern + sich selbst zeigen.
          this.send("syncreq", {});
          this.broadcastAwareness([this.doc.clientID]);
        } else if (!ok && status !== "CLOSED") {
          // TIMED_OUT / CHANNEL_ERROR — Supabase reconnected selbst;
          // UI nur informieren.
          this.onStatus?.(false);
        }
      });

    this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || this.destroyed) return;
    this.send("yupdate", { u: toBase64(update) });
  };

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote" || this.destroyed) return;
    this.broadcastAwareness([...added, ...updated, ...removed]);
  };

  private broadcastAwareness(clients: number[]) {
    if (!clients.length) return;
    this.send("awareness", { u: toBase64(encodeAwarenessUpdate(this.awareness, clients)) });
  }

  /** Titel an andere offene Clients melden (DB-Update macht der Aufrufer). */
  sendTitle(title: string) {
    this.send("title", { title });
  }

  private send(event: string, payload: Record<string, unknown>) {
    if (this.destroyed) return;
    this.channel.send({ type: "broadcast", event, payload }).catch(() => {
      /* Verbindungsluecke — Yjs merged beim naechsten Sync ohnehin. */
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Eigenen Cursor bei den anderen entfernen, DANN Kanal schliessen.
    removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.broadcastAwarenessFinal();
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.channel.unsubscribe();
  }

  private broadcastAwarenessFinal() {
    // destroyed ist schon true — send() wuerde verweigern, deshalb direkt.
    try {
      this.channel.send({
        type: "broadcast",
        event: "awareness",
        payload: { u: toBase64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])) },
      });
    } catch {
      /* Kanal evtl. schon zu */
    }
  }
}
