import { isSaveKey, isUnmodifiedShortcut, usesAppleShortcuts } from "../shared/host-shortcuts.ts";
import { mountTextEditor, mountTextComparison, createFindController, createRegexFindBackend, createFoldingController, diagnosticDecoration, editRefusedEvent } from "../../src/browser/index.ts";
import type { EditorCommands, EditRefusedDetail, TextEditor, FindController, TextComparison, FoldingController, DecorationLayer, DecorationProvider } from "../../src/browser/index.ts";
import { discoverIndentationFolds } from "../../src/index.ts";
import { DemoProject } from "./project.ts";
import { linePrompt } from "../shared/line-prompt.ts";
import { bindFindCommands } from "../shared/find-commands.ts";
import { findStatus } from "../shared/find-status.ts";
import { selectDemoProvider } from "./provider.ts";
import type { DemoFile } from "./project.ts";
import { DemoPresentation } from "./presentation.ts";
import { sampleChoices } from "./samples.ts";
import type { SampleId } from "./samples.ts";
import { mountDemoLanguage } from "./language-view.ts";
import type { DemoSymbolTarget } from "./symbols.ts";
import { mountDemoOutput } from "./output.ts";
import { reviewLayout } from "./review-layout.ts";
import { initializeDemoFolds, mountDemoFolding, outlineFolds } from "./folding.ts";
import { mountDemoFoldMenu } from "./fold-menu.ts";
import { mountCodeMenuCommands } from "./code-menu.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";
import { mountProblemPages } from "./problem-pages.ts";
import { hostConfiguration, hostDecorations, mountHostIntegrations } from "./host-integrations.ts";
import { inspectCharacters } from "./character-warnings.ts";
import { demoSurface, DemoStylesUnavailable, prepareDemoShadowStyles } from "./shadow-surface.ts";
import "./style.css";

const element = (id: string) => document.getElementById(id)!;
const field = (id: string) => element(id) as HTMLInputElement;
const findBar = element("find-bar");
const replaceResult = element("replace-result");
const findQuery = element("find-query") as HTMLTextAreaElement, replacement = element("replacement") as HTMLTextAreaElement;
const button = (id: string) => element(id) as HTMLButtonElement;
const codeMenu = element("code-menu") as HTMLDetailsElement;
const languageButtons = codeMenu.querySelectorAll<HTMLButtonElement>('[data-command^="demo.language."]');
const projects = new Map<SampleId, DemoProject>(), activeFiles = new Map<SampleId, string>();
const pendingProjects = new Map<SampleId, Promise<DemoProject>>();
const listeners = new AbortController(), sample = element("sample") as HTMLSelectElement;
const pageOptions = new URL(location.href).searchParams;
const openProvider = selectDemoProvider(pageOptions.get("provider") ?? document.documentElement.dataset.demoProvider ?? "browser");
for (const choice of sampleChoices) { const option = document.createElement("option"); option.value = choice.id; option.textContent = choice.title; sample.append(option); }
let project: DemoProject | undefined, active: DemoFile | undefined, editor: TextEditor | undefined;
let comparison: TextComparison | undefined, find: FindController | undefined, activePane: TextEditor | undefined;
let closedFind: ReturnType<FindController["getSnapshot"]> | undefined;
const foldMenu = mountDemoFoldMenu(codeMenu, () => comparison?.activePane() ?? editor);
const renderCodeMenu = mountCodeMenuCommands(codeMenu, () => activePane, () => editor, listeners.signal);
let output: ReturnType<typeof mountDemoOutput> | undefined;
let setReviewCollapsed: ReturnType<typeof reviewLayout> | undefined;
type DemoPanel = "javascript" | "problems" | "changes";
let panel: DemoPanel = "javascript", disposed = false, opening = 0;
let pendingPanel: DemoPanel | undefined;
let metadataFrame: number | undefined;
let stopWorkspace: (() => void) | undefined, stopRecovery: (() => void) | undefined, stopFind: (() => void) | undefined;
let stopLanguage: (() => void) | undefined, languageView: ReturnType<typeof mountDemoLanguage> | undefined;
let languageViewFailure: Readonly<{ error: unknown }> | undefined;
let stopReference: (() => void) | undefined;
let stopReferenceFolding: (() => void) | undefined;
let folding: FoldingController | undefined, referenceFolding: FoldingController | undefined, stopFolding: (() => void) | undefined;
let viewListeners: AbortController | undefined;
let reviewLabel: HTMLSpanElement | undefined;
let hostIntegrations: ReturnType<typeof mountHostIntegrations> | undefined;
const hostLanguage = () => project?.sample.id === "outline" || project?.sample.id === "host";
function presentationSettings() {
    return { columnRulers: field("view-rulers").checked ? [80, 120] : [],
        highlightCurrentLine: field("view-current-line").checked, fontLigatures: field("view-ligatures").checked,
        scrollBeyondLastLine: field("view-trailing-space").checked, minimap: field("view-minimap").checked };
}
let referencePresentation: DemoPresentation | undefined;
let syntaxLayer: DecorationProvider | undefined, diagnosticsLayer: DecorationLayer | undefined;
let paintedDiagnostics: unknown;
let problemPage = 0, renderedProblemState: unknown;
function refreshBrackets(captured: TextEditor | undefined) {
    // Plain-source notifications may run inside a Workspace publication; retain the owning view.
    if (captured) queueMicrotask(() => { if (!captured.activity().disposed) captured.bracketMatching.refresh(); });
}
const presentation = new DemoPresentation(() => { syntaxLayer?.invalidate(); if (presentation.status === "ready") refreshBrackets(editor); renderOutput(); renderMetadata(); });
const indentation = element("indentation") as HTMLSelectElement;
function editingConfiguration(rules = presentation.editing) {
    const tabSize = indentation.value === "sample" ? project?.sample.indentSize ?? 2 : indentation.value === "2" ? 2 : 4;
    const config = rules.configuration(tabSize, indentation.value !== "tabs");
    if (project?.sample.id === "host") return hostConfiguration(config.tabSize!, config.insertSpaces!);
    return project?.sample.id === "outline" ? { tabSize: config.tabSize!, insertSpaces: config.insertSpaces!, lineComment: "#", pairs: [], enter: "keep" as const } : config;
}

function renderOutput(): void {
    if (panel !== "javascript" || element("workspace").classList.contains("collapsed")) return;
    const host = element("panel-content");
    if (project?.sample.id === "host") {
        if (!host.querySelector(".host-output-note")) { const note = document.createElement("p"); note.className = "panel-note host-output-note";
            note.textContent = "This sample uses host-supplied colors and editing rules. No JavaScript is generated. Use Changes to compare your edits, or Code for paste formats and source notes."; host.replaceChildren(note); } return;
    }
    if (presentation.status === "ready") {
        const text = presentation.javascript || "// This file emits no JavaScript.\n";
        if (output) output.update(text);
        else {
            host.replaceChildren();
            output = mountDemoOutput(host, text, presentationSettings());
            observePane(output.editor);
            bindCommands(output.editor.commands);
        }
    } else if (!output) {
        // Keep the last completed output for this view while the footer reports pending/failed analysis.
        const note = document.createElement("p"); note.className = "panel-note";
        note.textContent = presentation.status === "failed" ? "JavaScript output is unavailable. Use Retry to restart analysis. Your source is still editable."
            : "Updating JavaScript…"; host.replaceChildren(note);
    }
}
function renderProblems(): void {
    if (!project || panel !== "problems") return;
    const captured = project, state = captured.language.state.getSnapshot(), host = element("panel-content");
    if (renderedProblemState === state && host.firstElementChild?.classList.contains("demo-problems")) return;
    renderedProblemState = state;
    const confirmed = state.status === "ready" && !state.checking;
    const pageSize = 64;
    const page = Math.min(problemPage, Math.max(0, Math.ceil(state.diagnostics.length / pageSize) - 1));
    if (confirmed) problemPage = page;
    const list = document.createElement("div"); list.className = "demo-problems";
    if (!state.diagnostics.length) {
        const note = document.createElement("p"); note.className = "panel-note";
        note.textContent = state.status === "failed" ? state.message : state.checking || state.status === "starting" ? "Checking types…" : "No problems in this project.";
        list.append(note); host.replaceChildren(list); return;
    }
    const key = captured.workspace.allocateIdentity();
    const current = () => project === captured && captured.language.state.getSnapshot() === state && list.parentElement === host;
    mountProblemPages(list, "problems", state.diagnostics, pageSize, key, current, problem => {
        const row = document.createElement("section"), item = document.createElement("button"), metadata = document.createElement("div");
        row.className = "demo-problem"; item.className = "problem-location"; metadata.className = "problem-metadata";
        const code = problem.code === undefined ? "" : `${problem.source === "typescript" ? "TS" : ""}${problem.code}: `;
        const { line, character } = problem.range.start;
        item.textContent = `${problem.name}:${line + 1}:${character + 1} · ${code}${problem.message}`;
        const open = (target: { documentId: typeof problem.documentId; revision: number; from: number; to: number }) => {
            if (!current() || !list.contains(row) || !confirmed || editorBusy()) return false;
            const file = captured.files.find(file => file.resource.documentId === target.documentId);
            if (!file || captured.workspace.document(target.documentId).revision !== target.revision) return false;
            if (file !== active) mountFile(file);
            return editor?.view === file.view && !!editor.reveal(target, {
                expectedRevision: target.revision, align: "center-if-outside", select: true, focus: true
            });
        };
        item.disabled = !confirmed;
        item.addEventListener("click", () => {
            if (open(problem) && !active?.readOnly) void languageView?.offerFixes(metadata, current);
        });
        metadata.textContent = [({ 1: "Error", 2: "Warning", 3: "Information", 4: "Hint" } as Record<number, string>)[problem.severity ?? 1],
            problem.source, ...(!confirmed ? ["Awaiting recheck"] : []), ...(problem.tags ?? []).flatMap(tag => tag === 1 ? ["Unnecessary"] : tag === 2 ? ["Deprecated"] : [])].filter(Boolean).join(" · ");
        const href = problem.codeDescription?.href;
        if (href && canOpenDemoHelp(href)) {
            const help = document.createElement("button"); help.textContent = "Diagnostic help"; help.title = href;
            help.onclick = () => { if (current() && canOpenDemoHelp(href)) window.open(href, "_blank", "noopener,noreferrer"); }; metadata.append(" · ", help);
        }
        row.append(item, metadata);
        if (problem.related.length) {
            const details = document.createElement("details"), summary = document.createElement("summary"), related = document.createElement("div");
            summary.textContent = `Related locations (${problem.related.length})`; details.append(summary, related); let page = 0;
            const render = () => {
                if (!details.open) { related.replaceChildren(); return; }
                mountProblemPages(related, "related locations", problem.related, 16, key, () => current() && details.open && list.contains(details), info => {
                    const location = document.createElement("button"); location.textContent = `${info.name}:${info.line + 1}:${info.character + 1} · ${info.message}`;
                    location.disabled = !confirmed || !info.target; if (!info.target) location.title = "This related file is not loaded in the editor, or its range cannot be placed.";
                    location.onclick = () => { if (info.target) open(info.target); }; return location;
                }, page, at => { page = at; });
            };
            details.addEventListener("toggle", render); row.append(details);
        }
        return row;
    }, page, at => {
        problemPage = at;
        host.scrollTop = 0;
    });
    host.replaceChildren(list);
}
function renderLanguage(): void {
    if (!project || disposed) return;
    const plain = hostLanguage();
    element("host-controls").hidden = element("host-status").hidden = project.sample.id !== "host";
    for (const control of languageButtons) control.hidden = plain || languageViewFailure !== undefined;
    button("block-comment").hidden = plain;
    renderCodeMenu();
    if (plain) {
        element("language-status").textContent = project.sample.id === "host" ? "Host language · no language server" : "Host outline · no language server"; element("language-retry").hidden = true;
        document.querySelector<HTMLButtonElement>('[data-panel="problems"]')!.textContent = "Problems";
        diagnosticsLayer?.clear(); renderProblems(); return;
    }
    const state = project.language.state.getSnapshot();
    element("language-status").textContent = languageViewFailure ? "Language controls unavailable" : state.status === "failed" ? "Language service unavailable" : state.status === "starting" ? "Starting language service…"
        : state.checking ? "Checking types…" : state.status === "ready" ? "Language ready" : "Language service idle";
    element("language-retry").hidden = !languageViewFailure && state.status !== "failed";
    element("language-retry").textContent = languageViewFailure ? "Retry language controls" : "Retry language service";
    element("language-status").title = languageViewFailure ? "The language controls could not open. Your files are retained." : state.message;
    const problems = document.querySelector<HTMLButtonElement>('[data-panel="problems"]')!;
    problems.textContent = state.diagnostics.length ? `Problems (${state.diagnostics.length})` : "Problems";
    if (active && diagnosticsLayer && paintedDiagnostics !== state.diagnostics) {
        const revision = project.workspace.document(active.resource.documentId).revision;
        const ranges = state.diagnostics.filter(problem => problem.documentId === active!.resource.documentId && problem.revision === revision);
        diagnosticsLayer.set(revision, ranges.map(diagnosticDecoration));
        paintedDiagnostics = state.diagnostics;
    }
    renderProblems();
}
function scheduleMetadata(): void {
    if (metadataFrame === undefined) metadataFrame = requestAnimationFrame(() => { metadataFrame = undefined; paintMetadata(); });
}
function renderMetadata(): void {
    if (!project || !active || disposed) return;
    scheduleMetadata();
    // Capture every revision immediately. Deferring this with the DOM would skip position
    // maps and lose provisional colors when several edits arrive before one frame.
    presentation.update(project.workspace.document(active.resource.documentId), hostLanguage());
}
function paintRecovery(project: DemoProject): void {
    const recovery = project.recovery.state.getSnapshot();
    element("recovery-offer").hidden = !recovery.present;
    element("recovery-message").textContent = recovery.message;
    const versions = element("recovery-version") as HTMLSelectElement;
    versions.hidden = recovery.versions < 2; versions.disabled = recovery.busy;
    if (versions.options.length !== recovery.versions) {
        versions.replaceChildren(...Array.from({ length: recovery.versions }, (_, index) =>
            new Option(index === 0 ? "Most recent draft" : index === 1 ? "Previous draft" : `${index} drafts earlier`, String(index))));
    }
    versions.selectedIndex = recovery.selected;
    element("recovery-status").textContent = recovery.present ? "Recovery draft available" : recovery.message;
    button("recovery-review").hidden = !recovery.canReview;
    button("recovery-review").disabled = recovery.busy;
    element("recovery-retry").hidden = recovery.status !== "failed";
    button("recovery-restore").disabled = !project.recovery.canRestore();
    button("recovery-keep").disabled = button("recovery-discard").disabled = recovery.busy;
}
function paintMetadata(): void {
    if (!project || !active || disposed) return;
    renderCodeMenu();
    if (activePane) {
        const buffer = activePane.workspace.document(activePane.view.documentId).buffer, { head } = activePane.view.getSnapshot().selection;
        const { line, column } = buffer.positionAt(head);
        element("cursor").textContent = `Ln ${line + 1}, Col ${column + 1}`;
    }
    element("status").textContent = project.message;
    element("analysis-status").textContent = hostLanguage() ? "Host colors & editing rules" : referencePresentation?.status === "failed" ? "Saved-copy analysis unavailable" : presentation.status === "failed" ? "Analysis unavailable" : presentation.status === "ready"
        ? `TypeScript 5.9.3 · ${panel === "javascript" && !element("workspace").classList.contains("collapsed") ? "syntax & emit" : "syntax"}` : "TypeScript · analyzing…";
    element("analysis-retry").hidden = presentation.status !== "failed" && referencePresentation?.status !== "failed";
    button("save").disabled = project.saving;
    button("navigate-back").disabled = !activePane?.commands.get("demo.back", "menu")?.enabled;
    element("save-conflict").hidden = !project.hasConflict();
    button("conflict-save").disabled = button("conflict-take").disabled = !project.canSaveReviewed() || find?.getSnapshot().status === "replacing";
    button("conflict-review").disabled = project.saving;
    if (reviewLabel) reviewLabel.textContent = project.referenceLabel();
    paintRecovery(project);
    for (const file of project.files) {
        let tab = element("files").querySelector<HTMLButtonElement>(`[data-file="${file.name}"]`);
        if (!tab) { tab = document.createElement("button"); tab.dataset.file = file.name; element("files").append(tab); }
        const label = `${file.name}${file.readOnly ? " (read-only)" : file.resource.metadata.getSnapshot().dirty ? " ●" : ""}`;
        if (tab.textContent !== label) tab.textContent = label; // Preserve native presses through background analysis updates.
        tab.setAttribute("aria-pressed", String(file === active));
    }
    document.title = `${project.dirty() ? "● " : ""}${active.name} · StTropez`;
}
function detachView(keepProblems = false): void {
    hostIntegrations?.dispose(); hostIntegrations = undefined;
    stopFolding?.(); stopFolding = undefined; folding?.dispose(); folding = undefined;
    stopReferenceFolding?.(); stopReferenceFolding = undefined; referenceFolding?.dispose(); referenceFolding = undefined;
    stopReference?.(); stopReference = undefined;
    referencePresentation?.dispose(); referencePresentation = undefined;
    releaseFind(); activePane = undefined;
    output?.dispose(); output = undefined;
    detachLanguage();
    viewListeners?.abort(); viewListeners = undefined;
    syntaxLayer = undefined; diagnosticsLayer = undefined; paintedDiagnostics = undefined;
    if (comparison) comparison.dispose(); else editor?.dispose();
    comparison = undefined; editor = undefined; reviewLabel = undefined; setReviewCollapsed = undefined;
    element("panel-content").classList.remove("demo-working-only");
    element("editor").replaceChildren();
    if (!keepProblems) element("panel-content").replaceChildren();
    if (metadataFrame !== undefined) cancelAnimationFrame(metadataFrame); metadataFrame = undefined;
}
function openLocation(capturedProject: DemoProject, capturedEditor: TextEditor, target: DemoSymbolTarget,
    origin = capturedProject.navigation.capture(capturedEditor)): void {
    if (disposed || project !== capturedProject || editor !== capturedEditor) return;
    const destination = capturedProject.files.find(file => file.resource.documentId === target.documentId);
    if (!destination || capturedProject.workspace.document(target.documentId).revision !== target.revision) return;
    origin?.visit(() => {
        if (destination !== active) mountFile(destination);
        return editor?.view === destination.view && !!editor.reveal(target, { expectedRevision: target.revision, select: true, focus: true });
    });
    renderMetadata();
}
function attachLanguage(capturedProject: DemoProject, file: DemoFile, capturedEditor: TextEditor) {
    languageViewFailure = undefined;
    if (capturedProject.sample.id === "outline" || capturedProject.sample.id === "host") return;
    const report = (error: unknown) => {
        console.error(error);
        if (disposed || project !== capturedProject || editor !== capturedEditor) return;
        languageViewFailure = { error }; renderLanguage();
    };
    try {
        return mountDemoLanguage(capturedProject, file, capturedEditor, capturedProject.language,
            (target, origin) => openLocation(capturedProject, capturedEditor, target, origin), report, element("language-command-status"), element("snippet-controls"));
    } catch (error) { report(error); }
}
function detachLanguage(): void {
    const previous = languageView; languageView = undefined; languageViewFailure = undefined;
    try { previous?.dispose(); } catch (error) { console.error(error); }
}
function editorBusy(): boolean {
    const activity = editor?.activity();
    return !!activity && (activity.composing || activity.pendingInput || activity.pendingCommand);
}
function projectBusy(): boolean {
    return editorBusy() || find?.getSnapshot().status === "replacing";
}
function refusePendingEdit(pending = editorBusy()): boolean {
    if (!pending) return false;
    project?.setEditRefusal("An edit is pending. Try again when it finishes.");
    scheduleMetadata();
    return true;
}
function mountFile(file: DemoFile, focus = false): void {
    if (!project || disposed || refusePendingEdit()) return;
    const viewState = editor?.captureView();
    const previous = active;
    if (previous && previous !== file) replaceResult.hidden = true;
    if (previous && viewState) savedViews.set(previous.view, viewState);
    detachView(panel === "problems"); active = file; activeFiles.set(project.sample.id, file.name);
    initializeDemoFolds(project, file);
    element("workspace").classList.toggle("reviewing", panel === "changes");
    const settings = { ...presentationSettings(), language: editingConfiguration(), bracketMatching: true, characterWarnings: field("character-warnings").checked };
    const surface = demoSurface(element(panel === "changes" ? "panel-content" : "editor"), project.sample.id === "host");
    if (panel === "changes") {
        comparison = mountTextComparison(surface, project.workspace, file.tab, project.baseline(file),
            { settings, view: file.view, requestLine: linePrompt(document), scrollLinked: true, rowsAligned: true, ariaLabel: `Changes in ${file.name}` });
        const labels = document.createElement("div"); labels.className = "demo-review-labels";
        const savedLabel = document.createElement("span"), workingLabel = document.createElement("span");
        reviewLabel = savedLabel;
        savedLabel.textContent = project.referenceLabel(); workingLabel.textContent = "Your changes";
        const hint = document.createElement("span"); hint.className = "demo-review-hint";
        hint.textContent = "Fold each pane independently. Shaded gaps keep matching lines aligned.";
        labels.append(savedLabel, workingLabel, hint); surface.append(labels);
        setReviewCollapsed = reviewLayout(surface, comparison);
        editor = comparison.panes.working;
        const reference = comparison.panes.reference, plain = hostLanguage();
        let tokens: DecorationProvider | undefined;
        const syntax: DemoPresentation | undefined = plain ? undefined : new DemoPresentation(() => {
            tokens?.invalidate(); if (syntax?.status === "ready") refreshBrackets(reference); renderMetadata();
        }, { emit: false, folds: true });
        referencePresentation = syntax;
        if (syntax || project.sample.id === "host") tokens = reference.decorations.addProvider({ order: 0, provide: syntax?.decorate ?? hostDecorations });
        reference.configure({ language: editingConfiguration(syntax?.editing) });
        if (syntax) {
            const source = reference.workspace.observeDocument(reference.view.documentId);
            const update = () => { const current = source.getSnapshot(); if (current) syntax.update(current); };
            stopReference = source.subscribe(update); update();
        }
        referenceFolding = createFoldingController(reference,
            (capture, signal) => plain ? discoverIndentationFolds(capture.buffer, outlineFolds(editingConfiguration().tabSize!)) : syntax!.discoverFolds(capture, signal));
        stopReferenceFolding = foldMenu.bind(reference, referenceFolding, "Saved copy");
    } else {
        editor = mountTextEditor(surface, project.workspace, file.tab,
            { settings, view: file.view, ariaLabel: file.name, requestLine: linePrompt(document) });
        renderProblems();
    }
    syntaxLayer = editor.decorations.addProvider({ order: 0, provide: project.sample.id === "host" ? hostDecorations : presentation.decorate });
    diagnosticsLayer = editor.decorations.add({ order: 40 });
    element("character-warning-details").replaceChildren();
    const saved = savedViews.get(file.view);
    if (saved) editor.restoreView(saved, { selection: "current" });
    folding = mountDemoFolding(project, editor, () => editingConfiguration().tabSize!);
    stopFolding = foldMenu.bind(editor, folding, comparison ? "Your changes" : "Source");
    viewListeners = new AbortController();
    viewListeners.signal.addEventListener("abort", editor.subscribe(scheduleMetadata), { once: true });
    observePane(editor);
    if (comparison) observePane(comparison.panes.reference);
    bindCommands(comparison?.commands ?? editor.commands);
    setActivePane(editor);
    languageView = attachLanguage(project, file, editor);
    if (project.sample.id === "host") {
        const capturedProject = project, capturedEditor = editor;
        hostIntegrations = mountHostIntegrations(project, file, editor, {
            mode: element("host-paste-mode") as HTMLSelectElement, insert: button("host-insert-table"), annotate: button("host-annotate"), status: element("host-status") },
            target => openLocation(capturedProject, capturedEditor, target));
    }
    if (element("workspace").classList.contains("collapsed")) setReviewCollapsed?.(true);
    renderMetadata(); renderLanguage(); renderOutput(); if (focus) editor.focus();
}
// View IDs are local to a Workspace; each sample owns a separate workspace.
const savedViews = new Map<DemoFile["view"], ReturnType<TextEditor["captureView"]>>();
function goBack(): void {
    if (!project || !editor || editorBusy()) return;
    const current = project;
    current.navigation.back(view => {
        const origin = current.files.find(file => file.view === view);
        if (!origin) return;
        if (origin !== active) mountFile(origin);
        return editor;
    }, { focus: true });
    renderMetadata();
}
function selectSample(id: SampleId): void {
    sample.value = id;
    button("reset").disabled = project?.sample.id !== id;
}
function showSampleError(message: string): void {
    sample.disabled = false;
    if (project) {
        selectSample(project.sample.id);
        project.message = message;
        renderMetadata();
    } else {
        sample.selectedIndex = -1;
        element("status").textContent = message;
        element("description").textContent = "Choose an example to try again.";
    }
}
function loadProject(id: SampleId): Promise<DemoProject> {
    const pending = pendingProjects.get(id);
    if (pending) return pending;
    const load = DemoProject.open(id, () => {
        return project?.sample.id !== id || !projectBusy();
    }, openProvider, { peerChanged: changed => {
        if (changed === project && !disposed) scheduleMetadata();
    } }).then(next => {
        if (disposed) next.dispose();
        else projects.set(id, next);
        return next;
    }).finally(() => pendingProjects.delete(id));
    pendingProjects.set(id, load);
    return load;
}
async function openSample(id: SampleId): Promise<void> {
    const generation = ++opening;
    if (refusePendingEdit()) { selectSample(project!.sample.id); return; }
    pendingPanel = undefined;
    selectSample(id);
    if (id === "host") {
        // Keep the current editor and sample picker usable while the shared stylesheet loads.
        sample.disabled = false;
        try { await prepareDemoShadowStyles(document, listeners.signal); }
        catch (error) {
            if (!(error instanceof DemoStylesUnavailable)) throw error;
            if (disposed || generation !== opening) return;
            showSampleError(error.message);
            return;
        }
        if (disposed || generation !== opening) return;
    }
    let next: DemoProject;
    try { next = projects.get(id) ?? await loadProject(id); }
    catch (error) {
        if (disposed || generation !== opening) return;
        console.error(error);
        showSampleError("Could not open this sample. Choose a sample to try again.");
        return;
    }
    if (disposed || generation !== opening) return;
    // The user can start editing while the next sample loads.
    if (refusePendingEdit()) { selectSample(project!.sample.id); sample.disabled = false; return; }
    stopWorkspace?.(); stopWorkspace = undefined;
    stopRecovery?.(); stopRecovery = undefined;
    stopLanguage?.(); stopLanguage = undefined;
    if (active && editor) savedViews.set(active.view, editor.captureView());
    replaceResult.hidden = true;
    if (project !== next) problemPage = 0;
    detachView(); project?.language.suspend(); active = undefined; project = next;
    selectSample(id); sample.disabled = false;
    indentation.options[0]!.textContent = `Sample default (${next.sample.indentSize ?? 2} spaces)`;
    element("description").textContent = next.sample.description;
    const tabs = next.files.map(file => {
        const tab = document.createElement("button"); tab.dataset.file = file.name; tab.textContent = file.name;
        return tab;
    });
    element("files").replaceChildren(...tabs);
    stopWorkspace = next.workspace.subscribe(renderMetadata);
    stopRecovery = next.recovery.state.subscribe(renderMetadata);
    stopLanguage = next.language.state.subscribe(renderLanguage);
    mountFile(next.files.find(file => file.name === activeFiles.get(id)) ?? next.files[0]!);
    for (const control of document.querySelectorAll<HTMLButtonElement>("#compare:disabled, [data-panel]:disabled")) control.disabled = false;
}
function setPanel(next: DemoPanel): void {
    pendingPanel = undefined;
    if (!active || refusePendingEdit()) return;
    // Remounting this file would dispose Find before its replacement commits.
    if (find?.getSnapshot().status === "replacing") { pendingPanel = next; return; }
    const samePanel = panel === next; panel = next;
    const wasCollapsed = element("workspace").classList.contains("collapsed");
    element("workspace").classList.remove("collapsed"); element("panel-collapse").textContent = "Hide";
    presentation.setEmit(panel === "javascript");
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) tab.setAttribute("aria-pressed", String(tab.dataset.panel === panel));
    if (samePanel && comparison && project) {
        const shown = comparison.getSnapshot().comparison.baseline, requested = project.baseline(active);
        if (shown?.buffer === requested.buffer && shown.version === requested.version) {
            (wasCollapsed ? setReviewCollapsed?.(false) : comparison.activePane())?.focus(); return;
        }
    }
    if (!comparison && next !== "changes") {
        if (next === "problems") {
            if (output && editor && activePane === output.editor) setActivePane(editor);
            output?.dispose();
            output = undefined;
            renderProblems();
        } else {
            renderOutput();
        }
        editor?.focus();
        return;
    }
    mountFile(active, true);
}
function observePane(target: TextEditor): void {
    target.element.addEventListener(editRefusedEvent, event => {
        if (!project || !active || target !== activePane) return;
        const { reason } = (event as CustomEvent<EditRefusedDetail>).detail;
        const message = reason === "edit-locked" ? "This file is locked for editing."
            : target === output?.editor ? "Generated JavaScript is read-only. Edit the TypeScript source."
            : target === comparison?.panes.reference ? "The saved copy is read-only. Edit your working copy."
            : active.name + " is read-only.";
        project.setEditRefusal(message);
        element("status").textContent = message;
    }, { signal: target.signal });
    const stop = target.view.subscribe(() => {
        if (target === editor) renderMetadata();
        else if (target === activePane) scheduleMetadata();
    });
    target.signal.addEventListener("abort", stop, { once: true });
    target.element.addEventListener("focusin", () => setActivePane(target), { signal: target.signal });
}
function bindCommands(commands: EditorCommands): void {
    // Option+Left moves by word on Apple keyboards. The menu can restore a location there.
    commands.register({ id: "demo.back", label: "Back to previous location",
        enabled: from => from !== "menu" || !!project?.navigation.getSnapshot(), run: goBack },
        { keys: usesAppleShortcuts() ? [] : ["Alt+ArrowLeft"], repeat: false });
    const ownsFind = (target: TextEditor) => activePane === target && !findBar.hidden;
    bindFindCommands(commands.register, (replace, target) => {
        setActivePane(target); openFind(replace);
    }, (direction, target) => {
        if (!findQuery.value) return false;
        setActivePane(target, true);
        if (findBar.hidden) closedFind = find?.getSnapshot();
        find?.next(direction, { whenReady: true });
        return true;
    }, target => ownsFind(target) && document.activeElement === findQuery);
    commands.register({ id: "find.replaceCurrent", label: "Replace current match",
        enabled: (from, target) => ownsFind(target) && (from === "button" ? !button("replace-current").disabled : document.activeElement === replacement),
        run: () => { if (!button("replace-current").disabled) find?.replaceCurrent(replacementText()); } },
        { keys: ["Enter"], shared: true, priority: 41, repeat: false });
    commands.register({ id: "find.insertLineBreak", label: "Insert a line break in Find or Replace",
        enabled: (_, target) => ownsFind(target) && (document.activeElement === findQuery || document.activeElement === replacement),
        run: () => {
            const input = document.activeElement === findQuery ? findQuery : replacement;
            input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        } }, { keys: ["Mod+Enter"], shared: true, priority: 40, repeat: false });
    commands.register({ id: "find.close", label: "Close Find", category: "Find", enabled: (_, pane) => ownsFind(pane), run: closeFind },
        { keys: ["Escape"], shared: true, repeat: false });
}
function releaseFind(): void {
    closedFind = undefined;
    pendingPanel = undefined;
    find?.dispose();
    stopFind?.();
    stopFind = undefined;
    find = undefined;
}
function setActivePane(target: TextEditor, repeat = false): void {
    if (activePane === target && find) return;
    if (activePane !== target) {
        project?.setEditRefusal();
        activePane = target;
        scheduleMetadata();
    }
    releaseFind();
    const visible = !findBar.hidden;
    if (!visible && !repeat) return;
    const current = createFindController(target, { highlightMatches: visible, regularExpressionBackend: createRegexFindBackend({
        clock: window, createWorker: () => new Worker(new URL("regex-worker.js", document.baseURI), { type: "module" }),
    }) });
    find = current; current.setFlags(findFlags());
    const label = target === output?.editor ? "JavaScript output" : target === comparison?.panes.reference ? "Saved copy" : active?.name;
    const readOnly = target !== editor || active?.readOnly;
    element("find-target").textContent = readOnly ? `${label} · read-only` : "";
    const status = element("find-status"), previous = button("find-previous"), next = button("find-next");
    const replace = button("replace-current"), all = button("replace-all");
    let awaitingOutcome = false;
    let replacing = false;
    const render = () => {
        const snapshot = current.getSnapshot();
        const cached = closedFind;
        if (cached && snapshot.revision !== cached.revision) {
            // A hidden bar reuses an unchanged index. Resume searching edited text on the next F3.
            queueMicrotask(() => { if (closedFind === cached) releaseFind(); });
        }
        const wasReplacing = replacing;
        replacing = snapshot.status === "replacing";
        if (replacing) {
            awaitingOutcome = true;
            replaceResult.hidden = true;
        } else if (awaitingOutcome && snapshot.reason) {
            awaitingOutcome = false;
            replaceResult.textContent = label + " · " + snapshot.message;
            replaceResult.hidden = false;
            const requested = pendingPanel;
            if (snapshot.reason !== "replaced") pendingPanel = undefined;
            else if (requested) queueMicrotask(() => {
                if (current === find && pendingPanel === requested) setPanel(requested);
            });
        }
        if (replacing !== wasReplacing) scheduleMetadata();
        const searching = snapshot.status === "searching", ready = snapshot.status === "ready", matches = snapshot.count > 0;
        const message = findStatus(snapshot);
        status.textContent = message;
        status.classList.toggle("no-matches", ready && !matches && !!snapshot.query);
        status.classList.toggle("search-failed", snapshot.status === "failed");
        previous.disabled = next.disabled = !(searching || ready && matches);
        replace.disabled = readOnly || !matches || !(ready || searching && snapshot.retained);
        all.disabled = readOnly || !matches || !ready;
        const reason = readOnly ? `${label} is read-only.` : searching ? "Waiting for search results."
            : replacing ? "Replacement in progress." : message || "Enter text to find.";
        replace.title = replace.disabled ? reason : "Replace the current match";
        all.title = all.disabled ? reason : "Replace all matches";
    };
    stopFind = current.subscribe(render); render();
    current.setQuery(findQuery.value);
}
function findFlags() {
    const pressed = (id: string) => button(id).getAttribute("aria-pressed") === "true";
    return { matchCase: pressed("find-case"), wholeWord: pressed("find-word"), regularExpression: pressed("find-regex") };
}
function selectedFindQuery(source: TextEditor, regex: boolean): string | undefined {
    const { anchor, head } = source.view.getSnapshot().selection, length = Math.abs(head - anchor);
    const limit = 4096;
    if (length > limit) return;
    const buffer = source.workspace.document(source.view.documentId).buffer;
    let text: string | undefined;
    if (length) text = buffer.slice(Math.min(anchor, head), Math.max(anchor, head));
    else {
        // One extra code point on either side distinguishes long identifiers from complete words.
        const from = Math.max(0, head - limit - 2);
        const window = buffer.slice(from, Math.min(buffer.length, head + limit + 2));
        for (const word of window.matchAll(/[$\p{ID_Continue}\u200c\u200d]+/gu)) {
            const start = from + word.index;
            if (start > head) break;
            if (head <= start + word[0].length) { text = word[0]; break; }
        }
    }
    if (!text || text.length > limit) return;
    const query = regex ? text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&").replace(/\r/g, "\\r") : text.replaceAll("\r\n", "\n");
    // A textarea would turn a remaining literal CR into a different query.
    if (query.includes("\r")) return;
    return query.length <= limit ? query : undefined;
}
function openFind(replace = false): void {
    if (!activePane) return;
    replaceResult.hidden = true;
    const { anchor, head } = activePane.view.getSnapshot().selection;
    const focusReplacement = replace && (!!findQuery.value || anchor !== head);
    if (findBar.hidden || activePane.getSnapshot().focused) {
        const selected = selectedFindQuery(activePane, findFlags().regularExpression);
        if (selected !== undefined && selected !== findQuery.value) {
            findQuery.value = selected; sizeFindField(findQuery);
            find?.setQuery(selected);
        }
    }
    closedFind = undefined;
    find?.setHighlightMatches(true);
    findBar.hidden = false; showReplacement(replace);
    setActivePane(activePane);
    const target = focusReplacement && findQuery.value && activePane === editor && !active?.readOnly ? replacement : findQuery;
    target.focus(); target.select();
}
function revealFindCaret(): void {
    if (!activePane) return;
    const { head } = activePane.view.getSnapshot().selection;
    activePane.viewport.revealRange(head, head);
}
function closeFind(): void {
    if (!find?.acceptPreview()) revealFindCaret();
    findBar.hidden = true;
    if (find?.getSnapshot().status === "ready") {
        find.setHighlightMatches(false);
        closedFind = find.getSnapshot();
    } else releaseFind();
    activePane?.focus();
}
function showReplacement(show: boolean): void {
    element("replace-controls").hidden = !show;
    button("replace-toggle").setAttribute("aria-expanded", String(show));
}
function sizeFindField(input: HTMLTextAreaElement): void {
    input.rows = input.value.includes("\n") ? 2 : 1;
}
function replacementText(): string {
    if (!findFlags().regularExpression) return replacement.value;
    return replacement.value.replace(/\\([\\n])/g, (_, char: string) => char === "n" ? "\n" : "\\");
}
const on = (id: string, action: () => void) => element(id).addEventListener("click", action, { signal: listeners.signal });
for (const panel of [findBar, element("save-conflict")]) {
    // A disabled button can blur the active text field even though it never fires a click.
    panel.addEventListener("pointerdown", event => {
        if (event.button === 0 && event.target instanceof Element && event.target.closest("button:disabled")) {
            event.preventDefault();
        }
    }, { capture: true, signal: listeners.signal });
}
on("find-toggle", () => { activePane?.commands.run("find.open"); });
on("find-close", () => { activePane?.commands.run("find.close"); });
for (const toggle of element("find-options").querySelectorAll("button")) {
    on(toggle.id, () => {
        toggle.setAttribute("aria-pressed", String(toggle.getAttribute("aria-pressed") !== "true"));
        findQuery.focus();
        find?.setFlags(findFlags());
    });
}
on("replace-toggle", () => {
    const show = Boolean(element("replace-controls").hidden); showReplacement(show);
    (show ? replacement : findQuery).focus({ preventScroll: true });
});
for (const [id, command] of [["find-next", "find.next"], ["find-previous", "find.previous"]] as const) {
    button(id).addEventListener("pointerdown", event => {
        if (event.defaultPrevented || event.button !== 0) return;
        event.preventDefault();
        if (document.activeElement !== replacement) findQuery.focus({ preventScroll: true });
    }, { signal: listeners.signal });
    on(id, () => { activePane?.commands.run(command); });
}
on("replace-current", () => {
    replacement.focus({ preventScroll: true });
    activePane?.commands.run("find.replaceCurrent", "button");
});
on("replace-all", () => { find?.replaceAll(replacementText(), { focusEditor: true }); });
on("compare", () => setPanel("changes")); on("analysis-retry", () => { presentation.retry(); referencePresentation?.retry(); referenceFolding?.refresh(); });
on("inspect-characters", () => { if (editor && project) inspectCharacters(editor, project.workspace, element("character-warning-details")); });
field("character-warnings").addEventListener("change", () => {
    const enabled = field("character-warnings").checked;
    editor?.configure({ characterWarnings: enabled }); comparison?.panes.reference.configure({ characterWarnings: enabled });
    element("character-warning-details").replaceChildren();
}, { signal: listeners.signal });
for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) field(id).addEventListener("change", () => {
    const settings = presentationSettings();
    editor?.configure(settings); comparison?.panes.reference.configure(settings);
    output?.editor.configure(settings);
}, { signal: listeners.signal });
indentation.addEventListener("change", () => {
    editor?.configure({ language: editingConfiguration() });
    comparison?.panes.reference.configure({ language: editingConfiguration(referencePresentation?.editing) }); folding?.refresh(); referenceFolding?.refresh();
    codeMenu.open = false;
    (comparison?.activePane() ?? editor)?.focus();
}, { signal: listeners.signal });
element("host-paste-mode").addEventListener("change", () => { codeMenu.open = false; }, { signal: listeners.signal });
codeMenu.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    // Inspection can replace its clicked entry before this bubbling listener runs.
    const inspection = event.composedPath().some(node => node instanceof HTMLElement && (node.id === "inspect-characters" || node.id === "character-warning-details"));
    if (target.closest("button") && !inspection) codeMenu.open = false;
}, { signal: listeners.signal });
for (const menu of [codeMenu, element("view-menu") as HTMLDetailsElement]) {
    const summary = menu.querySelector("summary")!;
    let returnField: HTMLTextAreaElement | HTMLInputElement | undefined;
    const rememberField = (target: EventTarget | null) => {
        if (!menu.open) returnField = target instanceof HTMLTextAreaElement
            || target instanceof HTMLInputElement && target.type === "text" ? target : undefined;
    };
    summary.addEventListener("pointerdown", () => rememberField(document.activeElement), { signal: listeners.signal });
    summary.addEventListener("focus", event => rememberField(event.relatedTarget), { signal: listeners.signal });
    const position = () => {
        if (!menu.open) { returnField = undefined; return; }
        const trigger = summary.getBoundingClientRect();
        menu.style.setProperty("--menu-right", `${trigger.right}px`);
        menu.style.setProperty("--menu-top", `${Math.max(8, trigger.bottom + 6)}px`);
    };
    menu.addEventListener("toggle", position, { signal: listeners.signal });
    window.addEventListener("resize", position, { signal: listeners.signal });
    window.addEventListener("scroll", position, { signal: listeners.signal });
    document.addEventListener("pointerdown", event => { if (!menu.contains(event.target as Node)) menu.open = false; }, { signal: listeners.signal });
    document.addEventListener("keydown", event => {
        if (!menu.open || event.key !== "Escape" || !isUnmodifiedShortcut(event)) return;
        if (event.target !== document.body && !menu.contains(event.target as Node)) return;
        event.preventDefault();
        menu.open = false;
        if (returnField && !returnField.disabled && returnField.getClientRects().length) returnField.focus();
        else if (activePane) activePane.focus();
        else summary.focus();
    }, { signal: listeners.signal });
    menu.addEventListener("keydown", event => {
        if (!menu.open || !isUnmodifiedShortcut(event)) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" || event.target instanceof HTMLSelectElement) return;
        const items = Array.from(menu.querySelectorAll<HTMLElement>("button:enabled, input:enabled, a[href]"))
            .filter(item => item.getClientRects().length);
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === "ArrowDown" ? current + 1 : current <= 0 ? items.length - 1 : current - 1;
        if (items.length) { event.preventDefault(); items[next % items.length]!.focus(); }
    }, { signal: listeners.signal });
}
on("language-retry", () => {
    const captured = project, file = active, view = editor; if (!captured || !file || !view) return;
    const mountFailed = languageViewFailure !== undefined;
    detachLanguage();
    if (mountFailed) { languageView = attachLanguage(captured, file, view); renderLanguage(); return; }
    captured.language.resetProvider();
    languageView = attachLanguage(captured, file, view);
    folding?.refresh();
});
on("panel-collapse", () => {
    if (editor?.getSnapshot().composing) return;
    pendingPanel = undefined;
    const collapsed = element("workspace").classList.toggle("collapsed"); element("panel-collapse").textContent = collapsed ? "Show" : "Hide";
    if (setReviewCollapsed) setReviewCollapsed(collapsed).focus();
    else if (collapsed && editor && output && activePane === output.editor) editor.focus();
    presentation.setEmit(!collapsed && panel === "javascript");
});
on("walkthrough-toggle", () => { element("walkthrough").hidden = !element("walkthrough").hidden; });
on("reset", () => {
    if (!project || project.sample.id !== sample.value || refusePendingEdit(projectBusy())) return;
    if (!window.confirm(`Restore the original files in “${project.sample.title}”? You can undo this change. Other samples and recovery drafts are kept. The saved copy changes only when you save locally.`)) return;
    project.reset();
    renderMetadata();
    editor?.focus();
});
async function save(reviewed = false): Promise<void> {
    const captured = project; if (!captured || editor?.getSnapshot().composing) return;
    replaceResult.hidden = true;
    await captured.save(renderMetadata, reviewed);
    if (!disposed && project === captured && comparison && active) {
        const ticket = comparison.controller.beginRefresh(); ticket.complete(captured.baseline(active));
    }
}
// These controls disable or disappear during storage. Return focus before starting the
// action, while the same editor or review pane still owns the user's selection.
function onFileAction(id: string, action: () => void): void {
    on(id, () => { (comparison?.activePane() ?? editor)?.focus(); action(); });
}
onFileAction("save", () => { void save(); });
on("conflict-review", () => {
    if (refusePendingEdit(projectBusy()) || !project?.reviewConflict()) return;
    setPanel("changes");
    renderMetadata();
});
onFileAction("conflict-save", () => { void save(true); });
onFileAction("conflict-take", () => {
    const captured = project, view = editor, generation = opening;
    if (!captured || !view) return;
    const stillOpen = () => !disposed && captured === project && view === editor && generation === opening;
    void captured.takeReviewedCopy(renderMetadata, stillOpen).then(() => {
        if (stillOpen() && comparison && active) {
            const ticket = comparison.controller.beginRefresh(); ticket.complete(captured.baseline(active));
        }
    });
});
onFileAction("recovery-restore", () => { void project?.recovery.restore(); });
element("recovery-version").addEventListener("change", event => {
    project?.recovery.selectVersion((event.currentTarget as HTMLSelectElement).selectedIndex);
}, { signal: listeners.signal });
onFileAction("recovery-keep", () => project?.recovery.setOfferVisible(false));
onFileAction("recovery-discard", () => { void project?.recovery.discardOffered(); });
on("recovery-review", () => {
    if (!project) return;
    project.recovery.setOfferVisible(true);
    if (project.recovery.state.getSnapshot().present) {
        paintRecovery(project);
        button("recovery-keep").focus();
    }
});
element("recovery-offer").addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || button("recovery-keep").disabled) return;
    event.preventDefault();
    event.stopPropagation();
    button("recovery-keep").click();
}, { signal: listeners.signal });
on("recovery-retry", () => { void project?.recovery.refresh(); });
function download(text: string, name: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
on("recovery-download", () => {
    const draft = project?.recovery.download(); if (draft) download(draft, `${project!.sample.id}-recovery.json`);
});
on("download", () => {
    if (!project) return;
    download(project.download(), `${project.sample.id}-changes.json`);
});
for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) tab.addEventListener("click", () => setPanel(tab.dataset.panel as typeof panel), { signal: listeners.signal });
for (const strip of [element("files"), element("panels")]) {
    strip.addEventListener("keydown", event => {
        if (!isUnmodifiedShortcut(event)
            || !(event.target instanceof HTMLButtonElement) || !event.target.matches("[data-file], [data-panel]")) return;
        const key = event.key;
        if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
        const tabs = [...strip.querySelectorAll<HTMLButtonElement>("[data-file], [data-panel]")];
        const index = tabs.indexOf(event.target);
        const next = key === "Home" ? 0 : key === "End" ? tabs.length - 1
            : (index + tabs.length + (key === "ArrowRight" ? 1 : -1)) % tabs.length;
        event.preventDefault(); tabs[next]!.focus();
    }, { signal: listeners.signal });
}
findQuery.addEventListener("input", () => {
    replaceResult.hidden = true;
    sizeFindField(findQuery); find?.setQuery(findQuery.value, { preview: true });
    if (!findQuery.value) revealFindCaret();
}, { signal: listeners.signal });
replacement.addEventListener("input", () => sizeFindField(replacement), { signal: listeners.signal });
findBar.addEventListener("keydown", event => {
    activePane?.keymap.handle(event);
}, { signal: listeners.signal });
for (const controls of document.querySelectorAll<HTMLElement>("header, #files, #panels")) {
    controls.addEventListener("keydown", event => { activePane?.keymap.handle(event); }, { signal: listeners.signal });
}
sample.addEventListener("change", () => { void openSample(sample.value as SampleId); }, { signal: listeners.signal });
element("files").addEventListener("click", event => {
    const name = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file]")?.dataset.file;
    const file = project?.files.find(file => file.name === name);
    if (!file) return;
    if (file === active) editor?.focus();
    else mountFile(file, true);
}, { signal: listeners.signal });
window.addEventListener("keydown", event => {
    if (event.target === document.body) activePane?.keymap.handle(event);
    if (!isSaveKey(event) || editor?.getSnapshot().composing) return;
    event.preventDefault();
    if (!event.repeat) void save();
}, { signal: listeners.signal });
window.addEventListener("beforeunload", event => {
    if ([...projects.values()].some(project => project.dirty())) { event.preventDefault(); event.returnValue = ""; }
}, { signal: listeners.signal });
window.addEventListener("pagehide", event => {
    if (event.persisted) return;
    disposed = true; opening++; listeners.abort(); stopWorkspace?.(); stopRecovery?.(); stopLanguage?.(); detachView(); foldMenu.dispose(); presentation.dispose();
    for (const project of projects.values()) project.dispose(); projects.clear(); savedViews.clear();
}, { signal: listeners.signal });
const requestedSample = pageOptions.get("sample");
await openSample(sampleChoices.find(choice => choice.id === requestedSample)?.id ?? "pricing");
