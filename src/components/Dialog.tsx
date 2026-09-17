import {
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { useNativeVideoObstruction } from "./useNativeVideoObstruction";

const dialogStack: HTMLElement[] = [];
const isTopDialog = (dialog: HTMLElement | null) => dialogStack.at(-1) === dialog;

interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-label"> {
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusRef?: RefObject<HTMLElement>;
  overlayClassName?: string;
  testId?: string;
  closeOnEscape?: boolean;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function Dialog({
  children,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  initialFocusRef,
  returnFocusRef,
  overlayClassName = "dialog-backdrop",
  className = "",
  testId,
  closeOnEscape = true,
  onKeyDownCapture,
  ...props
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  useNativeVideoObstruction(overlayRef);
  const returnTargetRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    returnTargetRef.current = returnFocusRef?.current ?? getActiveElement();
    const dialog = dialogRef.current;
    if (dialog) dialogStack.push(dialog);
    const requestedInitialFocus = initialFocusRef?.current;
    if (requestedInitialFocus && dialog?.contains(requestedInitialFocus)) {
      requestedInitialFocus.focus();
    } else {
      const firstFocusable = getFocusableElements(dialog)[0];
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        dialog?.focus();
      }
    }
    return () => {
      const wasTop = isTopDialog(dialog);
      if (dialog) dialogStack.splice(dialogStack.indexOf(dialog), 1);
      if (wasTop && returnTargetRef.current?.isConnected) returnTargetRef.current.focus();
    };
  }, [initialFocusRef, returnFocusRef]);

  useEffect(() => {
    if (!closeOnEscape) {
      return;
    }
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || !isTopDialog(dialogRef.current)) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [closeOnEscape, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const ownerDocument = dialog?.ownerDocument;
    if (!dialog || !ownerDocument) {
      return;
    }
    const containDocumentTab = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key === "Tab" &&
        isTopDialog(dialog) &&
        !dialog.contains(dialog.ownerDocument.activeElement)
      ) {
        containTabWithinDialog(event, dialog);
      }
    };
    ownerDocument.addEventListener("keydown", containDocumentTab, true);
    return () => ownerDocument.removeEventListener("keydown", containDocumentTab, true);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || !isTopDialog(dialogRef.current)) {
      return;
    }
    // Menus inside a dialog own their dismissal before the surrounding tool does.
    if (
      event.key === "Escape" &&
      event.target instanceof Element &&
      event.target.closest('[role="menu"]')
    )
      return;
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    if (dialogRef.current) {
      containTabWithinDialog(event, dialogRef.current);
    }
  };

  return (
    <div
      ref={overlayRef}
      role="presentation"
      data-testid={testId}
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${overlayClassName}`}
    >
      <div
        {...props}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={`dialog-surface min-h-0 rounded-dialog border border-boundary bg-surface-base shadow-2xl ${className}`}
        onKeyDownCapture={onKeyDownCapture}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if (element.tabIndex < 0 || element.closest('[hidden], [inert], [aria-hidden="true"]'))
        return false;
      const closedDetails = element.closest("details:not([open])");
      if (closedDetails && !closedDetails.querySelector(":scope > summary")?.contains(element))
        return false;
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      return style?.display !== "none" && style?.visibility !== "hidden";
    }
  );
}

function containTabWithinDialog(
  event: Pick<globalThis.KeyboardEvent, "preventDefault" | "shiftKey">,
  dialog: HTMLElement
): void {
  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = dialog.ownerDocument.activeElement;
  if (!dialog.contains(activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
    return;
  }
  if (event.shiftKey && (activeElement === first || activeElement === dialog)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function getActiveElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
