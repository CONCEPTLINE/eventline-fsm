"use client";

// «Ein Login» aus Trust one: Trust one leitet auf /sso#t=<Ausweis>. Der
// Ausweis steht im Fragment (geht an keinen Server, in kein Log, in keinen
// Referrer) und wird sofort aus der Adresszeile entfernt. Pruefung und
// Session-Ausgabe: POST /api/auth/trust-one. Ohne Login erreichbar (liegt
// bewusst ausserhalb des (app)-Layouts).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { clearMeCache } from "@/lib/me-cache";
import {
  APP_START,
  SsoKarte,
  SsoLaden,
  TRUST_ONE_NAME_KEY,
  TRUST_ONE_PENDING_KEY,
  VERBINDEN_PFAD,
  pendingVergessen,
} from "./sso-karte";

type Zustand = "laden" | "nicht_verbunden" | "fehler";

type Antwort = {
  status?: string;
  token_hash?: unknown;
  pending?: unknown;
  name?: unknown;
};

export default function SsoPage() {
  const router = useRouter();
  const [zustand, setZustand] = useState<Zustand>("laden");
  const [weiter, setWeiter] = useState(false);
  // Der Ausweis ist einmalig — die Anfrage darf nur EINMAL rausgehen (auch
  // beim doppelten Effekt-Lauf im Dev-StrictMode).
  const gestartet = useRef(false);

  // Kommt ein neuer Ausweis in einen schon offenen /sso-Tab (nur das Fragment
  // aendert sich, kein Seitenaufbau), frisch laden — dann laeuft der Ablauf
  // unten erneut.
  useEffect(() => {
    const neuerAusweis = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).get("t")) window.location.reload();
    };
    window.addEventListener("hashchange", neuerAusweis);
    return () => window.removeEventListener("hashchange", neuerAusweis);
  }, []);

  useEffect(() => {
    if (gestartet.current) return;
    gestartet.current = true;

    // Kein fremder Name aus dem Boot-Cache, falls vorher jemand anders hier
    // angemeldet war.
    clearMeCache();
    const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
    window.history.replaceState(null, "", window.location.pathname);

    void (async () => {
      if (!token) {
        setZustand("fehler");
        return;
      }
      try {
        const res = await fetch("/api/auth/trust-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as Antwort | null;
        const supabase = createClient();

        if (res.ok && json?.status === "ok" && typeof json.token_hash === "string") {
          // Session wie beim Passkey-Login (login/page.tsx).
          const { error } = await supabase.auth.verifyOtp({ type: "email", token_hash: json.token_hash });
          if (error) {
            setZustand("fehler");
            return;
          }
          pendingVergessen();
          window.location.replace(APP_START);
          return;
        }

        if (res.ok && json?.status === "not_linked" && typeof json.pending === "string") {
          try {
            sessionStorage.setItem(TRUST_ONE_PENDING_KEY, json.pending);
            if (typeof json.name === "string" && json.name) sessionStorage.setItem(TRUST_ONE_NAME_KEY, json.name);
            else sessionStorage.removeItem(TRUST_ONE_NAME_KEY);
          } catch {
            // Ohne sessionStorage kommt der Verbinden-Schritt nicht an.
            setZustand("fehler");
            return;
          }
          // Schon jemand angemeldet → direkt verbinden (mit Rueckfrage dort).
          const { data } = await supabase.auth.getUser();
          if (data.user) {
            window.location.replace(VERBINDEN_PFAD);
            return;
          }
          setZustand("nicht_verbunden");
          return;
        }

        setZustand("fehler");
      } catch {
        setZustand("fehler");
      }
    })();
  }, []);

  return (
    <SsoKarte>
      {zustand === "laden" && <SsoLaden text="Anmelden …" />}

      {zustand === "nicht_verbunden" && (
        <div className="space-y-5 text-center">
          <p className="text-sm">
            Dieses Konto ist noch nicht mit Trust one verbunden. Melde dich einmal mit deinem EVENTLINE-Konto an,
            dann verbinden wir es.
          </p>
          <button
            type="button"
            className="kasten kasten-red w-full !py-2.5 !text-sm"
            disabled={weiter}
            onClick={() => {
              setWeiter(true);
              router.push(`/login?next=${encodeURIComponent(VERBINDEN_PFAD)}`);
            }}
          >
            {weiter ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            Anmelden und verbinden
          </button>
        </div>
      )}

      {zustand === "fehler" && (
        <div className="space-y-5 text-center">
          <p className="text-sm">Der Sprung aus Trust one hat nicht geklappt. Bitte normal anmelden.</p>
          <Link href="/login" className="kasten kasten-muted w-full !py-2.5 !text-sm">
            <LogIn className="h-4 w-4" />
            Zur Anmeldung
          </Link>
        </div>
      )}
    </SsoKarte>
  );
}
