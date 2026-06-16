"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { TeamAvatar } from "../org/TeamAvatar";
import type { TeamVM } from "@/lib/types";
import { VISIBILITY_ICON, VISIBILITY_ORDER } from "./blocks";
import type { Filter } from "./filters";

const VISIBILITY_LABEL: Record<string, string> = {
  everyone: "Everyone",
  team: "Team shares",
  private: "Private",
};

function FilterMenuPopover({
  owners,
  teams,
  filters,
  onToggle,
  onClose,
}: {
  owners: string[];
  teams: TeamVM[];
  filters: Filter[];
  onToggle: (type: Filter["type"], value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [onClose]);

  const has = (type: string, value: string) =>
    filters.some((f) => f.type === type && f.value === value);
  const Item = ({
    type,
    value,
    icon,
    label,
    avatar,
  }: {
    type: Filter["type"];
    value: string;
    icon: string;
    label: string;
    avatar?: React.ReactNode;
  }) => (
    <button className="fmenu__item" onClick={() => onToggle(type, value)}>
      {avatar ?? (
        <span className="ico">
          <Icon name={icon} size={14} />
        </span>
      )}
      <span className="lbl">{label}</span>
      {has(type, value) && (
        <span className="chk">
          <Icon name="check" size={13} />
        </span>
      )}
    </button>
  );

  return (
    <div className="fmenu" ref={ref} role="menu">
      <div className="fmenu__grouphead">Dependencies</div>
      <Item type="deps" value="has" icon="package" label="Has dependencies" />
      <Item type="deps" value="used" icon="corner-down-right" label="Used as dependency" />
      <div className="fmenu__divider" />
      <div className="fmenu__grouphead">Visibility</div>
      {VISIBILITY_ORDER.map((v) => (
        <Item
          key={v}
          type="visibility"
          value={v}
          icon={VISIBILITY_ICON[v] ?? "circle"}
          label={VISIBILITY_LABEL[v] ?? v}
        />
      ))}
      <div className="fmenu__divider" />
      <div className="fmenu__grouphead">Status</div>
      <Item type="status" value="valid" icon="check" label="valid" />
      <Item type="status" value="validating" icon="loader" label="validating" />
      <Item type="status" value="invalid" icon="alert-triangle" label="invalid" />
      <div className="fmenu__divider" />
      <div className="fmenu__grouphead">Stars</div>
      <Item type="starred" value="true" icon="star" label="starred" />
      {teams.length > 0 && (
        <>
          <div className="fmenu__divider" />
          <div className="fmenu__grouphead">Teams</div>
          {teams.map((tm) => (
            <Item
              key={tm.id}
              type="team"
              value={tm.id}
              icon="users"
              label={tm.name}
              avatar={<TeamAvatar team={tm} className="ico fmenu__teamav" />}
            />
          ))}
        </>
      )}
      {owners.length > 0 && (
        <>
          <div className="fmenu__divider" />
          <div className="fmenu__grouphead">Owner</div>
          {owners.map((o) => (
            <Item key={o} type="owner" value={o} icon="user" label={o} />
          ))}
        </>
      )}
    </div>
  );
}

export function FilterAdd({
  owners,
  teams,
  filters,
  onToggle,
}: {
  owners: string[];
  teams: TeamVM[];
  filters: Filter[];
  onToggle: (type: Filter["type"], value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="filter-add-wrap">
      <button
        className="filter-add"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="plus" size={13} />
        Filter
      </button>
      {open && (
        <FilterMenuPopover
          owners={owners}
          teams={teams}
          filters={filters}
          onToggle={onToggle}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
