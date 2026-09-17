import { useEffect, useState } from "react";
import {
  APP_SETTINGS_CHANGED,
  loadAppSettings
} from "../../infrastructure/settings/appSettings";

/** Settings change only on explicit persistence, never during a playback tick. */
export function usePlaybackSettings() {
  const [settings, setSettings] = useState(loadAppSettings);
  useEffect(() => {
    const update = () => setSettings(loadAppSettings());
    window.addEventListener(APP_SETTINGS_CHANGED, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return settings;
}
