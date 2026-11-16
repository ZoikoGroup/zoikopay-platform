import type { ReactNode } from "react";

export function Card({ title, eyebrow, actions, children, footer, flush, className = "", id, labelledBy }: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
  labelledBy?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`card ${className}`} aria-labelledby={labelledBy ?? (title ? headingId : undefined)} id={id}>
      {(title || actions) && (
        <header className="card-head">
          <div style={{ display: "grid", gap: 2 }}>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h2 id={headingId}>{title}</h2>}
          </div>
          {actions && <div className="row" style={{ flexWrap: "wrap" }}>{actions}</div>}
        </header>
      )}
      <div className={`card-body${flush ? " flush" : ""}`}>{children}</div>
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  );
}

export function PageHead({ title, screen, description, actions }: {
  title: string;
  screen?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        {screen && <div className="row">{screen}</div>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}
