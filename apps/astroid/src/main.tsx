import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

import App from "./app";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
