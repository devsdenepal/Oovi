import "bootstrap/dist/css/bootstrap.min.css";
import "./ui/tokens.css";
import "./style.css";
import "./styles/dashboard.scss";
import "./styles/editor.scss";
import { App } from "./app/App";
import { Dashboard } from "./components/Dashboard";
import { initLeftTabs } from "./ui/leftTabs";
import { initToasts } from "./ui/toasts";
import { parseRoute } from "./ui/router";

// NOTE: Bootstrap's JS bundle is intentionally NOT imported | no component
// uses data-bs-* behavior anymore (tabs/accordion replaced by leftTabs and
// native <details>), so the bundle would be dead weight.
initToasts();

const route = parseRoute();

if (route.view === "home") {
  document.getElementById("view-home").hidden = false;
  new Dashboard(document.getElementById("home-mount"));
} else {
  document.getElementById("app").hidden = false;
  // Same-tab back/forward between dashboard and editor reboots cleanly.
  window.addEventListener("hashchange", () => window.location.reload());
  // Interface shell first (chrome only | no pipeline dependency).
  const leftTabs = initLeftTabs({ initial: "reference" });
  const app = new App(
    {
      topbar: "topbar-mount",
      prompt: "prompt-mount",
      generate: "generate-mount",
      designType: "designtype-mount",
      templates: "templates-mount",
      insert: "insert-mount",
      reference: "reference-mount",
      influence: "influence-mount",
      assistant: "assistant-mount",
      debug: "debug-tabs-mount",
      toolbar: "toolbar-mount",
      layers: "layers-mount",
      canvasHolder: "canvas-holder",
      contextbar: "contextbar-mount",
      json: "json-area",
    },
    { leftTabs, projectId: route.id },
  );

  app.boot().catch((error) => {
    console.error(error);
    const status = document.getElementById("gen-status");
    if (status) status.textContent = `Bootstrap failed: ${error.message}`;
  });

  // DEV-only probe handle (mirrors Excalidraw's window.h). import.meta.env.DEV
  // compiles to false in production, so minifiers drop this branch entirely.
  if (import.meta.env.DEV) window.__oovi = { app };
}
