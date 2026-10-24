// Adressen von Trust one (Inhaberportal der Trust Group), die das ERP kennt. Seit 24.10.2026 lebt die Ablage der
// EVENTLINE GmbH (NAS, Fristen, Mail-Eingang ablage@) dort, im Bereich «eventline-gmbh». Kein Geheimnis — darf in den
// Browser (Links). Die Server-Aufrufe der Fremd-API stehen in lib/trust-one-ablage.

/** Basis-Adresse von Trust one (Server-Aufrufe koennen sie per env TRUST_ONE_URL ueberschreiben). */
export const TRUST_ONE_URL_STANDARD = "https://one.trust-group.ch";

/** Bereich (Slug) der EVENTLINE GmbH in der Trust-one-Ablage. */
export const TRUST_ONE_ABLAGE_BEREICH = "eventline-gmbh";

/** Fristen der Ablage in Trust one — Ziel der Zeile «Fristen in 30 Tagen» im Dashboard. */
export const TRUST_ONE_FRISTEN_LINK = `${TRUST_ONE_URL_STANDARD}/geschaeft/ablage/${TRUST_ONE_ABLAGE_BEREICH}?ansicht=fristen`;
