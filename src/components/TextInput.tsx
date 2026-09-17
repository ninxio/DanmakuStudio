import { forwardRef, type InputHTMLAttributes } from "react";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = "", ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={`h-control min-w-0 rounded-control border border-boundary bg-surface-inset px-2 text-ui-body text-content-primary placeholder:text-content-subtle disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      />
    );
  },
);
