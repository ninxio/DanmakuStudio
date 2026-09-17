import { Monitor, Moon, Sun } from "lucide-react";
import { useId } from "react";
import { themeController } from "../infrastructure/settings/themePreferences";
import { useTheme } from "./useTheme";

export function ThemeControl() {
  const theme = useTheme();
  const name = useId();
  return (
    <div
      className="theme-control"
      role="group"
      aria-label="外观模式"
      title={theme.persisted ? "外观立即生效" : "外观选择仅本次生效"}
    >
      {(
        [
          { id: "system", label: "跟随系统", icon: Monitor },
          { id: "light", label: "浅色", icon: Sun },
          { id: "dark", label: "深色", icon: Moon }
        ] as const
      ).map(({ id, label, icon: Icon }) => (
        <label key={id} className="theme-choice" title={label}>
          <input
            type="radio"
            name={name}
            value={id}
            aria-label={label}
            checked={theme.preference === id}
            onChange={() => themeController.setPreference(id)}
          />
          <Icon size={15} aria-hidden="true" />
        </label>
      ))}
    </div>
  );
}
