import { redirect } from "next/navigation";

// /ablage ist nach /nas (Tab "Ablage") umgezogen — Deep-Link-Alias.
export default function AblageRedirect() {
  redirect("/nas?tab=ablage");
}
