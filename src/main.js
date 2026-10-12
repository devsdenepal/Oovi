import "./style.css";
import { App } from "./app/App";

const app = new App({
  prompt: "prompt-mount",
  generate: "generate-mount",
  reference: "reference-mount",
  influence: "influence-mount",
  debug: "debug-tabs-mount",
  toolbar: "toolbar-mount",
  layers: "layers-mount",
  canvasHolder: "canvas-holder",
  json: "json-area",
});

app.boot().catch((error) => {
  console.error(error);
  const status = document.getElementById("gen-status");
  if (status) status.textContent = `Bootstrap failed: ${error.message}`;
});