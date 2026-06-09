"use client";

/**
 * Vertrieb-Lead-Detail-Page.
 *
 * Seit der 3-Spalten-Umstrukturierung lebt der Lead-Editor im
 * Detail-Bereich von /vertrieb selbst. Diese Page hier ist nur noch
 * ein Redirect — Bookmarks und externe Links auf /vertrieb/<id> landen
 * in der neuen Liste und oeffnen den entsprechenden Lead direkt im
 * Detail-Bereich via Query-Param ?lead=<id>.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function LeadDetailRedirect() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";

  useEffect(() => {
    if (id) router.replace(`/vertrieb?lead=${id}`);
    else router.replace("/vertrieb");
  }, [id, router]);

  return null;
}
