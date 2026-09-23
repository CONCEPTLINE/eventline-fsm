"use client";

// Wiederverwendbarer Bexio-Button + Match-Modal + Pflichtfeld-Modal.
// Verwendung auf Kunden-Detail- UND Auftrag-Detail-Seite.
//
// Drei Zustaende:
// 1. Kein bexio_contact_id -> "In Bexio anlegen" (gruen). Klick:
//    a) Pflichtfelder fehlen -> Modal mit Liste, Link zur Kunden-Bearbeiten-Seite
//    b) Match in Bexio gefunden -> Modal "Verknuepfen oder trotzdem neu anlegen?"
//    c) Sonst -> direkt anlegen via API, ID speichern, Tab oeffnen
// 2. bexio_contact_id schon gesetzt -> "In Bexio oeffnen" (gruen). Klick oeffnet
//    direkt den existierenden Bexio-Tab.
// 3. Bexio nicht verbunden -> Button verborgen.

import { useEffect, useState } from "react";
import { ExternalLink, Link2, AlertCircle, Pencil } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Modal } from "@/components/ui/modal";
import { usePermissions } from "@/lib/use-permissions";
import { logError } from "@/lib/log";

interface MatchCandidate {
  id: number;
  /** Menschenlesbare Bexio-Kundennummer (z.B. "21001"). Wird angezeigt im Match-Modal
   *  und an /link weitergereicht damit wir keinen extra GET-Call brauchen. */
  nr: string | null;
  name: string;
  email: string | null;
  city: string | null;
  postcode: string | null;
  url: string;
}

interface Props {
  customerId: string;
  /** Aktuelle Bexio-ID am Customer — falls schon verknuepft. */
  bexioContactId: string | null;
  /** Gerufen nach erfolgreichem Anlegen oder Verknuepfen — Parent kann
   *  Customer neu laden um die ID frisch anzuzeigen. Optional. */
  onLinked?: (newId: string) => void;
}

export function BexioButton({ customerId, bexioContactId, onLinked }: Props) {
  const { can, ready: permsReady } = usePermissions();
  const [bexioConnected, setBexioConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<MatchCandidate[] | null>(null);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [linkedId, setLinkedId] = useState<string | null>(bexioContactId);

  useEffect(() => {
    setLinkedId(bexioContactId);
  }, [bexioContactId]);

  useEffect(() => {
    fetch("/api/bexio/status")
      .then((r) => r.json())
      .then((d) => setBexioConnected(!!d.connected))
      .catch((err) => {
        // Status-Endpoint gab keinen Response — Button bleibt versteckt.
        // Fehler in Server-Logs damit wir merken wenn Bexio dauerhaft aus ist.
        logError("bexio-button.status", err);
        setBexioConnected(false);
      });
  }, []);

  if (bexioConnected !== true) return null;
  // Permission-Check: ohne bexio:use bleibt der Button verborgen.
  // permsReady=false ist der initiale Lade-Zustand — wir rendern nichts
  // bis die Permissions klar sind, damit der Button nicht kurz aufflackert.
  if (!permsReady || !can("bexio:use")) return null;

  // Zustand 2: schon verknuepft -> Tab oeffnen
  if (linkedId) {
    return (
      <a
        href={`https://office.bexio.com/index.php/kontakt/show/id/${linkedId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="kasten kasten-bexio shrink-0"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        In Bexio öffnen
      </a>
    );
  }

  // Klick "In Bexio anlegen". Server prueft Pflichtfelder, dann Match-Suche,
  // dann Anlegen.
  async function attemptCreate(force: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/bexio/contacts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, force }),
      });
      const json = await res.json();

      if (json.missingFields?.length) {
        setMissingFields(json.missingFields);
        return;
      }
      if (json.needsLinkConfirmation && json.matches?.length) {
        setMatches(json.matches);
        return;
      }
      if (!json.success) {
        TOAST.errorOr(json.error);
        return;
      }
      if (json.alreadyLinked) {
        setLinkedId(json.bexioContactId);
        onLinked?.(json.bexioContactId);
        window.open(json.bexioContactUrl, "_blank", "noopener,noreferrer");
        return;
      }
      // Erfolgreich angelegt
      setLinkedId(json.bexioContactId);
      onLinked?.(json.bexioContactId);
      toast.success("In Bexio angelegt");
      window.open(json.bexioContactUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Netzwerkfehler";
      TOAST.errorOr(msg);
    } finally {
      setBusy(false);
    }
  }

  async function linkExisting(bexioId: number, bexioNr: string | null) {
    setBusy(true);
    try {
      const res = await fetch("/api/bexio/contacts/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, bexioContactId: bexioId, bexioNr }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error);
        return;
      }
      const idStr = String(bexioId);
      setLinkedId(idStr);
      onLinked?.(idStr);
      setMatches(null);
      toast.success("Mit Bexio-Kontakt verknüpft");
      window.open(json.bexioContactUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Netzwerkfehler";
      TOAST.errorOr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => attemptCreate(false)}
        disabled={busy}
        className="kasten kasten-bexio shrink-0"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {busy ? "Prüfe…" : "In Bexio anlegen"}
      </button>

      {/* Pflichtfeld-Modal — wenn noch nicht alle Bexio-Pflichtfelder am
          Eventline-Kunden hinterlegt sind. */}
      <Modal
        open={!!missingFields}
        onClose={() => setMissingFields(null)}
        title="Pflichtfelder fehlen"
        icon={<AlertCircle className="h-5 w-5 text-amber-500" />}
        size="md"
      >
        <p className="text-sm text-muted-foreground">
          Bexio braucht alle Pflichtfelder bevor der Kontakt angelegt werden kann. Bitte fülle folgende Felder beim Kunden aus:
        </p>
        <ul className="space-y-1.5">
          {missingFields?.map((f) => (
            <li key={f} className="flex items-center gap-2 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <span className="font-medium">{f}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => setMissingFields(null)} className="kasten kasten-muted flex-1">
            Abbrechen
          </button>
          <a
            href={`/kunden/${customerId}?edit=1`}
            className="kasten kasten-purple flex-1"
            onClick={() => setMissingFields(null)}
          >
            <Pencil className="h-3.5 w-3.5" />
            Kunde bearbeiten
          </a>
        </div>
      </Modal>

      {/* Match-Modal — moegliche Duplikat-Treffer. */}
      <Modal
        open={!!matches}
        onClose={() => setMatches(null)}
        title="Möglicher Treffer in Bexio"
        size="md"
        closable={!busy}
      >
        <p className="text-sm text-muted-foreground">
          Es gibt bereits {matches?.length === 1 ? "einen Kontakt" : `${matches?.length} Kontakte`} in Bexio die zu diesem Kunden passen könnten. Verknüpfe diesen Kunden mit dem richtigen Eintrag — oder lege trotzdem einen neuen an.
        </p>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {matches?.map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border bg-foreground/[0.02]">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {m.nr && (
                    <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-foreground/[0.08] text-muted-foreground">
                      Nr. {m.nr}
                    </span>
                  )}
                  <p className="text-sm font-medium break-words">{m.name}</p>
                </div>
                {m.email && (
                  <p className="text-xs text-muted-foreground break-all">{m.email}</p>
                )}
                {(m.postcode || m.city) && (
                  <p className="text-xs text-muted-foreground break-words">
                    {[m.postcode, m.city].filter(Boolean).join(" ")}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => linkExisting(m.id, m.nr)}
                disabled={busy}
                className="kasten kasten-bexio shrink-0"
              >
                <Link2 className="h-3.5 w-3.5" />
                Verknüpfen
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => setMatches(null)} disabled={busy} className="kasten kasten-muted flex-1">
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => { setMatches(null); attemptCreate(true); }}
            disabled={busy}
            className="kasten kasten-red flex-1"
          >
            Trotzdem neu anlegen
          </button>
        </div>
      </Modal>
    </>
  );
}
