import { mountTextEditor, mountTextComparison, createFindController, createRegexFindBackend, createFoldingController } from "../../src/browser/index.ts";
import type { TextEditor, FindController, TextComparison, FoldingController, DecorationLayer, DecorationProvider } from "../../src/browser/index.ts";
import { discoverIndentationFolds } from "../../src/index.ts";
import { DemoProject } from "./project.ts";
import { linePrompt } from "../shared/line-prompt.ts";
import { selectDemoProvider } from "./provider.ts";
import type { DemoFile } from "./project.ts";
import { DemoPresentation } from "./presentation.ts";
import { sampleChoices } from "./samples.ts";
import type { SampleId } from "./samples.ts";
import { mountDemoLanguage } from "./language-view.ts";
import type { DemoSymbolTarget } from "./symbols.ts";
import { mountDemoOutput } from "./output.ts";
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
const listeners = new AbortController(), sample = element("sample") as HTMLSelectElement;
const pageOptions = new URL(location.href).searchParams;
const openProvider = selectDemoProvider(pageOptions.get("provider") ?? document.documentElement.dataset.demoProvider ?? "browser");
for (const choice of sampleChoices) { const option = document.createElement("option"); option.value = choice.id; option.textContent = choice.title; sample.append(option); }
let project: DemoProject | undefined, active: DemoFile | undefined, editor: TextEditor | undefined;
let comparison: TextComparison | undefined, find: FindController | undefined;
const foldMenu = mountDemoFoldMenu(codeMenu, () => comparison?.activePane() ?? editor);
let output: ReturnType<typeof mountDemoOutput> | undefined;
let panel: "javascript" | "problems" | "changes" = "javascript", disposed = false, opening = 0;
let metadataFrame: number | undefined;
let stopWorkspace: (() => void) | undefined, stopRecovery: (() => void) | undefined, stopView: (() => void) | undefined, stopFind: (() => void) | undefined;
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
            if (!current() || !confirmed || editor?.activity().composing) return;
            const file = captured.files.find(file => file.resource.documentId === target.documentId);
            if (!file || captured.workspace.document(target.documentId).revision !== target.revision) return;
            mountFile(file, true); file.view.setSelection(target.revision, { anchor: target.from, head: target.to });
            editor?.viewport.revealOffset(target.from); editor?.focus();
        };
        item.disabled = !confirmed;
        item.addEventListener("click", () => open(problem));
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
function renderMetadata(): void {
    if (!project || !active || disposed) return;
    if (metadataFrame === undefined) metadataFrame = requestAnimationFrame(() => { metadataFrame = undefined; paintMetadata(); });
    // Capture every revision immediately. Deferring this with the DOM would skip position
    // maps and lose provisional colors when several edits arrive before one frame.
    presentation.update(project.workspace.document(active.resource.documentId), hostLanguage());
}
function paintMetadata(): void {
    if (!project || !active || disposed) return;
    const current = project.workspace.document(active.resource.documentId), selection = active.view.getSnapshot().selection;
    const line = current.buffer.lineAt(selection.head), column = selection.head - current.buffer.offsetAt(line);
    element("cursor").textContent = `Ln ${line + 1}, Col ${column + 1}`;
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
    output?.dispose(); output = undefined;
    detachLanguage();
    stopView?.(); stopView = undefined; stopFind?.(); stopFind = undefined;
    viewListeners?.abort(); viewListeners = undefined;
    find?.dispose(); find = undefined; syntaxLayer = undefined; diagnosticsLayer = undefined; paintedDiagnostics = undefined;
    if (comparison) comparison.dispose(); else editor?.dispose();
    comparison = undefined; editor = undefined; reviewLabel = undefined;
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
            target => openLocation(capturedProject, file, capturedEditor, target), report);
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
    editor.input.addEventListener("compositionstart", renderMetadata, { signal: viewListeners.signal });
    editor.input.addEventListener("compositionend", renderMetadata, { signal: viewListeners.signal });
    editor.element.addEventListener("keydown", event => {
        if (event.isComposing || editor?.activity().composing || event.defaultPrevented) return;
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); return; }
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === "f" || key === "h") { event.preventDefault(); openFind(key === "h"); }
        } else if (event.key === "F3") { event.preventDefault(); find?.next(event.shiftKey ? -1 : 1); }
    }, { signal: viewListeners.signal });
    find = createFindController(editor, { regularExpressionBackend: createRegexFindBackend({
        clock: window, createWorker: () => new Worker(new URL("regex-worker.js", document.baseURI), { type: "module" }),
    }) });
    find.setFlags({ matchCase: false, regularExpression: button("find-regex").getAttribute("aria-pressed") === "true" });
    const capturedFind = find;
    const renderFind = () => {
        const snapshot = capturedFind.getSnapshot();
        element("find-status").textContent = snapshot.message || `${snapshot.status === "searching" ? "Searching… " : ""}${snapshot.count} matches`;
        const hasMatches = !file.readOnly && snapshot.count > 0;
        button("replace-all").disabled = !(hasMatches && snapshot.status === "ready");
        button("replace-current").disabled = !(hasMatches && (snapshot.status === "ready" || snapshot.status === "searching" && snapshot.retained));
    };
    stopFind = find.subscribe(renderFind); renderFind();
    if (!element("find-bar").hidden) find.setQuery(field("find-query").value);
    stopView = file.view.subscribe(renderMetadata);
    languageView = attachLanguage(project, file, editor);
    if (project.sample.id === "host") {
        const capturedProject = project, capturedEditor = editor;
        hostIntegrations = mountHostIntegrations(project, file, editor, {
            mode: element("host-paste-mode") as HTMLSelectElement, insert: button("host-insert-table"), annotate: button("host-annotate"), status: element("host-status") },
            target => openLocation(capturedProject, file, capturedEditor, target));
    }
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
async function openSample(id: SampleId): Promise<void> {
    if (editor?.activity().composing) { selectSample(project!.sample.id); return; }
    const generation = ++opening; selectSample(id); sample.disabled = true;
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
        sample.disabled = true;
    }
    let next = projects.get(id);
    if (!next) {
        try {
            next = await DemoProject.open(id, () => {
                const state = project?.sample.id === id ? editor?.activity() : undefined;
                return !state || !state.composing && !state.pendingInput && !state.pendingCommand;
            }, openProvider);
        } catch (error) {
            console.error(error);
            if (disposed || generation !== opening) return;
            showSampleError("Could not open this sample. Choose a sample to try again.");
            return;
        }
        if (disposed) { next.dispose(); return; } projects.set(id, next);
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
    if (!active || editor?.activity().composing) return; panel = next;
    element("workspace").classList.remove("collapsed"); element("panel-collapse").textContent = "Hide";
    presentation.setEmit(panel === "javascript");
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) tab.setAttribute("aria-pressed", String(tab.dataset.panel === panel));
    mountFile(active, true);
}
function openFind(replace = false): void {
    element("find-bar").hidden = false; element("replace-controls").hidden = !replace;
    find?.setQuery(field("find-query").value); const target = field(replace ? "replacement" : "find-query"); target.focus(); target.select();
}
function closeFind(): void { element("find-bar").hidden = true; find?.cancel(); editor?.focus(); }
const on = (id: string, action: () => void) => element(id).addEventListener("click", action, { signal: listeners.signal });
on("find-toggle", () => openFind()); on("find-close", closeFind);
on("find-regex", () => {
    const toggle = button("find-regex"), enabled = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(enabled)); find?.setFlags({ regularExpression: enabled });
    field("find-query").focus();
});
on("replace-toggle", () => { element("replace-controls").hidden = !element("replace-controls").hidden; });
on("find-next", () => { find?.next(); }); on("find-previous", () => { find?.next(-1); });
on("replace-current", () => { find?.replaceCurrent(field("replacement").value); });
on("replace-all", () => { find?.replaceAll(field("replacement").value, { focusEditor: true }); });
on("compare", () => setPanel("changes")); on("analysis-retry", () => { presentation.retry(); referencePresentation?.retry(); referenceFolding?.refresh(); });
on("complete", () => languageView?.complete());
on("inspect-type", () => languageView?.inspect()); on("signature", () => languageView?.signature());
on("definition", () => languageView?.definition()); on("references", () => languageView?.references()); on("rename", () => languageView?.rename());
on("navigate-back", goBack);
on("go-to-line", () => { editor?.focus(); editor?.runCommand("go-to-line"); });
on("inspect-characters", () => { if (editor && project) inspectCharacters(editor, project.workspace, element("character-warning-details")); });
field("character-warnings").addEventListener("change", () => {
    const enabled = field("character-warnings").checked;
    editor?.configure({ characterWarnings: enabled }); comparison?.panes.reference.configure({ characterWarnings: enabled });
    element("character-warning-details").replaceChildren();
}, { signal: listeners.signal });
for (const id of ["view-rulers", "view-current-line", "view-ligatures", "view-trailing-space", "view-minimap"]) field(id).addEventListener("change", () => {
    const settings = presentationSettings();
    editor?.configure(settings); comparison?.panes.reference.configure(settings);
    output?.configure({ minimap: settings.minimap, fontLigatures: settings.fontLigatures });
}, { signal: listeners.signal });
on("quickfix", () => languageView?.quickfix());
for (const command of ["line-comment", "block-comment", "indent", "outdent"] as const) on(command, () => {
    if (editor?.runCommand(command === "indent" ? "indent-lines" : command)) editor.focus();
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
    void captured.language.retry().then(() => {
        if (!disposed && project === captured && editor === view) { languageView = attachLanguage(captured, file, view); folding?.refresh(); }
    }, () => { /* Connection failure is reported by the captured project. */ });
});
on("panel-collapse", () => {
    if (panel === "changes") setPanel("javascript");
    const collapsed = element("workspace").classList.toggle("collapsed"); element("panel-collapse").textContent = collapsed ? "Show" : "Hide";
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
on("save", () => { void save(); });
on("conflict-review", () => { if (project?.reviewConflict()) { setPanel("changes"); renderMetadata(); } });
on("conflict-save", () => { void save(true); });
on("recovery-restore", () => { void project?.recovery.restore(); });
on("recovery-keep", () => { void project?.recovery.keepCurrent(); });
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
field("find-query").addEventListener("input", () => find?.setQuery(field("find-query").value), { signal: listeners.signal });
element("find-bar").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeFind(); }
    else if (event.key === "Enter" && event.target === field("find-query")) { event.preventDefault(); find?.next(event.shiftKey ? -1 : 1); }
    else if (event.key === "Enter" && event.target === field("replacement")) { event.preventDefault(); button("replace-current").click(); }
}, { signal: listeners.signal });
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
