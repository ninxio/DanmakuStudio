import { X } from "lucide-react";
import { useId, type RefObject, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";

/** One scroll owner for secondary tools; focus and native-video occlusion belong to Dialog. */
export function ToolSheet({
  title,
  open,
  onClose,
  children,
  wide = false,
  initialFocusRef
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}) {
  const titleId = useId();
  if (!open) return null;
  return (
    <Dialog
      initialFocusRef={initialFocusRef}
      ariaLabelledBy={titleId}
      onClose={onClose}
      overlayClassName="tool-sheet-backdrop dialog-backdrop"
      className={`tool-sheet ${wide ? "tool-sheet-wide" : ""}`}
    >
      <header className="tool-sheet-header">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={`关闭${title}`} icon={<X size={18} />} onClick={onClose} />
      </header>
      <div className="tool-sheet-body thin-scrollbar">{children}</div>
    </Dialog>
  );
}
