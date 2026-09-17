import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Button } from "./Button";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  active?: boolean;
  danger?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, active = false, danger = false, className = "", ...props },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      tone={active ? "primary" : danger ? "danger" : "neutral"}
      size="icon"
      title={props.title ?? label}
      aria-label={label}
      className={className}
    >
      {icon}
    </Button>
  );
});
