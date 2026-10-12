import "bootstrap/dist/css/bootstrap.min.css";
import "./ui/tokens.css";
import "./style.css";
import { App } from "./app/App";
import { initLeftTabs } from "./ui/leftTabs";
import { initToasts } from "./ui/toasts";

// NOTE: Bootstrap's JS bundle is intentionally NOT imported — no component
// uses data-bs-* behavior anymore (tabs/accordion replaced by leftTabs and
// native <details>), so the bundle would be dead weight.
initToasts();
const leftTabs = initLeftTabs();

const app = new App(
  {
    topbar: "topbar-mount",
    prompt: "prompt-mount",
    generate: "generate-mount",
    designType: "designtype-mount",
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
  { leftTabs },
);

app.boot().catch((error) => {
  console.error(error);
  const status = document.getElementById("gen-status");
  if (status) status.textContent = `Bootstrap failed: ${error.message}`;
});
