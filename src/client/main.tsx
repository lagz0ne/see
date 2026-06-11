import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { StaticShareApp } from "./static-share-app";

const root = document.querySelector<HTMLElement>("#staticShareRoot");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <StaticShareApp root={root} />
    </StrictMode>,
  );
}
