import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";

interface TextButtonProps extends Omit<ButtonProps, "children"> {
  children: ReactNode;
  tone?: "neutral" | "primary" | "danger";
}

export function TextButton({ children, tone = "neutral", className = "", ...props }: TextButtonProps) {
  return (
    <Button
      {...props}
      tone={tone}
      className={className}
    >
      {children}
    </Button>
  );
}
