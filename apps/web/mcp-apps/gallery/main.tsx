import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { GalleryApp } from "./gallery-app";
import "./gallery.css";

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <GalleryApp />
    </StrictMode>,
  );
}
