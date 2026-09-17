import { useId, useRef, type ReactNode } from "react";

/** A task view selector: arrows/Home/End select and focus, Tab enters the current workspace. */
export function WorkspaceTabs<T extends string>({
  label,
  value,
  items,
  onChange
}: {
  label: string;
  value: T;
  items: readonly { id: T; label: string; count?: number; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  return (
    <div className="workspace-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          type="button"
          key={item.id}
          id={`${id}-${item.id}`}
          role="tab"
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          ref={(element) => {
            if (element) refs.current.set(item.id, element);
            else refs.current.delete(item.id);
          }}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            const nextIndex =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : null;
            if (nextIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            const next = items[nextIndex];
            onChange(next.id);
            refs.current.get(next.id)?.focus();
          }}
        >
          {item.icon}
          {item.label}
          {item.count !== undefined && <span className="tab-count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}
