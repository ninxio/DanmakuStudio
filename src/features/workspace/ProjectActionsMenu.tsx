import { useNativeVideoObstruction } from "../../components/useNativeVideoObstruction";
import { ChevronDown, Folder } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** A native disclosure: ordinary Tab order, outside dismissal, Escape and focus return. */
export function ProjectActionsMenu({ name, children }: { name: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useNativeVideoObstruction(popoverRef, open);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        ref.current?.open &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      )
        ref.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ref.current?.open || event.defaultPrevented) return;
      event.preventDefault();
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details
      ref={ref}
      className="project-actions-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="项目菜单" title={name}>
        <Folder size={17} className="shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate">{name}</span>
        <ChevronDown size={14} className="ml-auto shrink-0" aria-hidden="true" />
      </summary>
      <div
        ref={popoverRef}
        className="project-actions-popover"
        role="group"
        aria-label="项目操作"
        data-native-video-obstruction="true"
        onClick={(event) => {
          if ((event.target as Element).closest("button:enabled") && ref.current) {
            ref.current.open = false;
            ref.current.querySelector("summary")?.focus();
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}
