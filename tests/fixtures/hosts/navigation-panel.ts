import type { HostNavigationTools, NavigationSnapshot } from "./navigation.ts";
import { createToolPanel } from "./tool-panel.ts";
type NavigationPanelTools = Pick<HostNavigationTools, "findDefinition" | "findReferences" | "returnToOrigin" | "addCompanion">;

export function navigationPanelModel(tools: NavigationPanelTools, state: NavigationSnapshot) {
    const pending = state.status === "pending";
    return {
        title: "Symbol navigation", status: { label: "Symbol navigation status", text: state.message },
        actions: [
            { label: "Find definition", invoke: tools.findDefinition, disabled: !state.available || pending },
            { label: "Find references", invoke: tools.findReferences, disabled: !state.available || pending },
            { label: "Return to navigation origin", invoke: tools.returnToOrigin, disabled: !state.canReturn },
            { label: "Add navigation companion", invoke: tools.addCompanion, disabled: pending },
        ],
    } as const;
}
export function mountNavigationPanel(host: HTMLElement, tools: HostNavigationTools): () => void {
    const { controls, mount } = createToolPanel(host, tools.state, state => navigationPanelModel(tools, state));
    return mount([controls], () => {});
}
