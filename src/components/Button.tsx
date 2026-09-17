import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonTone = "neutral" | "primary" | "danger" | "unstyled";
export type ButtonSize = "small" | "medium" | "large" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  tone?: ButtonTone;
  size?: ButtonSize;
  disabledReason?: string;
}

const TONE_CLASSES: Record<ButtonTone, string> = {
  primary:
    "border-transparent bg-primary text-on-primary enabled:hover:bg-primary/90 enabled:active:bg-primary/80",
  danger:
    "border-feedback-danger/25 bg-feedback-danger/10 text-feedback-danger enabled:hover:bg-feedback-danger/15 enabled:active:bg-feedback-danger/25",
  neutral:
    "border-boundary bg-surface-base text-content-secondary enabled:hover:border-boundary-strong enabled:hover:bg-surface-soft enabled:active:bg-primary-container",
  unstyled: ""
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  small: "h-control-sm px-2 text-ui-helper",
  medium: "h-control px-3 text-ui-body",
  large: "h-control-lg px-3 text-ui-body",
  icon: "h-control w-control p-0 text-ui-body"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    tone = "neutral",
    size = "medium",
    disabledReason,
    className = "",
    disabled,
    title,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  ref
) {
  const generatedReasonId = useId();
  const reasonId = disabled && disabledReason ? generatedReasonId : undefined;
  const describedBy = [ariaDescribedBy, reasonId].filter(Boolean).join(" ") || undefined;
  const baseClass =
    tone === "unstyled"
      ? "ui-button"
      : "ui-button inline-flex items-center justify-center gap-2 rounded-control border font-medium disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <button
      {...props}
      ref={ref}
      type={props.type ?? "button"}
      disabled={disabled}
      data-tone={tone}
      title={disabled && disabledReason ? disabledReason : title}
      aria-describedby={describedBy}
      className={`${baseClass} ${TONE_CLASSES[tone]} ${tone === "unstyled" ? "" : SIZE_CLASSES[size]} ${className}`}
    >
      {children}
      {reasonId ? (
        <span id={reasonId} className="sr-only" aria-hidden="true">
          {disabledReason}
        </span>
      ) : null}
    </button>
  );
});
