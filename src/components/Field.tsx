import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { TextInput } from "./TextInput";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  suffix?: ReactNode;
}

export function Field({ label, suffix, className = "", ...props }: FieldProps) {
  const generatedId = useId();
  const inputId = props.id ?? generatedId;
  return (
    <label className="grid gap-1 text-ui-helper text-content-muted" htmlFor={inputId}>
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <TextInput
          {...props}
          id={inputId}
          aria-label={props["aria-label"] ?? label}
          className={`flex-1 ${className}`}
        />
        {suffix ? <span className="text-content-subtle">{suffix}</span> : null}
      </span>
    </label>
  );
}
