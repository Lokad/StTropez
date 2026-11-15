import { mountEditingCandidate, mountTextComparison, createFindController, createFoldingController } from "../../src/browser/index.ts";
import type { EditingCandidate, FindController, TextComparison, FoldingController } from "../../src/browser/index.ts";
import { discoverIndentationFolds } from "../../src/index.ts";
import { DemoProject } from "./project.ts";
import type { DemoFile } from "./project.ts";
import { DemoPresentation } from "./presentation.ts";
import { sampleChoices } from "./samples.ts";
import type { SampleId } from "./samples.ts";
import { mountDemoLanguage } from "./language-view.ts";
import { mountDemoOutput } from "./output.ts";
import { mountDemoFolding, outlineFolds } from "./folding.ts";
import { canOpenDemoHelp } from "./diagnostics.ts";
import { hostConfiguration, hostDecorations, mountHostIntegrations } from "./host-integrations.ts";
import "./style.css";

const element = (id: string) => document.getElementById(id)!;
const field = (id: string) => element(id) as HTMLInputElement;
const button = (id: string) => element(id) as HTMLButtonElement;
const projects = new Map<SampleId, DemoProject>(), activeFiles = new Map<SampleId, string>();
const listeners = new AbortController(), sample = element("sample") as HTMLSelectElement;
for (const choice of sampleChoices) { const option = document.createElement("option"); option.value = choice.id; option.textContent = choice.title; sample.append(option); }
let project: DemoProject | undefined, active: DemoFile | undefined, editor: EditingCandidate | undefined;
let comparison: TextComparison | undefined, find: FindController | undefined;
let output: ReturnType<typeof mountDemoOutput> | undefined;
let panel: "javascript" | "problems" | "changes" = "javascript", disposed = false, opening = 0;
let metadataFrame: number | undefined;
let stopWorkspace: (() => void) | undefined, stopRecovery: (() => void) | undefined, stopView: (() => void) | undefined, stopFind: (() => void) | undefined;
let stopLanguage: (() => void) | undefined, languageView: ReturnType<typeof mountDemoLanguage> | undefined;
let stopReference: (() => void) | undefined;
let folding: FoldingController | undefined, referenceFolding: FoldingController | undefined, stopFolding: (() => void) | undefined;
let viewListeners: AbortController | undefined;
let reviewLabel: HTMLSpanElement | undefined;
let hostIntegrations: ReturnType<typeof mountHostIntegrations> | undefined;
const hostLanguage = () => project?.sample.id === "outline" || project?.sample.id === "host";
let referencePresentation: DemoPresentation | undefined;
let problemPage = 0, problemBatch: unknown;
const presentation = new DemoPresentation(() => { editor?.viewport.invalidate(); renderOutput(); renderMetadata(); });
const indentation = element("indentation") as HTMLSelectElement;
function editingConfiguration() {
    const config = presentation.editing.configuration(indentation.value === "2" ? 2 : 4, indentation.value !== "tabs");
    if (project?.sample.id === "host") return hostConfiguration(config.tabSize!, config.insertSpaces!);
    return project?.sample.id === "outline" ? { tabSize: config.tabSize!, insertSpaces: config.insertSpaces!, lineComment: "#", pairs: [], enter: "keep" as const } : config;
}
function renderFolding(): void {
    const state = folding?.state.getSnapshot(), select = element("fold-group") as HTMLSelectElement, chosen = select.value;
    const groups = state?.groups ?? [], all = document.createElement("option"); all.value = ""; all.textContent = "All groups";
    select.replaceChildren(all, ...groups.map(group => { const option = document.createElement("option"); option.value = group; option.textContent = group; return option; }));
    if (groups.includes(chosen)) select.value = chosen;
    element("folding-status").textContent = !state ? "" : state.message || `${state.regions} folds · ${state.collapsed} collapsed`;
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
        else { host.replaceChildren(); output = mountDemoOutput(host, text); }
    } else if (!output) {
        // Keep the last completed output for this view while the footer reports pending/failed analysis.
        const note = document.createElement("p"); note.className = "panel-note";
        note.textContent = presentation.status === "failed" ? "JavaScript output is unavailable. Use Retry to restart analysis. Your source is still editable."
            : "Updating JavaScript…"; host.replaceChildren(note);
    }
}
function renderGutter(): void {
    if (!editor || panel === "changes") return;
    const viewport = editor.viewport.snapshot(), gutter = element("gutter");
    const spans: HTMLSpanElement[] = [], index = editor.view.folding.getSnapshot().index;
    if (viewport.firstLine < 0 || viewport.lastLine > index.lineCount || viewport.lastLine <= viewport.firstLine) { gutter.replaceChildren(); return; }
    for (let row = index.rowAt(viewport.firstLine), last = index.rowAt(viewport.lastLine - 1); row <= last; row++) {
        const line = index.lineAt(row);
        const number = document.createElement("span"); number.textContent = String(line + 1);
        number.style.top = `${12 + row * viewport.lineHeight - viewport.scrollTop}px`; spans.push(number);
    }
    gutter.replaceChildren(...spans);
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
        button(id).disabled = plain; button(id).hidden = plain;
    }
    button("block-comment").hidden = plain;
    if (plain) {
        element("language-status").textContent = project.sample.id === "host" ? "Host language · no language server" : "Host outline · no language server"; element("language-retry").hidden = true;
        document.querySelector<HTMLButtonElement>('[data-panel="problems"]')!.textContent = "Problems";
        presentation.diagnostics = undefined; renderProblems(); return;
    }
    const state = project.language.state.getSnapshot();
    element("language-status").textContent = state.status === "failed" ? "Language service unavailable" : state.status === "starting" ? "Starting language service…"
        : state.checking ? "Checking types…" : state.status === "ready" ? "Language ready" : "Language service idle";
    element("language-retry").hidden = state.status !== "failed";
    element("language-status").title = state.message;
    const problems = document.querySelector<HTMLButtonElement>('[data-panel="problems"]')!;
    problems.textContent = state.diagnostics.length ? `Problems (${state.diagnostics.length})` : "Problems";
    if (active) {
        const revision = project.workspace.document(active.resource.documentId).revision;
        presentation.diagnostics = { documentId: active.resource.documentId, revision,
            ranges: state.diagnostics.filter(problem => problem.documentId === active!.resource.documentId && problem.revision === revision) };
        editor?.viewport.invalidate();
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
    stopFolding?.(); stopFolding = undefined; folding?.dispose(); folding = undefined; referenceFolding?.dispose(); referenceFolding = undefined;
    stopReference?.(); stopReference = undefined;
    referencePresentation?.dispose(); referencePresentation = undefined;
    output?.destroy(); output = undefined;
    languageView?.destroy(); languageView = undefined;
    stopView?.(); stopView = undefined; stopFind?.(); stopFind = undefined;
    viewListeners?.abort(); viewListeners = undefined;
    find?.destroy(); find = undefined; presentation.search = undefined;
    if (comparison) comparison.destroy(); else editor?.destroy();
    comparison = undefined; editor = undefined; reviewLabel = undefined;
    element("editor").replaceChildren(); element("panel-content").replaceChildren();
    if (metadataFrame !== undefined) cancelAnimationFrame(metadataFrame); metadataFrame = undefined;
}
function attachLanguage(capturedProject: DemoProject, file: DemoFile, capturedEditor: EditingCandidate) {
    if (capturedProject.sample.id === "outline" || capturedProject.sample.id === "host") return;
    return mountDemoLanguage(capturedProject.workspace, () => capturedProject.files, file, capturedEditor, capturedProject.language, target => {
        if (disposed || project !== capturedProject || editor !== capturedEditor) return;
        const destination = capturedProject.files.find(file => file.resource.documentId === target.documentId);
        if (!destination || capturedProject.workspace.document(target.documentId).revision !== target.revision) return;
        locations.push({ project: capturedProject, file, revision: capturedProject.workspace.document(file.resource.documentId).revision,
            selected: file.view.getSnapshot().selectionSet, view: capturedEditor.captureView() });
        if (locations.length > 100) locations.shift();
        mountFile(destination, true); destination.view.setSelection(target.revision, { anchor: target.from, head: target.to });
        editor?.viewport.revealOffset(target.from); editor?.focus();
    });
}
function mountFile(file: DemoFile, focus = false): void {
    if (!project || disposed || editor?.activity().composing) return;
    const viewState = editor?.captureView();
    const previous = active;
    if (previous && viewState) savedViews.set(previous.view, viewState);
    detachView(); active = file; activeFiles.set(project.sample.id, file.name);
    element("workspace").classList.toggle("reviewing", panel === "changes");
    if (panel === "changes") {
        comparison = mountTextComparison(element("panel-content"), project.workspace, file.tab, project.baseline(file),
            { view: file.view, workingDecorate: line => [...(project?.sample.id === "host" ? hostDecorations(line) : presentation.decorate(line)), ...(languageView?.decorate(line) ?? [])],
                baselineDecorate: line => project?.sample.id === "host" ? hostDecorations(line) : referencePresentation?.decorate(line) ?? [], scrollLinked: true, rowsAligned: true, ariaLabel: `Changes in ${file.name}` });
        const labels = document.createElement("div"); labels.className = "demo-review-labels";
        const savedLabel = document.createElement("span"), workingLabel = document.createElement("span");
        reviewLabel = savedLabel;
        savedLabel.textContent = project.isReviewingConflict() ? "Other page's saved copy" : "Saved copy"; workingLabel.textContent = "Your changes";
        const hint = document.createElement("span"); hint.className = "demo-review-hint";
        hint.textContent = "Fold each pane independently. Shaded gaps keep matching lines aligned.";
        labels.append(savedLabel, workingLabel, hint); element("panel-content").prepend(labels);
        editor = comparison.working;
        const configureReference = () => {
            referenceFolding?.dispose(); referenceFolding = undefined;
            referencePresentation?.dispose(); referencePresentation = undefined;
            const reference = comparison?.reference.getSnapshot(); if (!reference) return;
            reference.editor.configureLanguage(editingConfiguration());
            const plain = hostLanguage();
            const syntax = plain ? undefined : new DemoPresentation(() => { reference.editor.viewport.invalidate(); renderMetadata(); }, { emit: false, folds: true });
            referencePresentation = syntax;
            syntax?.update(project!.workspace.document(reference.editor.view.documentId));
            referenceFolding = createFoldingController(project!.workspace, reference.target.id, reference.editor,
                (capture, signal) => plain
                    ? discoverIndentationFolds(capture.buffer, outlineFolds(editingConfiguration().tabSize!)) : syntax!.discoverFolds(capture, signal));
        };
        let referenceSyncQueued = false, referenceSyncActive = true;
        const unsubscribeReference = comparison.reference.subscribe(() => {
            if (referenceSyncQueued) return; referenceSyncQueued = true;
            queueMicrotask(() => { referenceSyncQueued = false; if (referenceSyncActive) configureReference(); });
        });
        stopReference = () => { referenceSyncActive = false; unsubscribeReference(); }; configureReference();
    } else {
        editor = mountEditingCandidate(element("editor"), project.workspace, file.tab,
            { view: file.view, ariaLabel: file.name, decorate: line => [...(project?.sample.id === "host" ? hostDecorations(line) : presentation.decorate(line)), ...(languageView?.decorate(line) ?? [])] });
        renderProblems();
    }
    editor.configureLanguage(editingConfiguration());
    if (savedViews.has(file.view)) editor.restoreView({ ...savedViews.get(file.view)!, ...file.view.getSnapshot().selection,
        selectionSet: file.view.getSnapshot().selectionSet });
    folding = mountDemoFolding(project, file, editor, () => editingConfiguration().tabSize!);
    stopFolding = folding.state.subscribe(renderFolding); renderFolding();
    viewListeners = new AbortController();
    editor.element.addEventListener("sttropez-render", renderGutter, { signal: viewListeners.signal });
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
    find = createFindController(project.workspace, file.tab, editor);
    find.setOptions({ matchCase: false });
    const renderFind = () => {
        const snapshot = find!.state.getSnapshot(); presentation.search = { revision: snapshot.revision, ranges: snapshot.preview };
        element("find-status").textContent = snapshot.message || `${snapshot.count} matches`;
        editor?.viewport.invalidate();
    };
    stopFind = find.state.subscribe(renderFind); if (!element("find-bar").hidden) find.setQuery(field("find-query").value);
    stopView = file.view.subscribe(renderMetadata);
    languageView = attachLanguage(project, file, editor);
    if (project.sample.id === "host") hostIntegrations = mountHostIntegrations(project, file, editor, {
        mode: element("host-paste-mode") as HTMLSelectElement, insert: button("host-insert-table"), annotate: button("host-annotate"), status: element("host-status") });
    renderMetadata(); renderLanguage(); renderOutput(); if (focus) editor.focus();
}
// View IDs are local to a Workspace; each sample owns a separate workspace.
const savedViews = new Map<DemoFile["view"], ReturnType<EditingCandidate["captureView"]>>();
const locations: { project: DemoProject; file: DemoFile; revision: number; selected: ReturnType<DemoFile["view"]["getSnapshot"]>["selectionSet"]; view: ReturnType<EditingCandidate["captureView"]> }[] = [];
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
async function openSample(id: SampleId): Promise<void> {
    if (editor?.activity().composing) { sample.value = project!.sample.id; return; }
    const generation = ++opening; sample.disabled = true;
    let next = projects.get(id);
    if (!next) { next = await DemoProject.open(id, () => {
        const state = project?.sample.id === id ? editor?.activity() : undefined;
        return !state || !state.composing && !state.pendingInput && !state.pendingCommand;
    }); if (disposed) { next.dispose(); return; } projects.set(id, next); }
    if (disposed || generation !== opening) return;
    stopWorkspace?.(); stopWorkspace = undefined;
    stopRecovery?.(); stopRecovery = undefined;
    stopLanguage?.(); stopLanguage = undefined;
    if (active && editor) savedViews.set(active.view, editor.captureView());
    detachView(); project?.language.suspend(); active = undefined; project = next;
    sample.value = id; sample.disabled = false;
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
on("replace-toggle", () => { element("replace-controls").hidden = !element("replace-controls").hidden; });
on("find-next", () => { find?.next(); }); on("find-previous", () => { find?.next(-1); });
on("replace-current", () => { find?.replaceCurrent(field("replacement").value); });
on("replace-all", () => { find?.replaceAll(field("replacement").value); });
on("compare", () => setPanel("changes")); on("analysis-retry", () => { presentation.retry(); referencePresentation?.retry(); referenceFolding?.refresh(); });
on("complete", () => languageView?.complete());
on("inspect-type", () => languageView?.inspect()); on("signature", () => languageView?.signature());
on("definition", () => languageView?.definition()); on("references", () => languageView?.references()); on("rename", () => languageView?.rename());
on("navigate-back", goBack);
on("quickfix", () => languageView?.quickfix());
for (const command of ["line-comment", "block-comment", "indent", "outdent"] as const) on(command, () => {
    if (editor?.runCommand(command)) editor.focus();
});
indentation.addEventListener("change", () => {
    editor?.configureLanguage(editingConfiguration());
    comparison?.referenceEditor()?.configureLanguage(editingConfiguration()); folding?.refresh(); referenceFolding?.refresh(); editor?.focus();
}, { signal: listeners.signal });
on("fold", () => { folding?.runCommand("collapse"); }); on("unfold", () => { folding?.runCommand("expand"); });
on("fold-group-collapse", () => { folding?.runCommand("collapse-all", (element("fold-group") as HTMLSelectElement).value || undefined); });
on("fold-group-expand", () => { folding?.runCommand("expand-all", (element("fold-group") as HTMLSelectElement).value || undefined); });
const codeMenu = element("code-menu") as HTMLDetailsElement;
codeMenu.addEventListener("click", event => { if ((event.target as HTMLElement).closest("button")) codeMenu.open = false; }, { signal: listeners.signal });
document.addEventListener("pointerdown", event => { if (!codeMenu.contains(event.target as Node)) codeMenu.open = false; }, { signal: listeners.signal });
codeMenu.addEventListener("keydown", event => {
    if (event.key === "Escape" && codeMenu.open) { event.preventDefault(); codeMenu.open = false; codeMenu.querySelector("summary")!.focus(); }
}, { signal: listeners.signal });
on("language-retry", () => {
    const captured = project, file = active, view = editor; if (!captured || !file || !view) return;
    languageView?.destroy(); languageView = undefined;
    void captured.language.retry().then(() => {
        if (!disposed && project === captured && editor === view) { languageView = attachLanguage(captured, file, view); folding?.refresh(); }
    }).catch(() => {});
});
on("panel-collapse", () => {
    if (panel === "changes") setPanel("javascript");
    const collapsed = element("workspace").classList.toggle("collapsed"); element("panel-collapse").textContent = collapsed ? "Show" : "Hide";
    presentation.setEmit(!collapsed && panel === "javascript");
});
on("walkthrough-toggle", () => { element("walkthrough").hidden = !element("walkthrough").hidden; });
on("reset", () => {
    if (!project || editor?.activity().composing || !window.confirm(`Restore the original files in “${project.sample.title}”? You can undo this change. Other samples and recovery drafts are kept. The saved copy changes only when you save locally.`)) return;
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
    else if (event.key === "Enter") { event.preventDefault(); if (event.target === field("replacement")) find?.replaceCurrent(field("replacement").value); else find?.next(event.shiftKey ? -1 : 1); }
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
window.addEventListener("pagehide", () => {
    disposed = true; opening++; listeners.abort(); stopWorkspace?.(); stopRecovery?.(); stopLanguage?.(); detachView(); presentation.dispose();
    for (const project of projects.values()) project.dispose(); projects.clear(); savedViews.clear();
}, { once: true });
await openSample("pricing");
