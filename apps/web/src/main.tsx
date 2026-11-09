import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./i18n/index.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
