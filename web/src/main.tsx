import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { Issue } from "./catalogue";
import "photoswipe/style.css";
import "./styles.css";

if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");

const res = await fetch("/pages/manifest.json", { credentials: "same-origin" });
if (res.status === 401) location.href = "/login";
const { issues } = (await res.json()) as { issues: Issue[] };

createRoot(document.getElementById("root")!).render(<App issues={issues} />);
