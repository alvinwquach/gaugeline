import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./Shell";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element.");
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
