import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SectionCardProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** Remove the body padding so a table can run edge to edge. */
  flush?: boolean;
  id?: string;
  className?: string;
  testId?: string;
};

/** A titled card: header row (title, description, optional action) and a body. */
export function SectionCard({ title, description, action, children, flush, id, className, testId }: SectionCardProps) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <Card className={cn("gap-0 py-0", className)} data-testid={testId}>
      <section id={id} aria-labelledby={headingId}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 md:px-6">
          <div className="min-w-0 space-y-0.5">
            <h2 id={headingId} className="text-base font-semibold tracking-tight">{title}</h2>
            {description ? <p className="text-sm text-muted-foreground-strong">{description}</p> : null}
          </div>
          {action ? <div className="flex items-center gap-2">{action}</div> : null}
        </div>
        <div className={cn(flush ? "" : "p-5 md:p-6")}>{children}</div>
      </section>
    </Card>
  );
}
