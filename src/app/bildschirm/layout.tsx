import type { Metadata } from "next";

// Buero-Bildschirm: bewusst AUSSERHALB der (app)-Gruppe — keine Sidebar,
// keine App-Session. Zugang ueber Mail-Code (src/lib/bildschirm.ts).
export const metadata: Metadata = {
  title: "EVENTLINE Bildschirm",
};

export default function BildschirmLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
