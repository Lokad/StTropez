import { actions, conflictText, statusText } from "./actions.ts";
import type { HostController, Layout } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";
import type { TabSnapshot } from "../../src/index.ts";
import { mountLanguagePanel } from "./language-panel.ts";

export function mountPlain(host: HTMLElement, controller: HostController, bindings: ViewBindings): () => void {
    const listeners = new AbortController(), subscriptions: (() => void)[] = [];
    const nav = document.createElement("nav"); nav.setAttribute("aria-label", "Host commands");
    for (const action of actions(controller, bindings)) {
        const button = document.createElement("button"); button.textContent = action.label;
        button.addEventListener("click", action.invoke, { signal: listeners.signal }); nav.append(button);
    }
    const status = document.createElement("output"); status.setAttribute("aria-label", "Host operation status");
    const scene = document.createElement("main"), modal = document.createElement("div"); modal.setAttribute("role", "status"); modal.setAttribute("aria-label", "Host messages");
    const recovery = document.createElement("section"), recoveryNotice = document.createElement("output"), recoveryPreview = document.createElement("pre");
    recovery.setAttribute("aria-label", "Input recovery"); recoveryNotice.setAttribute("aria-live", "polite"); recovery.append(recoveryNotice, recoveryPreview);
    const updateRecovery = () => { const state = controller.recovery.getSnapshot(), text = state.items.at(-1)?.attemptedText ?? "";
        recovery.hidden = state.items.length === 0; recoveryNotice.textContent = `${state.items.length} input ${state.items.length === 1 ? "change" : "changes"} retained for recovery.`;
        recoveryPreview.hidden = !state.visible; recoveryPreview.textContent = state.visible ? text.slice(0, 4096) + (text.length > 4096 ? "…" : "") : ""; };
    const review = document.createElement("section"); review.setAttribute("aria-label", "Source review surface"); review.className = "host-review";
    const conflict = document.createElement("section"), conflictStatus = document.createElement("output");
    conflict.setAttribute("aria-label", "Save conflict"); conflictStatus.setAttribute("aria-live", "polite"); conflict.append(conflictStatus);
    const reviewRemote = document.createElement("button"), finishRemote = document.createElement("button"), retry = document.createElement("button");
    reviewRemote.textContent = "Review remote source"; finishRemote.textContent = "Finish remote review"; retry.textContent = "Save reviewed source";
    reviewRemote.addEventListener("click", controller.reviewSaveConflict, { signal: listeners.signal });
    finishRemote.addEventListener("click", controller.finishConflictReview, { signal: listeners.signal });
    retry.addEventListener("click", controller.saveReviewedSource, { signal: listeners.signal }); conflict.append(reviewRemote, finishRemote, retry);
    const updateConflict = () => { const state = controller.saveConflict.getSnapshot(); conflict.hidden = state === null;
        conflictStatus.textContent = conflictText(controller); finishRemote.disabled = state?.review !== "loading";
        retry.disabled = !controller.canSaveReviewedSource(); };
    const language = document.createElement("section"); language.setAttribute("aria-label", "Language and find tools"); language.className = "host-language";
    host.replaceChildren(nav, status, recovery, conflict, scene, review, language, modal);
    const destroyLanguage = mountLanguagePanel(language, bindings.language);
    const updateStatus = () => { const text = statusText(controller); if (status.textContent !== text) status.textContent = text; };
    let unwatchForm: (() => void) | undefined;
    let sceneListeners: AbortController | undefined;
    let rendered: Layout | undefined;
    let renderedTab: TabSnapshot | undefined;
    const renderScene = () => {
        const layout = controller.layout.getSnapshot();
        const tab = controller.workspace.getSnapshot().tabs.find(tab => tab.id === controller.viewTab("primary"));
        modal.textContent = layout.modal.kind === "error" ? layout.modal.message : layout.modal.kind === "close" ? "Close the captured tab?" : "";
        if (rendered && rendered.position === layout.position && rendered.visible === layout.visible
            && rendered.formFault === layout.formFault && rendered.primarySurface === layout.primarySurface
            && renderedTab?.id === tab?.id && renderedTab?.generation === tab?.generation) return;
        rendered = layout; renderedTab = tab;
        bindings.unmount(); unwatchForm?.(); unwatchForm = undefined; sceneListeners?.abort(); sceneListeners = new AbortController();
        scene.replaceChildren();
        if (layout.formFault) { scene.textContent = "Host surface unavailable. Recover views to continue."; return; }
        const left = document.createElement("section"), right = document.createElement("section");
        left.setAttribute("aria-label", "Left host pane"); right.setAttribute("aria-label", "Right host pane"); scene.append(left, right);
        const form = document.createElement("div"), label = document.createElement("label"), field = document.createElement("input"), validation = document.createElement("p");
        label.textContent = "Configuration path"; label.append(field); form.append(label, validation); right.append(form);
        const updateForm = () => {
            const state = controller.connection.getSnapshot();
            if (state.state === "ready") { if (field.value !== state.value.path) field.value = state.value.path; validation.textContent = state.value.path ? "" : "Path is required."; }
        };
        field.addEventListener("input", () => controller.setPath(field.value), { signal: sceneListeners.signal });
        unwatchForm = controller.connection.subscribe(updateForm); updateForm();
        if (layout.visible) {
            if (layout.primarySurface === "text") {
                const primary = document.createElement("div"); primary.className = "editor-host";
                (layout.position === "left" ? left : right).append(primary); bindings.primary(primary);
            } else { const placeholder = document.createElement("p"); placeholder.textContent = layout.primarySurface; left.append(placeholder); }
            const secondary = document.createElement("div"); secondary.className = "editor-host"; right.append(secondary); bindings.secondary(secondary);
        }
    };
    let reviewKey: string | undefined;
    const renderReview = () => {
        const layout = controller.layout.getSnapshot(), reference = controller.comparisonReference.getSnapshot();
        const tab = controller.workspace.tabState.getSnapshot().find(tab => tab.id === controller.viewTab("primary"));
        const key = layout.navigation.kind === "review" && layout.visible && !layout.formFault && layout.primarySurface === "text"
            && tab?.surface.kind === "text" && tab.surface.documentId === controller.source.documentId
            ? `${tab.id}:${tab.generation}:${reference.generation}` : undefined;
        review.hidden = key === undefined;
        if (key === reviewKey) return;
        // Record identity before mounting: the comparison creates its own reference display tab.
        reviewKey = key; bindings.comparison(null); review.replaceChildren();
        if (key !== undefined) { const content = document.createElement("div"); review.append(content); bindings.comparison(content); }
    };
    // Controller lifecycle commands publish layout after workspace mutations finish; a workspace
    // notification itself cannot synchronously mount/release the comparison's display resources.
    subscriptions.push(controller.layout.subscribe(renderScene), controller.source.metadata.subscribe(updateStatus),
        controller.review.subscribe(updateStatus), controller.activity.subscribe(updateStatus), controller.recovery.subscribe(updateRecovery),
        controller.layout.subscribe(renderReview), controller.comparisonReference.subscribe(renderReview),
        controller.saveConflict.subscribe(updateConflict), controller.source.metadata.subscribe(updateConflict),
        controller.layout.subscribe(updateConflict), controller.comparisonReference.subscribe(updateConflict));
    renderScene(); renderReview(); updateStatus(); updateRecovery(); updateConflict();
    return () => { destroyLanguage(); unwatchForm?.(); subscriptions.forEach(unsubscribe => unsubscribe()); bindings.comparison(null); bindings.unmount(); sceneListeners?.abort(); listeners.abort(); host.replaceChildren(); };
}
