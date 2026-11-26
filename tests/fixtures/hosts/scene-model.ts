import type { DocumentId } from "../../../src/index.ts";
import type { HostController } from "./controller.ts";
import type { HostPane, Layout } from "./layout.ts";

/** Shared eligibility and identity; each host keeps its own rendering/lifecycle mechanism. */
export function hostSceneModel(layout: Layout, pane: HostPane | undefined, documentReady: boolean, source: DocumentId) {
    const paneKey = pane?.generation ?? "";
    const primary = layout.visible && !layout.formFault && layout.primarySurface === "text" && pane?.documentId != null && documentReady;
    return {
        key: `${layout.position}:${layout.visible}:${layout.formFault}:${layout.primarySurface}:${paneKey}:${documentReady}`,
        position: layout.position, fault: layout.formFault,
        primaryKey: primary ? `primary:${paneKey}` : undefined,
        placeholder: layout.visible && !layout.formFault && !primary ? layout.primarySurface : undefined,
        secondary: layout.visible && !layout.formFault,
        reviewKey: primary && layout.navigation.kind === "review" && pane.documentId === source ? String(paneKey) : undefined,
        message: layout.modal.kind === "error" ? layout.modal.message : layout.modal.kind === "close" ? "Close the captured tab?" : "",
    };
}

export function readHostScene(controller: HostController, layout: Layout) {
    const pane = controller.panes.primary.getSnapshot();
    const ready = !!pane.documentId && !!controller.workspace.observeDocument(pane.documentId).getSnapshot();
    return hostSceneModel(layout, pane, ready, controller.source.documentId);
}
