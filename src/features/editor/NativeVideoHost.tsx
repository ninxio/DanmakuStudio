import type { ReactNode } from "react";

interface NativeVideoHostProps {
  accessibleLabel: string;
  children: ReactNode;
  onHostRef: (element: HTMLDivElement | null) => void;
}

export function NativeVideoHost({
  accessibleLabel,
  children,
  onHostRef
}: NativeVideoHostProps) {
  return (
    <div
      ref={onHostRef}
      className="native-video-surface pointer-events-none h-full min-h-0 w-full select-none overflow-hidden bg-black"
      role="img"
      aria-label={accessibleLabel}
      draggable={false}
    >
      <div className="flex h-full items-center justify-center px-4 text-center text-xs leading-5 text-white/75">
        {children}
      </div>
    </div>
  );
}
