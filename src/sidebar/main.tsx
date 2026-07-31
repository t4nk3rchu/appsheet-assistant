// src/sidebar/main.tsx
import "../ui.css";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./Sidebar";

// Seed theme before first paint to avoid a light flash in dark mode; Sidebar
// then syncs it to the saved darkMode setting.
document.documentElement.dataset.theme =
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

createRoot(document.getElementById("root")!).render(<Sidebar />);
