import { Skeleton } from "@/components/ui/skeleton";

/** Live-Dokument-Skeleton: Kopfleiste + weisses Blatt in der Mitte. CLAUDE.md §7. */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10" />
      <Skeleton className="mx-auto h-[70vh] w-full max-w-[794px]" />
    </div>
  );
}
