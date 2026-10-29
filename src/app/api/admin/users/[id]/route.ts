// PATCH /api/admin/users/[id] — Profil eines Users bearbeiten.
// Erlaubt sind full_name, role, is_active. Email wird nicht geaendert
// (das ist mit Auth-Layer gekoppelt — separater Flow waere noetig, wird
// bei euch selten gebraucht).
//
// is_active=false ist die "Soft-Delete"-Variante: der User kann sich nicht
// mehr einloggen, bleibt aber als Referenz auf alten Auftraegen (created_by,
// assigned_to, etc.) erhalten. Admin-Client bannt den Auth-User parallel.
//
// DELETE /api/admin/users/[id] — endgueltiges Loeschen. Nur erlaubt fuer
// bereits deaktivierte User (is_active=false), damit man niemanden
// versehentlich aus dem aktiven Betrieb loescht. FKs auf alten Auftraegen
// werden via ON DELETE SET NULL auf null gesetzt (016_protect_data),
// notifications cascadieren weg. Auth-User wird ueber die Admin-API
// geloescht — profiles cascadiert automatisch (FK on auth.users).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { logPermissionAudit } from "@/lib/permission-audit";
import { ANTRAG_HINWEIS, ladeName, personBrauchtAntrag, rolleOeffnetLohn, stelleRechteAntrag } from "@/lib/lohn/rechte-antraege";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });

  // Selbstschutz: Admin darf sich nicht selbst aussperren oder degradieren.
  // Ohne diesen Check kann der einzige Admin sich auf is_active=false setzen
  // (oder seine Rolle weg von 'admin' aendern) und die Firma hat keinen
  // Admin-Zugang mehr.
  if (auth.user.id === id) {
    if (body.is_active === false) {
      return NextResponse.json(
        { success: false, error: "Du kannst dich nicht selbst deaktivieren" },
        { status: 400 },
      );
    }
    if (typeof body.role === "string" && body.role !== "admin") {
      return NextResponse.json(
        { success: false, error: "Du kannst dir nicht selbst die Admin-Rolle wegnehmen" },
        { status: 400 },
      );
    }
  }

  const admin = createAdminClient();

  const update: Record<string, unknown> = {};
  if (typeof body.full_name === "string" && body.full_name.trim()) {
    update.full_name = body.full_name.trim();
  }
  if (typeof body.role === "string") {
    // Rolle muss existieren.
    const { data: roleRow } = await admin.from("roles").select("slug").eq("slug", body.role).single();
    if (!roleRow) {
      return NextResponse.json({ success: false, error: "Rolle existiert nicht" }, { status: 400 });
    }
    update.role = roleRow.slug;
  }
  if (typeof body.is_active === "boolean") {
    update.is_active = body.is_active;
  }
  // birthdate (YYYY-MM-DD oder null um zu loeschen).
  // Wird fuer Ferienanteil-Auto-Erkennung gebraucht (U20 -> 10.64%).
  if (body.birthdate === null) {
    update.birthdate = null;
  } else if (typeof body.birthdate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.birthdate)) {
    update.birthdate = body.birthdate;
  }

  // team_lead_id (UUID oder null um zu loeschen).
  // Zeigt auf den Teamleiter dieses Mitarbeiters — gelesen von sees_user()
  // wenn eine Rolle scope='team' hat (Migration 208).
  //
  // Self-Ausschluss: MA kann nicht sich selbst als Teamleiter waehlen,
  // sonst wuerde sees_user() eine Endlos-Schleife der Sichtbarkeit
  // suggerieren (der User "sieht" sich selbst — was er sowieso tut).
  // Existenz-Check auf profiles verhindert dass ein Client per PATCH
  // eine beliebige UUID einschleusen kann.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (body.team_lead_id === null) {
    update.team_lead_id = null;
  } else if (typeof body.team_lead_id === "string" && UUID_RE.test(body.team_lead_id)) {
    if (body.team_lead_id === id) {
      return NextResponse.json(
        { success: false, error: "Ein Mitarbeiter kann nicht sein eigener Teamleiter sein" },
        { status: 400 },
      );
    }
    const { data: leadRow } = await admin.from("profiles").select("id").eq("id", body.team_lead_id).maybeSingle();
    if (!leadRow) {
      return NextResponse.json({ success: false, error: "Teamleiter existiert nicht" }, { status: 400 });
    }
    update.team_lead_id = body.team_lead_id;
  }

  // Vier Augen bei Rechten (Lohn-Umbau Phase 1, Migration 361): Aendert sich
  // dadurch der Admin-Status oder der Zugang zu Lohndaten (Rolle mit
  // lohn:manage, Reaktivieren eines solchen Kontos), wird NICHT sofort
  // geaendert, sondern ein Antrag gestellt, den der andere Admin bestaetigt.
  // Der DB-Trigger profiles_lohn_rechte_schutz erzwingt dasselbe.
  let antrag: { id: string; gueltig_bis: string } | null = null;
  if (typeof update.role === "string" || update.is_active === true) {
    const { data: jetzt, error: jetztErr } = await admin.from("profiles").select("role, is_active, full_name").eq("id", id).maybeSingle();
    if (jetztErr) return NextResponse.json({ success: false, error: jetztErr.message }, { status: 500 });
    if (!jetzt) return NextResponse.json({ success: false, error: "Benutzer nicht gefunden" }, { status: 404 });
    const altRolle = jetzt.role as string;
    const neuRolle = typeof update.role === "string" ? (update.role as string) : altRolle;
    const altAktiv = jetzt.is_active === true;
    const neuAktiv = typeof update.is_active === "boolean" ? (update.is_active as boolean) : altAktiv;
    let pruef: { noetig: boolean; gewaehrt: boolean };
    try {
      const [altOeffnet, neuOeffnet] = await Promise.all([rolleOeffnetLohn(admin, altRolle), rolleOeffnetLohn(admin, neuRolle)]);
      pruef = personBrauchtAntrag({ altRolle, neuRolle, altAktiv, neuAktiv, altOeffnet, neuOeffnet });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
    if (pruef.noetig) {
      const teile: string[] = [];
      if (neuRolle !== altRolle) teile.push(`Rolle ${altRolle} → ${neuRolle}`);
      if (neuAktiv && !altAktiv) teile.push("reaktivieren");
      try {
        antrag = await stelleRechteAntrag(admin, {
          art: "person",
          zielProfileId: id,
          zielName: (jetzt.full_name as string | null) ?? null,
          payload: { rolle_alt: altRolle, ...(neuRolle !== altRolle ? { rolle_neu: neuRolle } : {}), aktivieren: neuAktiv && !altAktiv },
          beschreibung: `${jetzt.full_name ?? "Person"}: ${teile.join(", ")}`,
          gewaehrt: pruef.gewaehrt,
          actorId: auth.user.id,
          actorName: await ladeName(admin, auth.user.id),
        });
      } catch (e) {
        return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 409 });
      }
      delete update.role;
      if (update.is_active === true) delete update.is_active;
    }
  }

  if (Object.keys(update).length === 0 && !Array.isArray(body.team_members)) {
    if (antrag) return NextResponse.json({ success: true, antrag, hinweis: ANTRAG_HINWEIS });
    return NextResponse.json({ success: false, error: "Keine Änderungen" }, { status: 400 });
  }

  // team_members (optional): Vollstaendige Liste der MA-UUIDs die diesem
  // Teamleiter zugeordnet sein sollen. Umkehrung des klassischen „pro MA
  // einen Teamleiter waehlen"-Flows: statt in 10 MA-Modals einzeln den
  // Teamleiter zu setzen, waehlt der Admin im Teamleiter-Modal einmal
  // alle Team-Mitglieder aus. Server berechnet Diff gegen den aktuellen
  // Stand und setzt team_lead_id auf allen betroffenen Zeilen. Nur
  // erlaubt wenn der bearbeitete User selbst eine Rolle mit scope='team'
  // (oder 'all') hat — sonst waere die Semantik unklar (jemand ohne
  // Team-Sichtbarkeit ist kein Teamleiter).
  let teamMembersRequested: string[] | null = null;
  if (Array.isArray(body.team_members)) {
    // 1) IDs formal validieren + dedupen + Self-Ref abwehren.
    const raw = (body.team_members as unknown[]).filter(
      (v): v is string => typeof v === "string" && UUID_RE.test(v),
    );
    const dedup = Array.from(new Set(raw));
    if (dedup.includes(id)) {
      return NextResponse.json(
        { success: false, error: "Ein Teamleiter kann sich nicht selbst als Team-Mitglied wählen" },
        { status: 400 },
      );
    }
    // 2) Pruefen dass der Ziel-User selbst Teamleiter-Rolle (scope='team'|'all') hat.
    const newRoleSlug = typeof update.role === "string"
      ? (update.role as string)
      : (await admin.from("profiles").select("role").eq("id", id).maybeSingle()).data?.role;
    if (!newRoleSlug) {
      return NextResponse.json({ success: false, error: "Rolle des Users nicht auffindbar" }, { status: 400 });
    }
    if (newRoleSlug !== "admin") {
      const { data: roleRow } = await admin.from("roles").select("scope").eq("slug", newRoleSlug).maybeSingle();
      const roleScope = roleRow?.scope ?? "self";
      if (roleScope !== "team" && roleScope !== "all") {
        return NextResponse.json(
          { success: false, error: "Nur Rollen mit Sichtbarkeit „Nur Team\" oder „Alle\" duerfen Team-Mitglieder haben" },
          { status: 400 },
        );
      }
    }
    // 3) Kandidaten-Ueberpruefung: keine anderen Teamleiter/Admins/Deaktivierten,
    //    UND keine "Team-Diebstahl"-Kandidaten (schon in einem anderen Team).
    //    Wir loesen die scope-Info aller Ziel-User ueber profiles.role -> roles.scope.
    if (dedup.length > 0) {
      const { data: candProfiles } = await admin
        .from("profiles")
        .select("id, full_name, role, is_active, team_lead_id")
        .in("id", dedup);
      if (!candProfiles || candProfiles.length !== dedup.length) {
        return NextResponse.json({ success: false, error: "Mindestens ein Team-Mitglied existiert nicht" }, { status: 400 });
      }
      const roleSlugs = Array.from(new Set(candProfiles.map((p) => p.role)));
      const { data: roleRows } = await admin.from("roles").select("slug, scope").in("slug", roleSlugs);
      const scopeMap = new Map<string, string>((roleRows ?? []).map((r) => [r.slug, r.scope ?? "self"]));
      for (const p of candProfiles) {
        if (!p.is_active) {
          return NextResponse.json({ success: false, error: "Deaktivierte Mitarbeiter koennen nicht Team-Mitglied sein" }, { status: 400 });
        }
        if (p.role === "admin") {
          return NextResponse.json({ success: false, error: "Admins koennen nicht Team-Mitglied sein" }, { status: 400 });
        }
        const s = scopeMap.get(p.role) ?? "self";
        if (s === "team" || s === "all") {
          return NextResponse.json({ success: false, error: "Andere Teamleiter koennen nicht Team-Mitglied sein" }, { status: 400 });
        }
      }
      // Team-EXKLUSIVITAETS-Check ("Diebstahl"-Sperre): ein MA der bereits
      // einem ANDEREN Teamleiter zugeordnet ist, darf nicht ohne "Umzug"
      // uebernommen werden. Alle-oder-nichts: beim ersten Konflikt abort,
      // KEIN Teil-Update. Der Check laeuft VOR jedem profiles-Update, also
      // ist kein Rollback noetig. Fehler enthaelt user_id + current_lead,
      // damit der Client den Konflikt-MA namentlich im Toast anzeigen kann.
      // MA die bereits zu 'id' gehoeren sind ok (das ist ja "mein" Team).
      const conflict = candProfiles.find(
        (p) => p.team_lead_id && p.team_lead_id !== id,
      );
      if (conflict) {
        const { data: leadRow } = await admin
          .from("profiles")
          .select("id, full_name")
          .eq("id", conflict.team_lead_id as string)
          .maybeSingle();
        const leadName = leadRow?.full_name ?? "einem anderen Teamleiter";
        return NextResponse.json(
          {
            success: false,
            error: `Mitarbeiter ${conflict.full_name} ist bereits im Team von ${leadName} — bitte erst dort entfernen`,
            user_id: conflict.id,
            current_lead: leadRow ? { id: leadRow.id, full_name: leadRow.full_name } : null,
          },
          { status: 409 },
        );
      }
    }
    teamMembersRequested = dedup;
  }

  // Vorherigen Profile-Stand laden — Audit-Diff fuer Rollen-Wechsel.
  const { data: before } = await admin
    .from("profiles")
    .select("role")
    .eq("id", id)
    .maybeSingle();
  // Profil-Update nur wenn tatsaechlich Stammdaten geaendert wurden.
  // Reine team_members-Requests (kein Stammdaten-Diff) skippen den Update.
  if (Object.keys(update).length > 0) {
    const { error: profErr } = await admin.from("profiles").update(update).eq("id", id);
    if (profErr) {
      logError("admin.users.update.profile", profErr, { userId: id });
      return NextResponse.json({ success: false, error: "Update fehlgeschlagen" }, { status: 500 });
    }
  }

  // Team-Mitglieder-Diff anwenden. Zwei Updates: added -> team_lead_id=id,
  // removed -> team_lead_id=null. Nicht transaktional (Supabase-REST kann
  // das nicht direkt), aber unkritisch: bei parallelen Sessions gewinnt
  // ohnehin die letzte (Konzept: kein Locking).
  if (teamMembersRequested !== null) {
    const { data: currentMembers } = await admin
      .from("profiles")
      .select("id")
      .eq("team_lead_id", id);
    const currentSet = new Set((currentMembers ?? []).map((p) => p.id));
    const newSet = new Set(teamMembersRequested);
    const added = teamMembersRequested.filter((mid) => !currentSet.has(mid));
    const removed = Array.from(currentSet).filter((mid) => !newSet.has(mid));

    if (added.length > 0) {
      const { error: addErr } = await admin
        .from("profiles")
        .update({ team_lead_id: id })
        .in("id", added);
      if (addErr) {
        logError("admin.users.update.team_add", addErr, { userId: id, added });
        return NextResponse.json({ success: false, error: "Team-Zuordnung fehlgeschlagen" }, { status: 500 });
      }
    }
    if (removed.length > 0) {
      const { error: rmErr } = await admin
        .from("profiles")
        .update({ team_lead_id: null })
        .in("id", removed);
      if (rmErr) {
        logError("admin.users.update.team_remove", rmErr, { userId: id, removed });
        return NextResponse.json({ success: false, error: "Team-Abzug fehlgeschlagen" }, { status: 500 });
      }
    }
  }

  // Audit-Log nur fuer Rollen-Aenderungen (sicherheitsrelevant).
  if (typeof update.role === "string" && before?.role !== update.role) {
    await logPermissionAudit({
      actor_profile_id: auth.user.id,
      action: "user.role_changed",
      target_profile_id: id,
      details: { from: before?.role ?? null, to: update.role },
    });
  }

  // Wenn is_active=false: Auth-User bannen damit Login nicht mehr geht.
  // Reaktivieren = ban_duration: "none" — nur wenn die Reaktivierung nicht
  // als Antrag wartet (dann hebt die Bestaetigung die Sperre auf).
  if (typeof update.is_active === "boolean") {
    const { error: banErr } = await admin.auth.admin.updateUserById(id, {
      ban_duration: update.is_active ? "none" : "876000h", // ~100 Jahre = effektiv permanent
    });
    if (banErr) {
      // Profil ist schon umgestellt — den Ban-Fehler nur zurueckmelden.
      logError("admin.users.update.ban", banErr, { userId: id });
      return NextResponse.json({ success: false, error: "Login-Sperre konnte nicht gesetzt werden" }, { status: 500 });
    }
  }

  return NextResponse.json(antrag ? { success: true, antrag, hinweis: ANTRAG_HINWEIS } : { success: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { success: false, error: "Server-Konfiguration unvollständig" },
      { status: 500 },
    );
  }

  const { id } = await params;

  // Selbstschutz: Admin darf sich nicht selbst loeschen.
  if (auth.user.id === id) {
    return NextResponse.json(
      { success: false, error: "Du kannst dich nicht selbst löschen" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Strikt nur deaktivierte User. Wer aktiv ist, muss erst deaktiviert
  // werden — schuetzt vor versehentlichem Hard-Delete im Live-Betrieb.
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("id, email, full_name, is_active")
    .eq("id", id)
    .maybeSingle();

  if (profErr) {
    return NextResponse.json({ success: false, error: profErr.message }, { status: 500 });
  }

  // Profil kann verwaist sein (orphan: profile geloescht / nie existiert,
  // aber auth.users-Eintrag noch da). Trotzdem Loesch-Versuch via Auth-API
  // damit der Admin auch verwaiste Auth-User beseitigen kann.
  if (profile && profile.is_active) {
    return NextResponse.json(
      { success: false, error: "Nur deaktivierte Benutzer können gelöscht werden" },
      { status: 400 },
    );
  }

  // Lohn-Umbau Phase 1 — ZUERST pruefen, dann loeschen, nie Speicherdateien:
  // Wer Lohnzeilen, Lohndokumente, Stempel oder entschiedene Abwesenheiten
  // hat, wird nicht geloescht, sondern bleibt archiviert (deaktiviert, Login
  // gesperrt) — Aufbewahrungspflicht. Die DB erzwingt dasselbe (Trigger
  // profiles_lohn_schutz, Migration 360). Dateien in «lohndokumente» und
  // «personal-dossiers» werden hier NIE entfernt (frueher: alle PDFs der
  // Person geloescht, noch bevor der Login weg war).
  if (profile) {
    const pruefungen = await Promise.all([
      admin.from("employee_compensation").select("id", { count: "exact", head: true }).eq("profile_id", id),
      admin.from("wage_documents").select("id", { count: "exact", head: true }).eq("profile_id", id),
      admin.from("time_entries").select("id", { count: "exact", head: true }).eq("user_id", id),
      admin.from("time_off").select("id", { count: "exact", head: true }).eq("user_id", id).neq("status", "beantragt"),
    ]);
    const fehler = pruefungen.find((r) => r.error)?.error;
    if (fehler) {
      return NextResponse.json({ success: false, error: `Prüfung fehlgeschlagen: ${fehler.message}` }, { status: 500 });
    }
    const namen = ["Lohnzeilen", "Lohndokumente", "Stempelzeiten", "Abwesenheiten"];
    const vorhanden = pruefungen.map((r, i) => ((r.count ?? 0) > 0 ? namen[i] : null)).filter(Boolean);
    if (vorhanden.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `${profile.full_name ?? "Diese Person"} hat ${vorhanden.join(", ")} (Aufbewahrungspflicht) und bleibt archiviert (deaktiviert) — endgültiges Löschen ist nicht möglich.`,
          archiviert_statt_geloescht: true,
        },
        { status: 409 },
      );
    }
  }

  // Auth-User loeschen. profiles cascadiert via FK ON DELETE CASCADE.
  // Falls auth.users nicht (mehr) existiert: 404 von Supabase ignorieren
  // und nur das verwaiste profile wegputzen.
  const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });

  if (!authRes.ok && authRes.status !== 404) {
    const body = await authRes.text().catch(() => "");
    logError("admin.users.delete.auth", { status: authRes.status, body }, { userId: id });
    return NextResponse.json(
      { success: false, error: `Auth-Löschung fehlgeschlagen: ${body || authRes.status}` },
      { status: 500 },
    );
  }

  // Sicherheits-Netz: falls profile-Cascade nicht griff (z.B. weil FK
  // damals nicht angelegt wurde) — explizit nachloeschen. FEHLER JETZT
  // AUSWERTEN (frueher verschluckt): wenn ein FK-Constraint oder eine
  // andere Referenz blockt, war der Frontend-Toast 'geloescht' trotzdem
  // gruen und die Row blieb sichtbar. Jetzt gibt der Endpoint einen
  // klaren Fehler zurueck damit der Admin weiss was ihn blockt.
  const { error: profDelErr } = await admin
    .from("profiles")
    .delete({ count: "exact" })
    .eq("id", id);
  if (profDelErr) {
    logError("admin.users.delete.profile", { error: profDelErr.message }, { userId: id });
    return NextResponse.json(
      {
        success: false,
        error: `Profile-Löschung fehlgeschlagen: ${profDelErr.message}. Möglicherweise gibt es noch Referenzen (z.B. Aufträge, Anfragen).`,
      },
      { status: 500 },
    );
  }

  // Verify: Row wirklich weg? Manche FK-Konstellationen fangen den
  // Fehler nicht ab, hinterlassen aber die Row.
  const { data: still } = await admin
    .from("profiles")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (still) {
    logError("admin.users.delete.orphaned", { userId: id }, { userId: id });
    return NextResponse.json(
      {
        success: false,
        error: "Löschung nicht abgeschlossen — Profile ist noch vorhanden. Vermutlich blockieren FK-Constraints (siehe Server-Log).",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
