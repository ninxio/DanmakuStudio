import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import "./app/styles.css";
import { themeController } from "./infrastructure/settings/themePreferences";

const stopTheme = themeController.start();
import.meta.hot?.dispose(stopTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
