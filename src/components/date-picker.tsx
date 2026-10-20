"use client";

import { useRef, useState } from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import type { Matcher } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/format";
import { parseIsoDate, toIsoDate } from "@/lib/date";
import { cn } from "@/lib/utils";

/** Rendered only while the popup is mounted, so the `new Date()` below never runs during prerender. */
function PickerCalendar({
  selected,
  min,
  max,
  disabled,
  onSelect,
}: {
  selected?: Date;
  min?: Date;
  max?: Date;
  disabled: Matcher[];
  onSelect: (date: Date) => void;
}) {
  return (
    <Calendar
      mode="single"
      required
      selected={selected}
      defaultMonth={initialMonth(selected, min, max)}
      startMonth={min}
      endMonth={max}
      disabled={disabled}
      className="p-3 [--cell-size:--spacing(10)]"
      onSelect={onSelect}
    />
  );
}

/**
 * Month shown on open: the selected month, else today's month clamped into [min, max].
 * Only called while the popup is mounted (client, after open), never during prerender.
 */
function initialMonth(selected?: Date, min?: Date, max?: Date): Date {
  if (selected) return selected;
  const today = new Date();
  if (min && today < min) return min;
  if (max && today > max) return max;
  return today;
}

type DatePickerProps = {
  /** Calendar date, YYYY-MM-DD. Empty string means no selection. */
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Inclusive bounds, YYYY-MM-DD. */
  min?: string;
  max?: string;
  /** Show a clear button while a date is selected and the picker is enabled. */
  clearable?: boolean;
  locale?: string;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean | "true" | "false";
};

/**
 * Calendar popover built from shadcn Popover + Calendar (Base UI). Non-modal: the page keeps
 * scrolling and focus returns to the trigger on close. The trigger shares the `field-control` look.
 */
export function DatePicker({
  value,
  onChange,
  id,
  name,
  placeholder = "Select a date",
  disabled = false,
  min,
  max,
  clearable = false,
  locale,
  className,
  ...aria
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const selected = parseIsoDate(value);
  const minDate = parseIsoDate(min);
  const maxDate = parseIsoDate(max);
  const unavailable = [
    ...(minDate ? [{ before: minDate }] : []),
    ...(maxDate ? [{ after: maxDate }] : []),
  ];
  const showClear = clearable && !disabled && selected !== undefined;

  /** Keyboard and pointer users land on a day (selected, else today, else first enabled), not on "previous month". */
  function focusDay() {
    const root = contentRef.current;
    // Separate queries: a selector list would return the first match in DOM order, not the best one.
    return (
      root?.querySelector<HTMLElement>('button[data-selected-single="true"]') ??
      root?.querySelector<HTMLElement>('td[data-today]:not([data-disabled]) button') ??
      root?.querySelector<HTMLElement>('td:not([data-disabled]):not([data-outside]) button') ??
      true
    );
  }

  return (
    <div className={cn("relative w-full", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          disabled={disabled}
          className={cn(
            "field-control flex items-center gap-2 py-2 text-left whitespace-nowrap",
            showClear && "pr-11",
          )}
          {...aria}
        >
          <CalendarIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground-strong" />
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? formatDate(value, locale) : placeholder}
          </span>
        </PopoverTrigger>
        <PopoverContent ref={contentRef} align="start" initialFocus={focusDay} className="w-auto p-0">
          <PickerCalendar
            selected={selected}
            min={minDate}
            max={maxDate}
            disabled={unavailable}
            onSelect={(date) => {
              onChange(toIsoDate(date));
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      {/* Sibling of the trigger, not nested: a button inside a button is invalid. */}
      {showClear ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-0 right-0 text-muted-foreground-strong"
          onClick={() => onChange("")}
        >
          <XIcon aria-hidden="true" />
          <span className="sr-only">Clear date</span>
        </Button>
      ) : null}

      {name ? <input type="hidden" name={name} value={value} /> : null}
    </div>
  );
}
