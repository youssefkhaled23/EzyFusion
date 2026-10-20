import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder for loading data. "stats" = a row of stat cards, "table" = a card with rows, "page" = header + stats + table. */
export function LoadingSkeleton({ variant = "table", rows = 5 }: { variant?: "stats" | "table" | "page"; rows?: number }) {
  const stats = (
    <div className="grid gap-4 sm:grid-cols-2">
      {[0, 1].map((i) => (
        <Card key={i} className="gap-3">
          <Skeleton className="mx-5 h-4 w-32" />
          <Skeleton className="mx-5 h-8 w-20" />
        </Card>
      ))}
    </div>
  );
  const table = (
    <Card className="gap-0 py-0" aria-hidden="true">
      <div className="border-b px-5 py-4"><Skeleton className="h-5 w-40" /></div>
      <div className="space-y-3 p-5">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </Card>
  );
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading">
      <span className="sr-only">Loading…</span>
      {variant !== "table" ? stats : null}
      {variant !== "stats" ? table : null}
    </div>
  );
}
