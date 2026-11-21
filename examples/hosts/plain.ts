import { actions } from "./actions.ts";
import { inputRecoveryModel, operationStatusModel, mountSaveConflictPanel } from "./operation-panels.ts";
import type { HostController } from "./controller.ts";
import type { ViewBindings } from "./bindings.ts";
import { hostSceneModel } from "./scene-model.ts";
import { mountLanguagePanel } from "./language-panel.ts";
import { mountHoverPanel } from "./hover-panel.ts";
import { mountVariantPanel } from "./variant-panel.ts";
import { mountTablePastePanel } from "./table-panel.ts";
import { mountDomainPanel } from "./domain-panel.ts";
import { mountNavigationPanel } from "./navigation-panel.ts";
import { mountProjectPanel } from "./project-panel.ts";
import { mountDocumentColorsPanel } from "./document-colors-panel.ts";
import { mountDocumentLinksPanel } from "./document-links-panel.ts";
import { mountActionsPanel } from "./actions-panel.ts";
import { mountRenamePanel } from "./rename-panel.ts";
import { mountSignaturePanel } from "./signature-panel.ts";
import type { HostDraftRecovery } from "./draft-recovery.ts";
import { mountDraftPanel } from "./draft-panel.ts";
import { configurationFormModel, formSaveKey, mountConfigurationPanel } from "./configuration-panel.ts";
import { mountTransferPanel } from "./transfer-panel.ts";

export function mountPlain(host: HTMLElement, controller: HostController, bindings: ViewBindings, draft: HostDraftRecovery): () => void {
    const listeners = new AbortController(), subscriptions: (() => void)[] = [];
    const nav = document.createElement("nav"); nav.setAttribute("aria-label", "Host commands");
    for (const action of actions(controller, bindings)) {
        const button = document.createElement("button"); button.textContent = action.label;
        button.addEventListener("click", action.invoke, { signal: listeners.signal }); nav.append(button);
    }
    const readStatus = () => operationStatusModel(controller.activity.getSnapshot(), controller.source.metadata.getSnapshot());
    const status = document.createElement("output"); status.setAttribute("aria-label", readStatus().label);
    const scene = document.createElement("main"), modal = document.createElement("div"); modal.setAttribute("role", "status"); modal.setAttribute("aria-label", "Host messages");
    const recovery = document.createElement("section"), recoveryNotice = document.createElement("output"), recoveryPreview = document.createElement("pre");
    recovery.setAttribute("aria-label", inputRecoveryModel(controller.recovery.getSnapshot()).label); recovery.append(recoveryNotice, recoveryPreview);
    const updateRecovery = () => { const model = inputRecoveryModel(controller.recovery.getSnapshot());
        recovery.hidden = model.hidden; recoveryNotice.textContent = model.status;
        recoveryPreview.hidden = model.preview.hidden; recoveryPreview.textContent = model.preview.text; };
    const review = document.createElement("section"); review.setAttribute("aria-label", "Source review surface"); review.className = "host-review";
    const conflict = document.createElement("section");
    const language = document.createElement("section"); language.className = "host-language";
    const tablePaste = document.createElement("section"); tablePaste.className = "host-language";
    const domain = document.createElement("section"); domain.className = "host-language";
    const navigation = document.createElement("section"); navigation.className = "host-language";
    const project = document.createElement("section"); project.className = "host-language";
    const rename = document.createElement("section"); rename.className = "host-language";
    const codeActions = document.createElement("section"); codeActions.className = "host-language";
    const links = document.createElement("section"); links.className = "host-language";
    const colors = document.createElement("section"); colors.className = "host-language";
    const draftPanel = document.createElement("section"); draftPanel.className = "host-language";
    const configuration = document.createElement("section"); configuration.className = "host-language";
    const transfer = document.createElement("section"); transfer.className = "host-language";
    host.replaceChildren(nav, status, recovery, conflict, scene, review, configuration, transfer, draftPanel, language, tablePaste, domain, navigation, project, rename, codeActions, links, colors, modal);
    const destroyConflict = mountSaveConflictPanel(conflict, controller);
    const destroyTransfer = mountTransferPanel(transfer, controller);
    const destroyConfiguration = mountConfigurationPanel(configuration, controller);
    const destroyDraft = mountDraftPanel(draftPanel, draft);
    const destroyColors = mountDocumentColorsPanel(colors, bindings.colors);
    const destroyLinks = mountDocumentLinksPanel(links, bindings.links);
    const destroyActions = mountActionsPanel(codeActions, bindings.actions);
    const destroyRename = mountRenamePanel(rename, bindings.rename);
    const destroyProject = mountProjectPanel(project, bindings.project);
    const destroyNavigation = mountNavigationPanel(navigation, bindings.navigation);
    const destroyDomain = mountDomainPanel(domain, bindings.domain);
    const destroyTablePaste = mountTablePastePanel(tablePaste, bindings.tablePaste);
    const destroyLanguage = mountLanguagePanel(language, bindings.language);
    const destroyHover = mountHoverPanel(host, bindings.hover);
    const destroySignature = mountSignaturePanel(host, bindings.signature);
    const updateStatus = () => {
        const text = readStatus().text; if (status.textContent === text) return;
        // Native form reset can replace an output's children; use its current text node.
        const value = status.firstChild;
        if (value?.nodeType === Node.TEXT_NODE && value.nextSibling === null) value.nodeValue = text;
        else status.textContent = text;
    };
    let unwatchForm: (() => void) | undefined;
    let sceneListeners: AbortController | undefined;
    const readScene = () => {
        const layout = controller.layout.getSnapshot();
        const tab = controller.workspace.tabs.getSnapshot().find(tab => tab.id === controller.viewTab("primary"));
        const ready = tab?.surface.kind === "text" && controller.workspace.observeDocument(tab.surface.documentId).getSnapshot() !== undefined;
        return hostSceneModel(layout, tab, ready, controller.source.documentId);
    };
    let sceneKey: string | undefined;
    const renderScene = () => {
        const model = readScene(); modal.textContent = model.message;
        if (sceneKey === model.key) return;
        sceneKey = model.key;
        bindings.unmount(); unwatchForm?.(); unwatchForm = undefined; sceneListeners?.abort(); sceneListeners = new AbortController();
        scene.replaceChildren();
        if (model.fault) { scene.textContent = "Host surface unavailable. Recover views to continue."; return; }
        const left = document.createElement("section"), right = document.createElement("section");
        left.setAttribute("aria-label", "Left host pane"); right.setAttribute("aria-label", "Right host pane"); scene.append(left, right);
        const form = document.createElement("div"), label = document.createElement("label"), field = document.createElement("input"), validation = document.createElement("p");
        const initialForm = configurationFormModel(controller, controller.connection.getSnapshot());
        label.textContent = initialForm.field.label; label.append(field); form.append(label, validation); right.append(form);
        const updateForm = () => {
            const model = configurationFormModel(controller, controller.connection.getSnapshot());
            if (field.value !== model.field.value) field.value = model.field.value;
            validation.textContent = model.validation; field.setAttribute("aria-invalid", String(model.field.invalid)); field.readOnly = model.field.readOnly;
        };
        form.addEventListener("keydown", event => formSaveKey(event, controller.configurationSave), { signal: sceneListeners.signal });
        field.addEventListener("input", () => initialForm.field.change(field.value), { signal: sceneListeners.signal });
        unwatchForm = controller.connection.subscribe(updateForm); updateForm();
        const primaryPane = model.position === "left" ? left : right;
        if (model.primaryKey !== undefined) {
            const primary = document.createElement("div"); primary.className = "editor-host"; primaryPane.append(primary); bindings.primary(primary);
        } else if (model.placeholder !== undefined) {
            const placeholder = document.createElement("p"); placeholder.textContent = model.placeholder; primaryPane.append(placeholder);
        }
        if (model.secondary) {
            const secondary = document.createElement("div"); secondary.className = "editor-host"; right.append(secondary); bindings.secondary(secondary);
        }
    };
    let reviewKey: string | undefined;
    let destroyVariants: (() => void) | undefined;
    const renderReview = () => {
        const key = readScene().reviewKey;
        review.hidden = key === undefined;
        if (key === reviewKey) return;
        // Record identity before mounting: the comparison creates its own reference display tab.
        reviewKey = key; destroyVariants?.(); destroyVariants = undefined; bindings.comparison(null); review.replaceChildren();
        if (key !== undefined) { const controls = document.createElement("div"), content = document.createElement("div"); review.append(controls, content);
            destroyVariants = mountVariantPanel(controls, controller, bindings); bindings.comparison(content); }
    };
    // Controller lifecycle commands publish layout after workspace mutations finish; a workspace
    // notification itself cannot synchronously mount/release the comparison's display resources.
    subscriptions.push(controller.layout.subscribe(renderScene), controller.source.metadata.subscribe(updateStatus),
        controller.activity.subscribe(updateStatus), controller.recovery.subscribe(updateRecovery),
        controller.layout.subscribe(renderReview));
    renderScene(); renderReview(); updateStatus(); updateRecovery();
    return () => { destroyConflict(); destroyTransfer(); destroyConfiguration(); destroyDraft(); destroyColors(); destroyLinks(); destroyActions(); destroyRename(); destroySignature(); destroyProject(); destroyNavigation(); destroyDomain(); destroyTablePaste(); destroyHover(); destroyLanguage(); destroyVariants?.(); unwatchForm?.(); subscriptions.forEach(unsubscribe => unsubscribe()); bindings.comparison(null); bindings.unmount(); sceneListeners?.abort(); listeners.abort(); host.replaceChildren(); };
}
