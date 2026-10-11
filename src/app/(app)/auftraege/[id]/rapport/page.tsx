"use client";

/**
 * /auftraege/[id]/rapport — Rapport als eigene Seite am Handy (< md).
 * Am Desktop gibt es keine eigene Rapport-Seite (dort bleibt das Modal):
 * useIsMobile() === false leitet auf /auftraege/[id]?tab=rapport um.
 * null (Breite noch unbekannt) zeigt das Skeleton — kein Doppel-Mount.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useIsMobile } from "@/lib/use-is-mobile";
import { RapportMobil } from "@/components/mobile/rapport-mobil";
import Loading from "./loading";

export default function RapportSeite() {
  const { id } = useParams();
  const jobId = id as string;
  const router = useRouter();
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isMobile === false) router.replace(`/auftraege/${jobId}?tab=rapport`);
  }, [isMobile, jobId, router]);

  if (isMobile !== true) return <Loading />;
  return <RapportMobil jobId={jobId} />;
}
