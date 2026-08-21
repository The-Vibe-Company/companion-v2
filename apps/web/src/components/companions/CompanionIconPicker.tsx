import { useState } from "react";

/* "shape" is the icon catalog's domain term. */
/* oxlint-disable anti-slop/no-shape-in-symbol-names */
import {
  CompanionIcon,
  COMPANION_ICON_COLOR_COUNT,
  COMPANION_ICON_SHAPE_COUNT,
} from "./CompanionIcon";

const MOUTH_LABELS = ["None", "Smile", "Oh!", "Cat", "Grin"];
const ACCESSORY_LABELS = ["None", "Antenna", "Halo", "Crown", "Bow", "Headphones", "Star"];
const COLOR_SWATCHES = [
  "#F2F2F0",
  "#8A6A4F",
  "#E04B44",
  "#F08A24",
  "#F2B01E",
  "#3FA95C",
  "#2FA98C",
  "#3D7BF2",
  "#8B5CF6",
  "#E0559F",
  "#9AA0A6",
];

export type CompanionIconValue = {
  shape: number;
  mouth: number;
  accessory: number;
  color: number;
};

/** A fresh random icon, used as the starting point so creation needs zero choices. */
export function randomIcon(): CompanionIconValue {
  return {
    shape: Math.floor(Math.random() * COMPANION_ICON_SHAPE_COUNT),
    mouth: Math.floor(Math.random() * MOUTH_LABELS.length),
    accessory: Math.floor(Math.random() * ACCESSORY_LABELS.length),
    color: Math.floor(Math.random() * COLOR_SWATCHES.length),
  };
}

/**
 * Icon creator for one Companion (THE-382). Collapsed by default: one big randomized bot, with a
 * reroll beside it. Clicking the bot opens the full catalogs — shape, mouth, accessory, color —
 * so creation stays fast and customization stays opt-in. Everything is a small index into fixed
 * catalogs, so there is no upload and nothing free-form to validate.
 */
export function CompanionIconPicker({
  value,
  onChange,
}: {
  value: CompanionIconValue;
  onChange: (next: CompanionIconValue) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!expanded) {
    return (
      <div className="companions-icon-picker">
        <div className="companions-icon-picker__collapsed">
          <button
            type="button"
            className="companions-icon-picker__face"
            aria-expanded={false}
            aria-label="Customize this icon"
            title="Click to customize"
            onClick={() => setExpanded(true)}
          >
            <CompanionIcon icon={value} size={56} state="thinking" />
          </button>
          <button
            type="button"
            className="companions-icon-picker__chip"
            onClick={() => onChange(randomIcon())}
          >
            Randomize
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="companions-icon-picker">
      <div className="companions-icon-picker__preview" aria-hidden="true">
        <CompanionIcon icon={value} size={56} state="thinking" />
      </div>

      <fieldset className="companions-icon-picker__group">
        <legend>Shape</legend>
        <div className="companions-icon-picker__grid">
          {Array.from({ length: COMPANION_ICON_SHAPE_COUNT }, (_, shape) => (
            <button
              key={shape}
              type="button"
              aria-pressed={value.shape === shape}
              className={`companions-icon-picker__option${value.shape === shape ? " is-selected" : ""}`}
/* "shape" is the icon catalog's domain term. */
// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
              onClick={() => onChange({ ...value, shape })}
            >
              <CompanionIcon icon={{ ...value, shape }} size={40} state="idle" />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="companions-icon-picker__group">
        <legend>Mouth</legend>
        <div className="companions-icon-picker__chips">
          {MOUTH_LABELS.map((label, mouth) => (
            <button
              key={mouth}
              type="button"
              aria-pressed={value.mouth === mouth}
              className={`companions-icon-picker__chip${value.mouth === mouth ? " is-selected" : ""}`}
              onClick={() => onChange({ ...value, mouth })}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="companions-icon-picker__group">
        <legend>Accessory</legend>
        <div className="companions-icon-picker__chips">
          {ACCESSORY_LABELS.map((label, accessory) => (
            <button
              key={accessory}
              type="button"
              aria-pressed={value.accessory === accessory}
              className={`companions-icon-picker__chip${value.accessory === accessory ? " is-selected" : ""}`}
              onClick={() => onChange({ ...value, accessory })}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="companions-icon-picker__group">
        <legend>Color</legend>
        <div className="companions-icon-picker__swatches">
          {COLOR_SWATCHES.slice(0, COMPANION_ICON_COLOR_COUNT).map((hex, color) => (
            <button
              key={hex}
              type="button"
              aria-pressed={value.color === color}
              aria-label={`Color ${color + 1}`}
              className={`companions-icon-picker__swatch${value.color === color ? " is-selected" : ""}`}
              style={{ background: hex }}
              onClick={() => onChange({ ...value, color })}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
