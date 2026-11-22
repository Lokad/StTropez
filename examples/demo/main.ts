import { mountTextEditor, mountTextComparison, createFindController, createRegexFindBackend, createFoldingController, editRefusedEvent } from "../../src/browser/index.ts";
import type { EditRefusedDetail, TextEditor, FindController, FindSnapshot, TextComparison, FoldingController, DecorationLayer, DecorationProvider } from "../../src/browser/index.ts";
import { discoverIndentationFolds } from "../../src/index.ts";
import { DemoProject } from "./project.ts";
import { linePrompt } from "../shared/line-prompt.ts";
import { bindFindCommands } from "../shared/find-commands.ts";
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
import { canOpenDemoHelp } from "./diagnostics.ts";
import { hostConfiguration, hostDecorations, mountHostIntegrations } from "./host-integrations.ts";
import { inspectCharacters } from "./character-warnings.ts";
import { demoSurface, DemoStylesUnavailable, prepareDemoShadowStyles } from "./shadow-surface.ts";
import "./style.css";

const element = (id: string) => document.getElementById(id)!;
const field = (id: string) => element(id) as HTMLInputElement;
const button = (id: string) => element(id) as HTMLButtonElement;
const codeMenu = element("code-menu") as HTMLDetailsElement;
const projects = new Map<SampleId, DemoProject>(), activeFiles = new Map<SampleId, string>();
const pendingProjects = new Map<SampleId, Promise<DemoProject>>();
const listeners = new AbortController(), sample = element("sample") as HTMLSelectElement;
const pageOptions = new URL(location.href).searchParams;
const openProvider = selectDemoProvider(pageOptions.get("provider") ?? document.documentElement.dataset.demoProvider ?? "browser");
for (const choice of sampleChoices) { const option = document.createElement("option"); option.value = choice.id; option.textContent = choice.title; sample.append(option); }
let project: DemoProject | undefined, active: DemoFile | undefined, editor: TextEditor | undefined;
let comparison: TextComparison | undefined, find: FindController | undefined, activePane: TextEditor | undefined;
const foldMenu = mountDemoFoldMenu(codeMenu, () => comparison?.activePane() ?? editor);
let output: ReturnType<typeof mountDemoOutput> | undefined;
let setReviewCollapsed: ReturnType<typeof reviewLayout> | undefined;
let panel: "javascript" | "problems" | "changes" = "javascript", disposed = false, opening = 0;
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
let problemPage = 0, problemBatch: unknown;
function refreshBrackets(captured: TextEditor | undefined) {
    // Plain-source notifications may run inside a Workspace publication; retain the owning view.
    if (captured) queueMicrotask(() => { if (!captured.activity().disposed) captured.bracketMatching.refresh(); });
}
const presentation = new DemoPresentation(() => { syntaxLayer?.invalidate(); if (presentation.status === "ready") refreshBrackets(editor); renderOutput(); renderMetadata(); });
const indentation = element("indentation") as HTMLSelectElement;
function editingConfiguration(rules = presentation.editing) {
    const config = rules.configuration(indentation.value === "2" ? 2 : 4, indentation.value !== "tabs");
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
            output = mountDemoOutput(host, text, { minimap: field("view-minimap").checked, fontLigatures: field("view-ligatures").checked });
            bindPaneCommands(output.editor);
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
    const confirmed = state.status === "ready" && !state.checking;
    if (problemBatch !== state.diagnostics) { problemBatch = state.diagnostics; problemPage = 0; }
    const list = document.createElement("div"); list.className = "demo-problems";
    if (!state.diagnostics.length) {
        const note = document.createElement("p"); note.className = "panel-note";
        note.textContent = state.status === "failed" ? state.message : state.checking || state.status === "starting" ? "Checking types…" : "No problems in this project.";
        list.append(note);
    }
    if (state.diagnostics.length > 64) {
        const pages = document.createElement("div"), previous = document.createElement("button"), next = document.createElement("button"), count = document.createElement("span");
        pages.className = "problem-pages"; previous.textContent = "Previous problems"; next.textContent = "Next problems";
        previous.disabled = problemPage === 0; next.disabled = (problemPage + 1) * 64 >= state.diagnostics.length;
        count.textContent = `${problemPage * 64 + 1}–${Math.min((problemPage + 1) * 64, state.diagnostics.length)} of ${state.diagnostics.length}`;
        const move = (direction: number) => {
            if (project !== captured || captured.language.state.getSnapshot().diagnostics !== state.diagnostics) return;
            problemPage += direction; renderProblems();
        };
        previous.onclick = () => move(-1); next.onclick = () => move(1); pages.append(previous, count, next); list.append(pages);
    }
    for (const problem of state.diagnostics.slice(problemPage * 64, (problemPage + 1) * 64)) {
        const row = document.createElement("section"), item = document.createElement("button"), metadata = document.createElement("div");
        row.className = "demo-problem"; item.className = "problem-location"; metadata.className = "problem-metadata";
        const code = problem.code === undefined ? "" : `${problem.source === "typescript" ? "TS" : ""}${problem.code}: `;
        item.textContent = `${problem.name} · ${code}${problem.message}`;
        const current = () => project === captured && captured.language.state.getSnapshot() === state;
        const open = (target: { documentId: typeof problem.documentId; revision: number; from: number; to: number }) => {
            if (!current() || !confirmed || editor?.activity().composing) return false;
            const file = captured.files.find(file => file.resource.documentId === target.documentId);
            if (!file || captured.workspace.document(target.documentId).revision !== target.revision) return false;
            mountFile(file, true);
            if (!editor || !file.view.setSelection(target.revision, { anchor: target.from, head: target.to })) return false;
            editor.viewport.revealOffset(target.from); editor.focus(); return true;
        };
        item.disabled = !confirmed;
        item.addEventListener("click", () => open(problem));
        metadata.textContent = [({ 1: "Error", 2: "Warning", 3: "Information", 4: "Hint" } as Record<number, string>)[problem.severity ?? 1],
            problem.source, ...(!confirmed ? ["Awaiting recheck"] : []), ...(problem.tags ?? []).flatMap(tag => tag === 1 ? ["Unnecessary"] : tag === 2 ? ["Deprecated"] : [])].filter(Boolean).join(" · ");
        if (captured.files.some(file => file.resource.documentId === problem.documentId && !file.readOnly)) {
            const fixes = document.createElement("button"); fixes.textContent = "Check quick fixes"; fixes.disabled = !confirmed;
            fixes.onclick = () => { if (open(problem)) languageView?.run("quickfix"); };
            metadata.append(" · ", fixes);
        }
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
                related.replaceChildren(); if (!details.open) return;
                for (const info of problem.related.slice(page * 16, (page + 1) * 16)) {
                    const location = document.createElement("button"); location.textContent = `${info.name}:${info.line + 1}:${info.character + 1} · ${info.message}`;
                    location.disabled = !confirmed || !info.target; if (!info.target) location.title = "This related file is not loaded in the editor, or its range cannot be placed.";
                    location.onclick = () => { if (info.target) open(info.target); }; related.append(location);
                }
                if (problem.related.length > 16) {
                    const previous = document.createElement("button"), next = document.createElement("button");
                    previous.textContent = "Previous related locations"; next.textContent = "Next related locations";
                    previous.disabled = page === 0; next.disabled = (page + 1) * 16 >= problem.related.length;
                    previous.onclick = () => { if (current()) { page--; render(); } }; next.onclick = () => { if (current()) { page++; render(); } }; related.append(previous, next);
                }
            };
            details.addEventListener("toggle", render); row.append(details);
        }
        list.append(row);
    }
    host.replaceChildren(list);
}
function renderLanguage(): void {
    if (!project || disposed) return;
    const plain = hostLanguage();
    element("host-controls").hidden = element("host-status").hidden = project.sample.id !== "host";
    for (const id of ["complete", "inspect-type", "signature", "definition", "references", "rename", "quickfix"]) {
        button(id).disabled = plain || languageViewFailure !== undefined; button(id).hidden = plain;
    }
    button("block-comment").hidden = plain;
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
        diagnosticsLayer.set(revision, ranges.map(({ from, to }) => ({ from, to, className: "demo-diagnostic" })));
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
function paintMetadata(): void {
    if (!project || !active || disposed) return;
    if (activePane) {
        const buffer = activePane.workspace.document(activePane.view.documentId).buffer, { head } = activePane.view.getSnapshot().selection;
        const line = buffer.lineAt(head);
        element("cursor").textContent = `Ln ${line + 1}, Col ${head - buffer.offsetAt(line) + 1}`;
    }
    element("status").textContent = project.message;
    element("analysis-status").textContent = hostLanguage() ? "Host colors & editing rules" : referencePresentation?.status === "failed" ? "Saved-copy analysis unavailable" : presentation.status === "failed" ? "Analysis unavailable" : presentation.status === "ready"
        ? `TypeScript 5.9.3 · ${panel === "javascript" && !element("workspace").classList.contains("collapsed") ? "syntax & emit" : "syntax"}` : "TypeScript · analyzing…";
    element("analysis-retry").hidden = presentation.status !== "failed" && referencePresentation?.status !== "failed";
    button("save").disabled = project.saving;
    button("navigate-back").disabled = !locations.some(location => location.project === project);
    element("save-conflict").hidden = !project.hasConflict();
    button("conflict-save").disabled = !project.canSaveReviewed();
    if (reviewLabel) reviewLabel.textContent = project.isReviewingConflict() ? "Other page's saved copy" : "Saved copy";
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
    element("recovery-retry").hidden = recovery.status !== "failed";
    button("recovery-restore").disabled = !project.recovery.canRestore();
    button("recovery-keep").disabled = recovery.busy;
    for (const file of project.files) {
        let tab = element("files").querySelector<HTMLButtonElement>(`[data-file="${file.name}"]`);
        if (!tab) { tab = document.createElement("button"); tab.dataset.file = file.name; element("files").append(tab); }
        const label = `${file.name}${file.readOnly ? " (read-only)" : file.resource.metadata.getSnapshot().dirty ? " ●" : ""}`;
        if (tab.textContent !== label) tab.textContent = label; // Preserve native presses through background analysis updates.
        tab.setAttribute("aria-pressed", String(file === active));
    }
    document.title = `${project.dirty() ? "● " : ""}${active.name} · StTropez`;
}
function detachView(): void {
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
    element("editor").replaceChildren(); element("panel-content").replaceChildren();
    if (metadataFrame !== undefined) cancelAnimationFrame(metadataFrame); metadataFrame = undefined;
}
function openLocation(capturedProject: DemoProject, file: DemoFile, capturedEditor: TextEditor, target: DemoSymbolTarget): void {
    const state = capturedEditor.activity();
    if (disposed || project !== capturedProject || editor !== capturedEditor || state.disposed || state.composing || state.pendingInput || state.pendingCommand) return;
    const destination = capturedProject.files.find(file => file.resource.documentId === target.documentId);
    if (!destination || capturedProject.workspace.document(target.documentId).revision !== target.revision) return;
    locations.push({ project: capturedProject, file, revision: capturedProject.workspace.document(file.resource.documentId).revision,
        selected: file.view.getSnapshot().selectionSet, view: capturedEditor.captureView() });
    if (locations.length > 100) locations.shift();
    mountFile(destination, true); destination.view.setSelection(target.revision, { anchor: target.from, head: target.to });
    editor?.viewport.revealOffset(target.from); editor?.focus();
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
        return mountDemoLanguage(capturedProject.workspace, () => capturedProject.files, file, capturedEditor, capturedProject.language,
            target => openLocation(capturedProject, file, capturedEditor, target), report, element("language-command-status"));
    } catch (error) { report(error); }
}
function detachLanguage(): void {
    const previous = languageView; languageView = undefined; languageViewFailure = undefined;
    try { previous?.dispose(); } catch (error) { console.error(error); }
}
function mountFile(file: DemoFile, focus = false): void {
    if (!project || disposed || editor?.activity().composing) return;
    const viewState = editor?.captureView();
    const previous = active;
    if (previous && viewState) savedViews.set(previous.view, viewState);
    detachView(); active = file; activeFiles.set(project.sample.id, file.name);
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
        savedLabel.textContent = project.isReviewingConflict() ? "Other page's saved copy" : "Saved copy"; workingLabel.textContent = "Your changes";
        const hint = document.createElement("span"); hint.className = "demo-review-hint";
        hint.textContent = "Fold each pane independently. Shaded gaps keep matching lines aligned.";
        labels.append(savedLabel, workingLabel, hint); surface.prepend(labels);
        setReviewCollapsed = reviewLayout(surface, comparison);
        editor = comparison.panes.working;
        const reference = comparison.panes.reference, plain = hostLanguage();
        let tokens: DecorationProvider | undefined;
        const syntax: DemoPresentation | undefined = plain ? undefined : new DemoPresentation(() => {
            tokens?.invalidate(); if (syntax?.status === "ready") refreshBrackets(reference); renderMetadata();
        }, { emit: false, folds: true });
        referencePresentation = syntax;
        if (syntax || project.sample.id === "host") tokens = reference.decorations.addProvider({ name: "syntax", order: 0, provide: syntax?.decorate ?? hostDecorations });
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
    syntaxLayer = editor.decorations.addProvider({ name: "syntax", order: 0, provide: project.sample.id === "host" ? hostDecorations : presentation.decorate });
    diagnosticsLayer = editor.decorations.add({ name: "diagnostics", order: 40 });
    element("character-warning-details").replaceChildren();
    if (savedViews.has(file.view)) editor.restoreView({ ...savedViews.get(file.view)!, ...file.view.getSnapshot().selection,
        selectionSet: file.view.getSnapshot().selectionSet });
    folding = mountDemoFolding(project, editor, () => editingConfiguration().tabSize!);
    stopFolding = foldMenu.bind(editor, folding, comparison ? "Your changes" : "Source");
    viewListeners = new AbortController();
    surface.addEventListener(editRefusedEvent, event => {
        if (!project) return;
        const { reason } = (event as CustomEvent<EditRefusedDetail>).detail;
        project.message = reason === "edit-locked" ? "This file is locked for editing."
            : event.target === comparison?.panes.reference.element ? "The saved copy is read-only. Edit your working copy."
            : file.name + " is read-only.";
        element("status").textContent = project.message;
    }, { signal: viewListeners.signal });
    editor.input.addEventListener("compositionstart", renderMetadata, { signal: viewListeners.signal });
    editor.input.addEventListener("compositionend", renderMetadata, { signal: viewListeners.signal });
    editor.element.addEventListener("keydown", event => {
        if (event.isComposing || editor?.activity().composing || event.defaultPrevented) return;
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); return; }
    }, { signal: viewListeners.signal });
    bindPaneCommands(editor);
    if (comparison) bindPaneCommands(comparison.panes.reference);
    setActivePane(editor);
    languageView = attachLanguage(project, file, editor);
    if (project.sample.id === "host") {
        const capturedProject = project, capturedEditor = editor;
        hostIntegrations = mountHostIntegrations(project, file, editor, {
            mode: element("host-paste-mode") as HTMLSelectElement, insert: button("host-insert-table"), annotate: button("host-annotate"), status: element("host-status") },
            target => openLocation(capturedProject, file, capturedEditor, target));
    }
    if (element("workspace").classList.contains("collapsed")) setReviewCollapsed?.(true);
    renderMetadata(); renderLanguage(); renderOutput(); if (focus) editor.focus();
}
// View IDs are local to a Workspace; each sample owns a separate workspace.
const savedViews = new Map<DemoFile["view"], ReturnType<TextEditor["captureView"]>>();
const locations: { project: DemoProject; file: DemoFile; revision: number; selected: ReturnType<DemoFile["view"]["getSnapshot"]>["selectionSet"]; view: ReturnType<TextEditor["captureView"]> }[] = [];
function goBack(): void {
    if (!project || !editor || editor.activity().composing || editor.activity().pendingInput || editor.activity().pendingCommand) return;
    let index = locations.length - 1; while (index >= 0 && locations[index]!.project !== project) index--; if (index < 0) return;
    const location = locations.splice(index, 1)[0]!;
    mountFile(location.file, true);
    // Unchanged sources restore the exact directed selection set; edited sources keep their mapped view selections.
    if (project.workspace.document(location.file.resource.documentId).revision === location.revision) {
        location.file.view.setSelections(location.revision, location.selected.ranges, location.selected.primary); editor?.restoreView(location.view);
    }
    renderMetadata(); editor?.focus();
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
        const state = project?.sample.id === id ? editor?.activity() : undefined;
        return !state || !state.composing && !state.pendingInput && !state.pendingCommand;
    }, openProvider).then(next => {
        if (disposed) next.dispose();
        else projects.set(id, next);
        return next;
    }).finally(() => pendingProjects.delete(id));
    pendingProjects.set(id, load);
    return load;
}
async function openSample(id: SampleId): Promise<void> {
    if (editor?.activity().composing) { selectSample(project!.sample.id); return; }
    const generation = ++opening; selectSample(id);
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
    // A composition can start in the retained editor during asynchronous preparation.
    if (editor?.activity().composing) { selectSample(project!.sample.id); sample.disabled = false; return; }
    stopWorkspace?.(); stopWorkspace = undefined;
    stopRecovery?.(); stopRecovery = undefined;
    stopLanguage?.(); stopLanguage = undefined;
    if (active && editor) savedViews.set(active.view, editor.captureView());
    detachView(); project?.language.suspend(); active = undefined; project = next;
    selectSample(id); sample.disabled = false;
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
}
function setPanel(next: typeof panel): void {
    if (!active || editor?.activity().composing) return;
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
    if (samePanel && !comparison) { renderOutput(); editor?.focus(); return; }
    mountFile(active, true);
}
function bindPaneCommands(target: TextEditor): void {
    const stop = target.view.subscribe(() => {
        if (target === editor) renderMetadata();
        else if (target === activePane) scheduleMetadata();
    });
    target.signal.addEventListener("abort", stop, { once: true });
    target.element.addEventListener("focusin", () => setActivePane(target), { signal: target.signal });
    bindFindCommands(target, target.signal, replace => {
        setActivePane(target); openFind(replace);
    }, direction => {
        if (!field("find-query").value) return false;
        setActivePane(target, true); find?.next(direction, { whenReady: true });
        return true;
    });
    target.commands.register({ id: "find.close", label: "Close Find", enabled: () => !element("find-bar").hidden, run: closeFind });
    target.keymap.bind("Escape", "find.close", { shared: true });
}
function releaseFind(): void {
    stopFind?.(); stopFind = undefined; find?.dispose(); find = undefined;
}
function setActivePane(target: TextEditor, repeat = false): void {
    if (activePane === target && find) return;
    if (activePane !== target) { activePane = target; scheduleMetadata(); }
    releaseFind();
    const visible = !element("find-bar").hidden;
    if (!visible && !repeat) return;
    const current = createFindController(target, { highlightMatches: visible, regularExpressionBackend: createRegexFindBackend({
        clock: window, createWorker: () => new Worker(new URL("regex-worker.js", document.baseURI), { type: "module" }),
    }) });
    find = current; current.setFlags(findFlags());
    const label = target === output?.editor ? "JavaScript output" : target === comparison?.panes.reference ? "Saved copy" : active?.name;
    const readOnly = target !== editor || active?.readOnly;
    element("find-target").textContent = readOnly ? `${label} · read-only` : "";
    const render = () => {
        const snapshot = current.getSnapshot();
        element("find-status").textContent = findStatus(snapshot);
        const hasMatches = !readOnly && snapshot.count > 0;
        button("replace-all").disabled = !(hasMatches && snapshot.status === "ready");
        button("replace-current").disabled = !(hasMatches && (snapshot.status === "ready" || snapshot.status === "searching" && snapshot.retained));
    };
    stopFind = current.subscribe(render); render();
    current.setQuery(field("find-query").value);
}
function findFlags() {
    const pressed = (id: string) => button(id).getAttribute("aria-pressed") === "true";
    return { matchCase: pressed("find-case"), wholeWord: pressed("find-word"), regularExpression: pressed("find-regex") };
}
function findStatus(state: FindSnapshot): string {
    if (!state.query) return "";
    if (state.message && state.reason !== "replaced") return state.message;
    const count = state.current !== null ? `${state.current + 1} of ${state.count}`
        : state.count ? `${state.count} ${state.count === 1 ? "match" : "matches"}` : "";
    if (state.status === "searching") return count ? `Searching… ${count}` : "Searching…";
    const result = count || "No matches";
    if (state.reason === "replaced") return `${state.message} ${result}`;
    return state.wrappedTo ? `${result} · Wrapped to ${state.wrappedTo}` : result;
}
function selectedFindQuery(source: TextEditor, regex: boolean): string | undefined {
    const { anchor, head } = source.view.getSnapshot().selection, length = Math.abs(head - anchor);
    // The single-line Find field accepts a short selection even in a multi-megabyte document.
    const limit = 4096;
    if (!length || length > limit) return;
    const text = source.workspace.document(source.view.documentId).buffer.slice(Math.min(anchor, head), Math.max(anchor, head));
    if (/[\r\n]/.test(text)) return;
    const query = regex ? text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") : text;
    return query.length <= limit ? query : undefined;
}
function openFind(replace = false): void {
    const bar = element("find-bar"), query = field("find-query");
    if (!activePane) return;
    if (bar.hidden) {
        query.value = selectedFindQuery(activePane, findFlags().regularExpression) ?? query.value;
        releaseFind();
    }
    bar.hidden = false; element("replace-controls").hidden = !replace;
    setActivePane(activePane);
    const target = replace && activePane === editor && !active?.readOnly ? field("replacement") : query;
    target.focus(); target.select();
}
function closeFind(): void {
    element("find-bar").hidden = true;
    releaseFind(); activePane?.focus();
}
const on = (id: string, action: () => void) => element(id).addEventListener("click", action, { signal: listeners.signal });
element("panel-content").addEventListener(editRefusedEvent, () => {
    if (!project || panel !== "javascript") return;
    project.message = "Generated JavaScript is read-only. Edit the TypeScript source.";
    element("status").textContent = project.message;
}, { signal: listeners.signal });
on("find-toggle", () => { activePane?.commands.run("find.open"); });
on("find-close", () => { activePane?.commands.run("find.close"); });
for (const toggle of element("find-options").querySelectorAll("button")) {
    on(toggle.id, () => {
        toggle.setAttribute("aria-pressed", String(toggle.getAttribute("aria-pressed") !== "true"));
        find?.setFlags(findFlags());
        field("find-query").focus();
    });
}
on("replace-toggle", () => { element("replace-controls").hidden = !element("replace-controls").hidden; });
on("find-next", () => { activePane?.commands.run("find.next"); }); on("find-previous", () => { activePane?.commands.run("find.previous"); });
on("replace-current", () => { find?.replaceCurrent(field("replacement").value); });
on("replace-all", () => { find?.replaceAll(field("replacement").value, { focusEditor: true }); });
on("compare", () => setPanel("changes")); on("analysis-retry", () => { presentation.retry(); referencePresentation?.retry(); referenceFolding?.refresh(); });
on("inspect-type", () => languageView?.run("inspect"));
for (const id of ["complete", "signature", "definition", "references", "rename", "quickfix"] as const)
    on(id, () => languageView?.run(id));
on("navigate-back", goBack);
on("go-to-line", () => { editor?.focus(); editor?.commands.run("go-to-line"); });
on("inspect-characters", () => { if (editor && project) inspectCharacters(editor, project.workspace, element("character-warning-details")); });
field("character-warnings").addEventListener("change", () => {
    const enabled = field("character-warnings").checked;
    editor?.configure({ characterWarnings: enabled }); comparison?.panes.reference.configure({ characterWarnings: enabled });
    element("character-warning-details").replaceChildren();
}, { signal: listeners.signal });
for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) field(id).addEventListener("change", () => {
    const settings = presentationSettings();
    editor?.configure(settings); comparison?.panes.reference.configure(settings);
    output?.editor.configure({ minimap: settings.minimap, fontLigatures: settings.fontLigatures });
}, { signal: listeners.signal });
for (const command of ["line-comment", "block-comment", "indent", "outdent"] as const) on(command, () => {
    if (editor?.commands.run(command === "indent" ? "indent-lines" : command)) editor.focus();
});
indentation.addEventListener("change", () => {
    editor?.configure({ language: editingConfiguration() });
    comparison?.panes.reference.configure({ language: editingConfiguration(referencePresentation?.editing) }); folding?.refresh(); referenceFolding?.refresh(); editor?.focus();
}, { signal: listeners.signal });
codeMenu.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    // Inspection can replace its clicked entry before this bubbling listener runs.
    const inspection = event.composedPath().some(node => node instanceof HTMLElement && (node.id === "inspect-characters" || node.id === "character-warning-details"));
    if (target.closest("button") && !inspection) codeMenu.open = false;
}, { signal: listeners.signal });
for (const menu of [codeMenu, element("view-menu") as HTMLDetailsElement]) {
    document.addEventListener("pointerdown", event => { if (!menu.contains(event.target as Node)) menu.open = false; }, { signal: listeners.signal });
    menu.addEventListener("keydown", event => {
        if (event.key === "Escape" && menu.open) { event.preventDefault(); menu.open = false; menu.querySelector("summary")!.focus(); }
    }, { signal: listeners.signal });
}
on("language-retry", () => {
    const captured = project, file = active, view = editor; if (!captured || !file || !view) return;
    const mountFailed = languageViewFailure !== undefined;
    detachLanguage();
    if (mountFailed) { languageView = attachLanguage(captured, file, view); renderLanguage(); return; }
    const retry = captured.language.retry();
    languageView = attachLanguage(captured, file, view);
    void retry.then(() => {
        if (!disposed && project === captured && editor === view) folding?.refresh();
    }, () => { /* Connection failure is reported by the captured project. */ });
});
on("panel-collapse", () => {
    if (editor?.activity().composing) return;
    const collapsed = element("workspace").classList.toggle("collapsed"); element("panel-collapse").textContent = collapsed ? "Show" : "Hide";
    if (setReviewCollapsed) setReviewCollapsed(collapsed).focus();
    else if (collapsed && editor && output && activePane === output.editor) editor.focus();
    presentation.setEmit(!collapsed && panel === "javascript");
});
on("walkthrough-toggle", () => { element("walkthrough").hidden = !element("walkthrough").hidden; });
on("reset", () => {
    if (!project || project.sample.id !== sample.value || editor?.activity().composing || !window.confirm(`Restore the original files in “${project.sample.title}”? You can undo this change. Other samples and recovery drafts are kept. The saved copy changes only when you save locally.`)) return;
    project.reset(); renderMetadata(); editor?.focus();
});
async function save(reviewed = false): Promise<void> {
    const captured = project; if (!captured || editor?.activity().composing) return;
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
on("conflict-review", () => { if (project?.reviewConflict()) { setPanel("changes"); renderMetadata(); } });
onFileAction("conflict-save", () => { void save(true); });
onFileAction("recovery-restore", () => { void project?.recovery.restore(); });
element("recovery-version").addEventListener("change", event => {
    project?.recovery.selectVersion((event.currentTarget as HTMLSelectElement).selectedIndex);
}, { signal: listeners.signal });
onFileAction("recovery-keep", () => { void project?.recovery.keepCurrent(); });
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
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
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
field("find-query").addEventListener("input", () => find?.setQuery(field("find-query").value, { preview: true }), { signal: listeners.signal });
element("find-bar").addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || activePane?.keymap.handle(event)) return;
    if (event.key === "Enter" && event.target === field("find-query")) { event.preventDefault(); activePane?.commands.run(event.shiftKey ? "find.previous" : "find.next"); }
    else if (event.key === "Enter" && event.target === field("replacement")) { event.preventDefault(); button("replace-current").click(); }
}, { signal: listeners.signal });
for (const controls of document.querySelectorAll<HTMLElement>("header, #files, #panels")) {
    controls.addEventListener("keydown", event => { activePane?.keymap.handle(event); }, { signal: listeners.signal });
}
sample.addEventListener("change", () => { void openSample(sample.value as SampleId); }, { signal: listeners.signal });
element("files").addEventListener("click", event => {
    const name = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-file]")?.dataset.file;
    const file = project?.files.find(file => file.name === name); if (file) mountFile(file, true);
}, { signal: listeners.signal });
window.addEventListener("keydown", event => {
    if (!event.isComposing && !editor?.activity().composing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault(); void save();
    }
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
