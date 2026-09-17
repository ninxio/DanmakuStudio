import { useEffect, useState } from "react";
import {
  APP_SETTINGS_CHANGED,
  loadAppSettings
} from "../../infrastructure/settings/appSettings";
import { resolveExportDirectory } from "../../infrastructure/settings/storageClient";

export function useExportDirectory() {
  const [directory, setDirectory] = useState(() => loadAppSettings().export.defaultDirectory);
  const [error, setError] = useState("");
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void resolveExportDirectory(loadAppSettings().export.defaultDirectory)
        .then((path) => {
          if (generation === current) {
            setDirectory(path);
            setError("");
          }
        })
        .catch((e) => {
          if (generation === current) setError(String(e));
        });
    };
    refresh();
    window.addEventListener(APP_SETTINGS_CHANGED, refresh);
    return () => {
      generation++;
      window.removeEventListener(APP_SETTINGS_CHANGED, refresh);
    };
  }, []);
  return { directory, setDirectory, error };
}
