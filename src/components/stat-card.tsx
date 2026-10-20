import type { ComponentType, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "destructive";

const iconTone: Record<Tone, string> = {
  default: "bg-info-subtle text-info-subtle-foreground",
  success: "bg-success-subtle text-success-subtle-foreground",
  warning: "bg-warning-subtle text-warning-subtle-foreground",
  destructive: "bg-destructive-subtle text-destructive-subtle-foreground",
};

type StatCardProps = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  tone?: Tone;
  className?: string;
  valueClassName?: string;
  /** data-testid applied to the value element */
  valueTestId?: string;
  testId?: string;
};

/** One headline figure with a label and an optional explanation. */
export function StatCard({ label, value, hint, icon: Icon, tone = "default", className, valueClassName, valueTestId, testId }: StatCardProps) {
  return (
    <Card className={cn("gap-3", className)} data-testid={testId}>
      <div className="flex items-start justify-between gap-3 px-(--card-spacing)">
        <p className="text-sm font-medium text-muted-foreground-strong">{label}</p>
        {Icon ? (
          <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", iconTone[tone])}>
            <Icon aria-hidden="true" className="size-[18px]" />
          </span>
        ) : null}
      </div>
      <div className="space-y-1 px-(--card-spacing)">
        <p className={cn("text-2xl font-semibold tracking-tight num sm:text-3xl", valueClassName)} data-testid={valueTestId}>{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </Card>
  );
}
