import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  iconLeft,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  iconLeft?: ReactNode;
}) {
  return (
    <button className={`cds-btn cds-btn--${size} cds-btn--${variant} ${className}`} {...props}>
      {iconLeft ? <span className="cds-btn__icon">{iconLeft}</span> : null}
      {children}
    </button>
  );
}

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }
>(function IconButton({ label, size = "md", children, className = "", ...props }, ref) {
  return (
    <button
      ref={ref}
      className={`cds-iconbtn cds-iconbtn--${size} ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
});

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

export function Badge({
  tone = "neutral",
  dot = false,
  mono = false,
  style,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  mono?: boolean;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <span className={`cds-badge cds-badge--${tone}${mono ? " cds-badge--mono" : ""}`} style={style}>
      {dot ? <span className="cds-badge__dot" /> : null}
      {children}
    </span>
  );
}

export function StatusDot({
  status,
  label,
}: {
  status: "ok" | "warn" | "down" | "unknown";
  label: string;
}) {
  return (
    <span className={`cds-status cds-status--${status}`}>
      <span className="cds-status__dot" />
      {label}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="cds-empty">
      <div className="cds-empty__title">{title}</div>
      <div className="cds-empty__desc">{description}</div>
      {action ? <div style={{ marginTop: "var(--space-3)" }}>{action}</div> : null}
    </div>
  );
}
