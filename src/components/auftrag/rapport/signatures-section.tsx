"use client";

// Unterschriften-Sektion: Service-Techniker (immer) + optional
// Kunde/Mieter-Unterschrift. Bei Instandhaltungs-Auftraegen wird die
// Kunden-Sektion komplett ausgeblendet — dort gibt's keinen
// Veranstalter zum Gegenzeichnen.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignaturePad } from "@/components/signature-pad";
import type { ProfileOption } from "./types";

interface Props {
  technicianId: string;
  technicianName: string;
  clientName: string;
  signerType: "kunde" | "mieter";
  signerRole: string;
  profiles: ProfileOption[];
  isReadOnly: boolean;
  isMaintenance: boolean;
  onTechnicianChange: (id: string, name: string) => void;
  onClientNameChange: (name: string) => void;
  onSignerTypeChange: (t: "kunde" | "mieter") => void;
  onSignerRoleChange: (r: string) => void;
  onTechSignature: (dataUrl: string) => void;
  onClientSignature: (dataUrl: string) => void;
  /** Signed URL der bereits gespeicherten Sig (Vorschau beim Re-Open). */
  techSavedUrl?: string | null;
  clientSavedUrl?: string | null;
}

export function SignaturesSection({
  technicianId,
  clientName,
  signerType,
  signerRole,
  profiles,
  isReadOnly,
  isMaintenance,
  onTechnicianChange,
  onClientNameChange,
  onSignerTypeChange,
  onSignerRoleChange,
  onTechSignature,
  onClientSignature,
  techSavedUrl,
  clientSavedUrl,
}: Props) {
  return (
    <div className="space-y-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Unterschriften</p>
      <div>
        <div className="mb-2">
          <Label>Service-Techniker</Label>
          <select
            value={technicianId}
            onChange={(e) => {
              const sel = profiles.find((p) => p.id === e.target.value);
              onTechnicianChange(e.target.value, sel?.full_name ?? "");
            }}
            disabled={isReadOnly}
            className="mt-1.5 w-full h-9 px-3 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
          >
            <option value="">Techniker auswählen…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name}</option>
            ))}
          </select>
        </div>
        <SignaturePad label="Unterschrift Techniker" onSave={onTechSignature} savedUrl={techSavedUrl} />
      </div>
      {!isMaintenance && (
        <>
          <div className="border-t" />
          <div>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button
                type="button"
                onClick={() => onSignerTypeChange("kunde")}
                className={signerType === "kunde" ? "kasten kasten-red" : "kasten-toggle-off"}
              >
                Kunde / Auftraggeber
              </button>
              <button
                type="button"
                onClick={() => onSignerTypeChange("mieter")}
                className={signerType === "mieter" ? "kasten kasten-red" : "kasten-toggle-off"}
              >
                Mieter vor Ort
              </button>
            </div>
            <div className="mb-2">
              <Label>{signerType === "mieter" ? "Mieter / Person vor Ort" : "Kunde / Auftraggeber"}</Label>
              <Input
                placeholder={signerType === "mieter" ? "Name Mieter vor Ort" : "Name Kunde"}
                value={clientName}
                onChange={(e) => onClientNameChange(e.target.value)}
                className="mt-1.5"
              />
            </div>
            {signerType === "mieter" && (
              <div className="mb-2">
                <Label>Funktion / Rolle (optional)</Label>
                <Input
                  placeholder="z.B. Veranstalter, Produktionsleitung, Regie..."
                  value={signerRole}
                  onChange={(e) => onSignerRoleChange(e.target.value)}
                  className="mt-1.5"
                />
              </div>
            )}
            <SignaturePad label={signerType === "mieter" ? "Unterschrift Mieter vor Ort" : "Unterschrift Kunde"} onSave={onClientSignature} savedUrl={clientSavedUrl} />
          </div>
        </>
      )}
    </div>
  );
}
