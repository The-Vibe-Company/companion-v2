"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { Avatar, EmojiPicker, LOGO_COLORS } from "../onboarding/screens";
import { hashColor, initialsOf } from "@/lib/settingsViewModel";
import { PaneHead, EditField } from "./paneKit";
import { Dialog, RoleDot } from "./primitives";
import { TEAM_ROLES } from "./roles";
import type { OrgCtx, OrgTeam } from "./model";

/** Org admins and this team's own admins can edit team identity + membership. */
export function teamManageable(ctx: OrgCtx, team: OrgTeam): boolean {
  if (ctx.canManage) return true;
  const mine = team.members.find((m) => m.userId === ctx.myId);
  return !!(mine && mine.role === "admin");
}

/** Team › General — identity, description, details, and a real danger-zone delete. */
export function TeamGeneralPane({ ctx, team }: { ctx: OrgCtx; team: OrgTeam }) {
  const [confirm, setConfirm] = useState(false);
  const [picker, setPicker] = useState(false);
  const [desc, setDesc] = useState(team.description);
  useEffect(() => setDesc(team.description), [team.id, team.description]);
  const manage = teamManageable(ctx, team);
  const mine = team.members.find((m) => m.userId === ctx.myId);
  const descDirty = desc.trim() !== team.description;
  const teamColor = team.color ?? hashColor(team.name);
  const teamInitial = initialsOf(team.name);

  const avatar = (
    <Avatar size="lg" color={teamColor} initial={teamInitial} emoji={team.icon ?? undefined} ring={false} />
  );

  return (
    <div className="sx-pane">
      <PaneHead
        title={team.name}
        desc="Team identity and configuration. Teams group members and scope which skills they can reach."
      />

      <div className="sx-profile sx-profile--team">
        {manage ? (
          <div className="sx-profile__pick">
            <button
              type="button"
              className="ob-emoji-trigger"
              onClick={() => setPicker((open) => !open)}
              aria-label="Choose a team icon"
              title="Choose an icon"
            >
              {avatar}
              <span className="ob-emoji-edit">
                <Icon name={team.icon ? "pencil" : "smile-plus"} size={12} />
              </span>
            </button>
            {picker && (
              <EmojiPicker
                value={team.icon ?? undefined}
                onPick={(icon) => {
                  ctx.updateTeam(team.id, { icon });
                  setPicker(false);
                }}
                onClose={() => setPicker(false)}
              />
            )}
          </div>
        ) : (
          <span className="sx-profile__av sx-profile__av--team">{avatar}</span>
        )}
        <div className="sx-profile__meta">
          <div className="sx-profile__name">{team.name}</div>
          <div className="sx-profile__email">
            {team.members.length} member{team.members.length === 1 ? "" : "s"} · team/{team.slug}
          </div>
        </div>
      </div>

      {manage && (
        <div className="sx-field sx-field--compact">
          <label className="sx-field__label">Team color</label>
          <div className="ob-swatches">
            {LOGO_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={"ob-swatch" + (teamColor === color ? " is-sel" : "")}
                style={{ background: color }}
                aria-label="Team color"
                aria-pressed={teamColor === color}
                onClick={() => ctx.updateTeam(team.id, { color })}
              />
            ))}
          </div>
          <span className="sx-field__hint">Tints the team icon and sidebar badge.</span>
        </div>
      )}

      {!manage && (
        <div className="og-lockbar">
          <Icon name="lock" size={13} />
          You&rsquo;re a {mine ? mine.role : "non"}-member here. Only org admins or this team&rsquo;s
          admins can edit it.
        </div>
      )}

      <EditField
        label="Team name"
        hint="Shown in the sidebar, member lists, and skill scopes."
        value={team.name}
        locked={!manage}
        onSave={(n) => ctx.updateTeam(team.id, { name: n })}
      />

      <EditField
        label="Identifier"
        mono
        prefix="team/"
        placeholder="platform"
        hint="Used to scope skills (e.g. team/platform) and in the API. Lowercase letters, numbers, and dashes."
        value={team.slug}
        locked={!manage}
        onSave={(s) =>
          ctx.updateTeam(team.id, { slug: s.toLowerCase().replace(/[^a-z0-9-]/g, "-") })
        }
      />

      <div className="sx-field">
        <label className="sx-field__label">Description</label>
        <textarea
          className="sx-input"
          style={{ height: 72, padding: "9px 12px", resize: "vertical", lineHeight: 1.5 }}
          value={desc}
          readOnly={!manage}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What this team is responsible for"
        />
        <span className="sx-field__hint">A short summary shown on the team overview.</span>
        {manage && descDirty && (
          <div className="sx-row-actions">
            <button className="btn-primary" onClick={() => ctx.updateTeam(team.id, { description: desc.trim() })}>
              <Icon name="check" size={14} />
              Save
            </button>
            <button className="btn-sec" onClick={() => setDesc(team.description)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h">Details</h2>
        <div className="sx-defs">
          <div className="sx-def">
            <span className="sx-def__k">Team id</span>
            <span className="sx-def__v mono">{team.id}</span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Skill scope</span>
            <span className="sx-def__v mono">team/{team.slug}</span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Members</span>
            <span className="sx-def__v">{team.members.length}</span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Your role</span>
            <span className="sx-def__v">
              {mine ? (
                <>
                  <RoleDot role={mine.role} /> {TEAM_ROLES[mine.role]?.label ?? mine.role}
                </>
              ) : (
                <span style={{ color: "var(--color-faint)" }}>Not a member</span>
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h" style={{ color: "var(--color-danger)" }}>
          Danger zone
        </h2>
        <div className="sx-danger">
          <div className="sx-danger__row">
            <div className="sx-danger__txt">
              <div className="sx-danger__t">Delete team</div>
              <div className="sx-danger__d">
                Remove {team.name} and unscope its skills. Members keep their workspace access. This
                cannot be undone.
              </div>
            </div>
            <button
              className="btn-danger"
              disabled={!ctx.canManage}
              title={ctx.canManage ? "" : "Only org owners and admins can delete teams"}
              onClick={() => setConfirm(true)}
            >
              <Icon name="trash-2" size={14} />
              Delete team
            </button>
          </div>
        </div>
      </div>

      {confirm && (
        <Dialog
          icon="alert-triangle"
          iconDanger
          title={"Delete " + team.name + "?"}
          desc={
            "Skills scoped to team/" +
            team.slug +
            " will lose their scope. Members are not removed from the workspace."
          }
          onClose={() => setConfirm(false)}
          foot={
            <>
              <span className="og-spacer" />
              <button className="btn-sec" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn-danger--solid btn-danger"
                onClick={() => {
                  setConfirm(false);
                  ctx.deleteTeam(team.id);
                }}
              >
                <Icon name="trash-2" size={14} />
                Delete team
              </button>
            </>
          }
        >
          <div
            className="sx-readline"
            style={{
              borderColor: "var(--color-danger-line)",
              background: "var(--color-danger-tint)",
              color: "var(--color-danger)",
            }}
          >
            <Icon name="alert-triangle" size={14} />
            {team.members.length} member{team.members.length === 1 ? "" : "s"} will be unassigned from
            this team.
          </div>
        </Dialog>
      )}
    </div>
  );
}
