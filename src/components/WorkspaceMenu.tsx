import { ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { useNativeVideoObstruction } from "./useNativeVideoObstruction";

/** Action menus own popup placement, keyboard navigation, dismissal and native-video shielding. */
export function WorkspaceMenu({
  label,
  items,
  icon,
  primary = false
}: {
  label: string;
  icon?: ReactNode;
  primary?: boolean;
  items: readonly {
    id: string;
    label: string;
    onSelect: () => void;
    disabled?: boolean;
    danger?: boolean;
    icon?: ReactNode;
  }[];
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useNativeVideoObstruction(menu, open);
  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      const popup = menu.current?.getBoundingClientRect();
      if (box && popup)
        setPosition({
          left: Math.max(12, Math.min(box.left, innerWidth - popup.width - 12)),
          top:
            box.bottom + popup.height + 12 > innerHeight
              ? Math.max(12, box.top - popup.height - 6)
              : box.bottom + 6
        });
    };
    place();
    (
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu.current
    )?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    const leave = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", leave);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", leave);
    };
  }, [open]);
  return (
    <>
      <Button
        ref={trigger}
        tone={primary ? "primary" : "neutral"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        {icon}
        {label}
        <ChevronDown size={13} />
      </Button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            tabIndex={-1}
            role="menu"
            aria-label={label}
            className="workspace-menu"
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
              }
              if (event.key === "Tab") {
                close(true);
                return;
              }
              const buttons = Array.from(
                menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
              );
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "ArrowDown"
                  ? (current + 1) % buttons.length
                  : event.key === "ArrowUp"
                    ? (current + buttons.length - 1) % buttons.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                event.stopPropagation();
                buttons[next]?.focus();
              }
            }}
          >
            {items.map((item) => (
              <Button
                key={item.id}
                role="menuitem"
                tabIndex={-1}
                tone="unstyled"
                disabled={item.disabled}
                className={item.danger ? "text-feedback-danger" : ""}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </Button>
            ))}
          </div>,
          trigger.current?.closest('[role="dialog"]') ?? document.body
        )}
    </>
  );
}
