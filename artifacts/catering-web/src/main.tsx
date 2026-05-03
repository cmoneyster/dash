import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "./hooks/useTheme";
import "./index.css";

// Apply persisted theme to <html> before React renders so the first
// paint matches the user's last choice (no light-mode flash).
initTheme();

createRoot(document.getElementById("root")!).render(<App />);
