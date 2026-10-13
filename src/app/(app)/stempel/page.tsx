import { redirect } from "next/navigation";

// Aeltere Benachrichtigungen («Stempeluhr laeuft noch») verlinkten auf
// /stempel — diese Route gab es nie. Neue Meldungen zeigen direkt auf
// /stempelzeiten; diese Weiterleitung faengt die alten in der Datenbank ab.
export default function StempelPage() {
  redirect("/stempelzeiten");
}
