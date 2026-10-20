import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-control h-auto min-h-24 resize-y py-2.5 placeholder:text-subtle-text",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
