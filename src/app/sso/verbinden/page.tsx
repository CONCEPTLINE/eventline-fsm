"use client";

// «Ein Login», Schritt 2: der Trust-one-User aus /sso war noch nicht
// verbunden. Nach einer normalen Anmeldung (Login mit ?next=/sso/verbinden)
// bestaetigt der Nutzer hier einmal die Verbindung mit SEINEM Konto.
// Nur eingeloggt — ohne Session geht es zur Anmeldung und wieder hierher.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Link2, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  APP_START,
  SsoKarte,
  SsoLaden,
  TRUST_ONE_NAME_KEY,
  TRUST_ONE_PENDING_KEY,
  VERBINDEN_PFAD,
  pendingVergessen,
} from "../sso-karte";

type Zustand =
  | { art: "laden" }
  | { art: "nichts" }
  | { art: "vorbei"; text: string }
  | { art: "frage"; pending: string; trustOneName: string | null; konto: string };

function lesen(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export default function SsoVerbindenPage() {
  const [zustand, setZustand] = useState<Zustand>({ art: "laden" });
  const [sendet, setSendet] = useState(false);
  const [abbrechen, setAbbrechen] = useState(false);
  const [fehler, setFehler] = useState("");
  const gestartet = useRef(false);

  useEffect(() => {
    if (gestartet.current) return;
    gestartet.current = true;
    void (async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (!user) {
        window.location.replace(`/login?next=${encodeURIComponent(VERBINDEN_PFAD)}`);
        return;
      }
      const pending = lesen(TRUST_ONE_PENDING_KEY);
      if (!pending) {
        setZustand({ art: "nichts" });
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();
      const name = (profile?.full_name as string | undefined)?.trim();
      const konto = name && user.email ? `${name} (${user.email})` : name || user.email || "dein Konto";
      setZustand({ art: "frage", pending, trustOneName: lesen(TRUST_ONE_NAME_KEY), konto });
    })();
  }, []);

  async function verbinden(pending: string) {
    setSendet(true);
    setFehler("");
    try {
      const res = await fetch("/api/auth/trust-one/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pending }),
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && json?.success) {
        pendingVergessen();
        window.location.replace(APP_START);
        return;
      }
      const text = json?.error || "Verbinden hat nicht geklappt. Bitte nochmals versuchen.";
      if (res.status === 401) {
        window.location.replace(`/login?next=${encodeURIComponent(VERBINDEN_PFAD)}`);
        return;
      }
      // Abgelaufen/verbraucht: der Eintrag nuetzt nichts mehr.
      if (res.status === 410 || res.status === 400) {
        pendingVergessen();
        setZustand({ art: "vorbei", text });
        return;
      }
      setFehler(text);
      setSendet(false);
    } catch {
      setFehler("Keine Verbindung zum Server. Bitte nochmals versuchen.");
      setSendet(false);
    }
  }

  return (
    <SsoKarte>
      {zustand.art === "laden" && <SsoLaden text="Wird geladen …" />}

      {(zustand.art === "nichts" || zustand.art === "vorbei") && (
        <div className="space-y-5 text-center">
          {zustand.art === "vorbei" ? (
            <p className="text-sm text-red-600">{zustand.text}</p>
          ) : (
            <p className="text-sm">
              Hier gibt es nichts zu verbinden. Klicke in Trust one auf EVENTLINE ERP, um die Verbindung zu starten.
            </p>
          )}
          <Link href={APP_START} className="kasten kasten-muted w-full !py-2.5 !text-sm">
            <ArrowLeft className="h-4 w-4" />
            Zur Startseite
          </Link>
        </div>
      )}

      {zustand.art === "frage" && (
        <div className="space-y-5 text-center">
          <p className="text-sm">
            Trust one{zustand.trustOneName ? <> (<strong className="font-semibold">{zustand.trustOneName}</strong>)</> : null}{" "}
            mit deinem Konto <strong className="font-semibold">{zustand.konto}</strong> verbinden?
          </p>
          <p className="text-xs text-muted-foreground">
            Danach meldet dich ein Klick in Trust one direkt hier an.
          </p>
          {fehler && <p className="text-sm text-red-600">{fehler}</p>}
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              className="kasten kasten-red w-full !py-2.5 !text-sm"
              disabled={sendet || abbrechen}
              onClick={() => verbinden(zustand.pending)}
            >
              {sendet ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {sendet ? "Wird verbunden …" : "Verbinden"}
            </button>
            <button
              type="button"
              className="kasten kasten-muted w-full !py-2.5 !text-sm"
              disabled={sendet || abbrechen}
              onClick={() => {
                setAbbrechen(true);
                pendingVergessen();
                window.location.replace(APP_START);
              }}
            >
              {abbrechen && <Loader2 className="h-4 w-4 animate-spin" />}
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </SsoKarte>
  );
}
