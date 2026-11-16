import { X } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss, useFocusTrap } from "../hooks/ui";

/** Side drawer for record details and evidence. Modal: focus is trapped; Escape closes. */
export function Drawer({ title, subtitle, onClose, children, footer }: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, true);
  useDismiss(ref, true, onClose);
  return createPortal(
    <>
      <div className="overlay" aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={ref} tabIndex={-1}>
        <header className="drawer-head">
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <h2 id={`${id}-t`} style={{ overflowWrap: "anywhere" }}>{title}</h2>
            {subtitle && <div className="subtle" style={{ fontSize: "var(--fs-xs)" }}>{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close details">
            <X size={16} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-foot">{footer}</footer>}
      </div>
    </>,
    document.body,
  );
}

/** Confirmation dialog for sensitive actions. */
export function Dialog({ title, description, onClose, children, footer }: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, true);
  useDismiss(ref, true, onClose);
  return createPortal(
    <>
      <div className="overlay" style={{ zIndex: 69 }} aria-hidden="true" />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={description ? `${id}-d` : undefined} ref={ref}>
        <div className="dialog-head">
          <h2 id={`${id}-t`}>{title}</h2>
          {description && <p id={`${id}-d`} className="muted" style={{ fontSize: "var(--fs-sm)" }}>{description}</p>}
        </div>
        {children && <div className="dialog-body">{children}</div>}
        <div className="dialog-foot">{footer}</div>
      </div>
    </>,
    document.body,
  );
}
