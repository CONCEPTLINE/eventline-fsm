"use client";

import { useRef, useState, useEffect } from "react";
import SignatureCanvas from "react-signature-canvas";
import { Button } from "@/components/ui/button";
import { Eraser, Pencil } from "lucide-react";

interface SignaturePadProps {
  label: string;
  onSave: (dataUrl: string) => void;
  /** URL einer bereits gespeicherten Unterschrift (signed URL aus Storage).
   *  Wird als Preview-Bild gezeigt; User kann via 'Neu unterschreiben'
   *  uebermalen oder via 'Löschen' wegmachen. */
  savedUrl?: string | null;
}

export function SignaturePad({ label, onSave, savedUrl }: SignaturePadProps) {
  const sigRef = useRef<SignatureCanvas>(null);
  // Wenn eine gespeicherte Sig vorliegt UND der User sie noch nicht
  // explizit ueberschreiben moechte: Preview-Bild zeigen statt Canvas.
  const [showSaved, setShowSaved] = useState<boolean>(!!savedUrl);
  useEffect(() => {
    setShowSaved(!!savedUrl);
  }, [savedUrl]);

  function handleEnd() {
    if (sigRef.current && !sigRef.current.isEmpty()) {
      onSave(sigRef.current.toDataURL("image/png"));
    }
  }

  function handleClear() {
    sigRef.current?.clear();
    setShowSaved(false);
    onSave("");
  }

  function handleReplace() {
    setShowSaved(false);
    // Canvas erscheint im naechsten Render — sigRef.current ist dann verfuegbar.
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium">{label}</label>
        <Button type="button" variant="outline" size="sm" onClick={handleClear}>
          <Eraser className="h-3.5 w-3.5 mr-1" />Löschen
        </Button>
      </div>
      {showSaved && savedUrl ? (
        <div className="border-2 border-gray-200 rounded-xl overflow-hidden bg-white relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={savedUrl} alt={label} style={{ width: "100%", height: "150px", objectFit: "contain" }} />
          <button
            type="button"
            onClick={handleReplace}
            className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/95 border border-gray-300 text-[11px] font-medium text-gray-700 shadow-sm hover:bg-white"
          >
            <Pencil className="h-3 w-3" />Neu unterschreiben
          </button>
        </div>
      ) : (
        <div className="border-2 border-gray-200 rounded-xl overflow-hidden bg-white">
          <SignatureCanvas
            ref={sigRef}
            canvasProps={{
              className: "w-full",
              style: { width: "100%", height: "150px" },
            }}
            onEnd={handleEnd}
            penColor="#1a1a1a"
            backgroundColor="white"
          />
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-1 text-center">
        {showSaved ? "Gespeicherte Unterschrift — Klick 'Neu unterschreiben' zum ändern" : "Hier unterschreiben"}
      </p>
    </div>
  );
}
