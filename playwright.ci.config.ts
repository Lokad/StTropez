import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// Owner journeys for input/history, navigation, review/save, host lifecycle and wire transport.
// The full multi-engine and package campaigns remain explicit checkpoint commands.
export default defineConfig({ ...base, testMatch: [
    "workspace.spec.ts", "editing.spec.ts", "navigation.spec.ts", "comparison.spec.ts",
    "comparison-ownership.spec.ts", "save-conflicts.spec.ts", "hosts.spec.ts", "protocol-websocket.spec.ts",
    "viewport-decorations.spec.ts", "viewport-geometry.spec.ts", "viewport-paint.spec.ts",
    "text-geometry.spec.ts", "owner-activity.spec.ts", "caret-placement.spec.ts", "viewport-row-retention.spec.ts", "input-context-reuse.spec.ts",
    "host-completion-indentation.spec.ts", "bracket-highlights.spec.ts", "character-warnings.spec.ts", "viewport-presentation.spec.ts", "lsp-interop.spec.ts",
] });
