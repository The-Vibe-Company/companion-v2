"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

function classes(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

/** Shared compact heading for full-height resource lists. */
export function ResourceListHeader({
  title,
  count,
  headingLevel = 2,
  beforeTitle,
  action,
  className,
}: {
  title: string;
  count: number;
  headingLevel?: 1 | 2;
  beforeTitle?: ReactNode;
  action: ReactNode;
  className?: string;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <header className={classes("sh", className)}>
      {beforeTitle}
      <Heading className="sh__title">{title}</Heading>
      <span className="sh__count tnum">{count}</span>
      <span className="sh__spacer" />
      {action}
    </header>
  );
}

/** Shared search toolbar; callers may add resource-specific controls after the spacer. */
export function ResourceListToolbar({
  value,
  onChange,
  placeholder,
  ariaLabel,
  children,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes("listbar", className)}>
      <span className="listbar__search">
        <Icon name="search" size={14} />
        <input
          className="listbar__input"
          type="search"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={ariaLabel}
        />
      </span>
      <span className="listbar__spacer" />
      {children}
    </div>
  );
}

/** Scrollable list body plus an optional sibling panel or overlay. */
export function ResourceListFrame({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className="clistrow">
      <div className={classes("clist", className)}>{children}</div>
      {aside}
    </div>
  );
}

/** Column labels for a resource table. Row grids remain resource-specific. */
export function ResourceListColumns({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={classes("chead", className)} style={style}>{children}</div>;
}

export function ResourceListEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: string;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes("empty", className)}>
      <Icon name={icon} size={22} style={{ color: "var(--color-faint)" }} />
      <div className="empty__title">{title}</div>
      <div className="empty__desc">{description}</div>
      {action}
    </div>
  );
}
