// Alarme des Technik-Dashboards (Vertrag §5). Der Cron technik-alarme ruft
// alle 5 Minuten `alarmLauf` auf.
//
// - Stufe gewechselt → technik_zustaende aktualisieren + Ereignis «zustand».
// - Alarm: Ampel darf alarmieren, ist seit ≥ 10 min ununterbrochen kritisch und
//   der letzte Alarm dazu liegt ≥ 6 h zurueck (Drossel, kein Spam). Dauert ein
//   gemeldetes Problem an (noch nicht entwarnt), kommt hoechstens 1× pro 24 h
//   eine Erinnerung.
// - Entwarnung: ein gemeldeter Alarm ist wieder gut/Warnung → Mitteilung ohne Mail.
// - Alle in einem Lauf faelligen Alarme ergeben EINE Mitteilung/Mail je Admin.
//
// `planeAlarme` ist rein (getestet); `alarmLauf` macht das I/O. Alarme und
// Entwarnungen werden in der DB atomar «beansprucht» (bedingtes UPDATE), damit
// zwei ueberlappende Cron-Laeufe nie doppelt melden.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMailConfigured } from "@/lib/mail";
import { logError } from "@/lib/log";
import { notifyTechnikAlarm, notifyTechnikEntwarnung } from "@/lib/notification-service";
import { NEUTRAL_WORT, STUFE_WORT } from "./ampeln";
import { ALARM_DROSSEL_MS, ALARM_ERINNERUNG_MS, ALARM_NACH_MS, ALARM_OHNE_MAIL } from "./konstanten";
import type { NeuesEreignis } from "./paket";
import { ampelnAus, ladeGrundlagen, type ZustandZeile } from "./stand-server";
import type { Ampel, Stufe } from "./typen";

export interface ZustandUpsert {
  schluessel: string;
  stufe: Stufe;
  seit: string;
  kritisch_seit: string | null;
  aktualisiert: string;
}

export interface AlarmPlan {
  zustaende: ZustandUpsert[];
  ereignisse: NeuesEreignis[];
  alarme: Ampel[];
  entwarnungen: Ampel[];
}

const schlecht = (s: Stufe | undefined) => s === "warnung" || s === "kritisch";

function stufenWort(a: Ampel): string {
  return a.stufe === "neutral" ? NEUTRAL_WORT[a.neutral ?? "info"] : STUFE_WORT[a.stufe];
}

function kappe(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}

/** Drossel je Problem: Ist der letzte Alarm noch offen (nicht entwarnt), kommt
 *  hoechstens eine Erinnerung pro 24 h; ein neuer Vorfall nach Entwarnung
 *  frühestens 6 h nach dem letzten Alarm. */
export function drosselMs(z: Pick<ZustandZeile, "alarm_offen"> | undefined): number {
  return z?.alarm_offen ? ALARM_ERINNERUNG_MS : ALARM_DROSSEL_MS;
}

/** Reine Planung eines Alarm-Laufs aus den aktuellen Ampeln und technik_zustaende. */
export function planeAlarme(ampeln: Ampel[], zustaende: ZustandZeile[], jetzt: Date): AlarmPlan {
  const jetztMs = jetzt.getTime();
  const jetztIso = jetzt.toISOString();
  const alt = new Map(zustaende.map((z) => [z.schluessel, z]));
  const plan: AlarmPlan = { zustaende: [], ereignisse: [], alarme: [], entwarnungen: [] };

  for (const a of ampeln) {
    const z = alt.get(a.schluessel);
    let kritischSeit: string | null;

    if (!z || z.stufe !== a.stufe) {
      kritischSeit = a.stufe === "kritisch" ? jetztIso : null;
      plan.zustaende.push({ schluessel: a.schluessel, stufe: a.stufe, seit: jetztIso, kritisch_seit: kritischSeit, aktualisiert: jetztIso });
      // Ereignis nur, wenn Warnung/kritisch beteiligt ist (gut ↔ neutral, z. B. bei
      // veralteten Messwerten, waere reines Rauschen).
      if (schlecht(a.stufe) || schlecht(z?.stufe)) {
        plan.ereignisse.push({
          zeitpunkt: jetztIso,
          art: "zustand",
          stufe: a.stufe === "neutral" ? "hinweis" : a.stufe,
          bauteil: a.bauteil,
          schluessel: a.schluessel,
          text: kappe(`${a.titel}: ${stufenWort(a)} – ${a.text}`),
        });
      }
    } else {
      kritischSeit = a.stufe === "kritisch" ? (z.kritisch_seit ?? z.seit) : null;
    }

    if (
      a.alarm &&
      a.stufe === "kritisch" &&
      kritischSeit !== null &&
      jetztMs - Date.parse(kritischSeit) >= ALARM_NACH_MS &&
      (!z?.alarm_gesendet_am || jetztMs - Date.parse(z.alarm_gesendet_am) >= drosselMs(z))
    ) {
      plan.alarme.push(a);
    }

    // Entwarnung erst bei einem echten Befund (gut/Warnung) — «veraltet» oder
    // «nicht lesbar» heisst nicht, dass das Problem weg ist.
    if (z?.alarm_offen && (a.stufe === "gut" || a.stufe === "warnung")) plan.entwarnungen.push(a);
  }
  return plan;
}

/** Titel einer gebuendelten Meldung: schlimmstes (erstes) Problem plus Anzahl weiterer. */
export function alarmTitel(alarme: Ampel[]): string {
  const erstes = `${alarme[0].titel} kritisch`;
  const weitere = alarme.length - 1;
  if (weitere <= 0) return erstes;
  return `${erstes} und ${weitere} ${weitere === 1 ? "weiteres Problem" : "weitere Probleme"}`;
}

export function entwarnTitel(entwarnungen: Ampel[]): string {
  if (entwarnungen.length === 1) return `${entwarnungen[0].titel} wieder in Ordnung`;
  return `${entwarnungen.length} Probleme wieder in Ordnung`;
}

export const alarmZeile = (a: Ampel) => `${a.titel}: ${a.text}`;
export const entwarnZeile = (a: Ampel) => `${a.titel}: ${stufenWort(a)} – ${a.text}`;

export interface AlarmLaufErgebnis {
  success: boolean;
  gewechselt: number;
  alarme: number;
  entwarnungen: number;
}

/** Ein Lauf des Crons. Wirft nie; Fehler landen im Log. */
export async function alarmLauf(admin: SupabaseClient, jetzt: Date = new Date()): Promise<AlarmLaufErgebnis> {
  try {
    const g = await ladeGrundlagen(admin, jetzt);
    const ampeln = ampelnAus(g, jetzt);
    const plan = planeAlarme(ampeln, g.zustaende, jetzt);
    const jetztIso = jetzt.toISOString();

    if (plan.zustaende.length > 0) {
      const { error } = await admin.from("technik_zustaende").upsert(plan.zustaende, { onConflict: "schluessel" });
      if (error) throw new Error(`technik_zustaende: ${error.message}`);
    }

    // Alarme atomar beanspruchen: nur wer die Zeile umstellt, meldet.
    const zustandVon = new Map(g.zustaende.map((z) => [z.schluessel, z]));
    const alarme: Ampel[] = [];
    for (const a of plan.alarme) {
      const drosselGrenze = new Date(jetzt.getTime() - drosselMs(zustandVon.get(a.schluessel))).toISOString();
      const { data, error } = await admin
        .from("technik_zustaende")
        .update({ alarm_gesendet_am: jetztIso, alarm_offen: true, aktualisiert: jetztIso })
        .eq("schluessel", a.schluessel)
        .or(`alarm_gesendet_am.is.null,alarm_gesendet_am.lte.${drosselGrenze}`)
        .select("schluessel");
      if (error) logError("cron.technik-alarme.alarm", error, { schluessel: a.schluessel });
      else if (data && data.length > 0) alarme.push(a);
    }
    const entwarnungen: Ampel[] = [];
    for (const a of plan.entwarnungen) {
      const { data, error } = await admin
        .from("technik_zustaende")
        .update({ alarm_offen: false, aktualisiert: jetztIso })
        .eq("schluessel", a.schluessel)
        .eq("alarm_offen", true)
        .select("schluessel");
      if (error) logError("cron.technik-alarme.entwarnung", error, { schluessel: a.schluessel });
      else if (data && data.length > 0) entwarnungen.push(a);
    }

    const ereignisse: NeuesEreignis[] = [
      ...plan.ereignisse,
      ...alarme.map((a): NeuesEreignis => ({
        zeitpunkt: jetztIso, art: "alarm", stufe: "kritisch", bauteil: a.bauteil, schluessel: a.schluessel,
        text: kappe(`Alarm an die Admins: ${alarmZeile(a)}`),
      })),
      ...entwarnungen.map((a): NeuesEreignis => ({
        zeitpunkt: jetztIso, art: "entwarnung", stufe: "gut", bauteil: a.bauteil, schluessel: a.schluessel,
        text: kappe(`Entwarnung: ${entwarnZeile(a)}`),
      })),
    ];
    if (ereignisse.length > 0) {
      const { error } = await admin.from("technik_ereignisse").insert(ereignisse);
      if (error) logError("cron.technik-alarme.ereignisse", error, { anzahl: ereignisse.length });
    }

    if (alarme.length > 0 || entwarnungen.length > 0) {
      const { data: admins, error } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "admin")
        .eq("is_active", true);
      if (error) throw new Error(`profiles: ${error.message}`);
      const recipients = (admins ?? []).map((p) => p.id as string).filter(Boolean);

      if (alarme.length > 0 && recipients.length > 0) {
        const mitMail = alarme.filter((a) => !ALARM_OHNE_MAIL.includes(a.schluessel));
        if (mitMail.length > 0 && !isMailConfigured()) {
          logError("cron.technik-alarme.mail-nicht-konfiguriert", null, { alarme: mitMail.length });
        }
        await notifyTechnikAlarm(admin, {
          recipients,
          titel: alarmTitel(alarme),
          zeilen: alarme.map(alarmZeile),
          mail: mitMail.length > 0 ? { titel: alarmTitel(mitMail), zeilen: mitMail.map(alarmZeile) } : false,
        });
      }
      if (entwarnungen.length > 0 && recipients.length > 0) {
        await notifyTechnikEntwarnung(admin, {
          recipients,
          titel: entwarnTitel(entwarnungen),
          zeilen: entwarnungen.map(entwarnZeile),
        });
      }
    }

    return { success: true, gewechselt: plan.zustaende.length, alarme: alarme.length, entwarnungen: entwarnungen.length };
  } catch (e) {
    logError("cron.technik-alarme", e);
    return { success: false, gewechselt: 0, alarme: 0, entwarnungen: 0 };
  }
}
