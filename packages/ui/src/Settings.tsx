import { motion } from "motion/react";
import { Icon } from "./icons.js";
import type { ThemePref } from "./theme.js";

const THEMES: { value: ThemePref; label: string; hint: string }[] = [
  { value: "system", label: "Match my computer", hint: "Light by day, dark by night" },
  { value: "light", label: "Light", hint: "Bright and airy" },
  { value: "dark", label: "Dark", hint: "Easy on the eyes" },
];

export function Settings({
  theme,
  onTheme,
}: {
  theme: ThemePref;
  onTheme: (theme: ThemePref, origin: { x: number; y: number }) => void;
}) {
  return (
    <div className="pad settings">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
      </div>

      <section className="setting">
        <h2>Appearance</h2>
        <div className="theme-grid" role="radiogroup" aria-label="Appearance">
          {THEMES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={theme === option.value}
              aria-label={option.label}
              className={`theme-card${theme === option.value ? " on" : ""}`}
              onClick={(event) => onTheme(option.value, { x: event.clientX, y: event.clientY })}
            >
              <span className={`theme-swatch ${option.value}`} aria-hidden="true">
                <span className="sw-side" />
                <span className="sw-main">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
              {theme === option.value ? (
                <motion.span layoutId="theme-check" className="theme-check" transition={{ type: "spring", duration: 0.4, bounce: 0.2 }}>
                  <Icon name="check" size={12} />
                </motion.span>
              ) : null}
            </button>
          ))}
        </div>
      </section>

      <section className="setting">
        <h2>Your privacy</h2>
        <div className="setting-row">
          <div>
            <strong>Everything stays on this computer</strong>
            <span>No account, nothing uploaded. Memories only keeps a list of what’s in your places.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
