import { mountEditingCandidate, mountTextComparison, createFindController } from "../../src/browser/index.ts";
import type { EditingCandidate, FindController, TextComparison } from "../../src/browser/index.ts";
import { DemoProject } from "./project.ts";
import type { DemoFile } from "./project.ts";
import { DemoPresentation } from "./presentation.ts";
import { sampleChoices } from "./samples.ts";
import type { SampleId } from "./samples.ts";
import { mountDemoLanguage } from "./language-view.ts";
import "./style.css";

const element = (id: string) => document.getElementById(id)!;
const field = (id: string) => element(id) as HTMLInputElement;
const button = (id: string) => element(id) as HTMLButtonElement;
const projects = new Map<SampleId, DemoProject>(), activeFiles = new Map<SampleId, string>();
const listeners = new AbortController(), sample = element("sample") as HTMLSelectElement;
for (const choice of sampleChoices) { const option = document.createElement("option"); option.value = choice.id; option.textContent = choice.title; sample.append(option); }
let project: DemoProject | undefined, active: DemoFile | undefined, editor: EditingCandidate | undefined;
let comparison: TextComparison | undefined, find: FindController | undefined;
let panel: "javascript" | "problems" | "changes" = "javascript", disposed = false, opening = 0;
let stopWorkspace: (() => void) | undefined, stopRecovery: (() => void) | undefined, stopView: (() => void) | undefined, stopFind: (() => void) | undefined;
let stopLanguage: (() => void) | undefined, languageView: ReturnType<typeof mountDemoLanguage> | undefined;
let viewListeners: AbortController | undefined;
let reviewLabel: HTMLSpanElement | undefined;
const presentation = new DemoPresentation(() => { editor?.viewport.invalidate(); renderOutput(); renderMetadata(); });

function renderOutput(): void {
    if (panel !== "javascript") return;
    const host = element("panel-content");
    if (presentation.status === "ready") {
        let pre = host.querySelector("pre"); if (!pre) { pre = document.createElement("pre"); host.replaceChildren(pre); }
        pre.textContent = presentation.javascript || "// This file emits no JavaScript.\n";
    } else {
        const note = document.createElement("p"); note.className = "panel-note";
        note.textContent = presentation.status === "failed" ? "JavaScript output is unavailable. Use Retry to restart analysis. Your source is still editable."
            : "Updating JavaScript…"; host.replaceChildren(note);
    }
}
function renderGutter(): void {
    if (!editor || panel === "changes") return;
    const viewport = editor.viewport.snapshot(), gutter = element("gutter");
    const spans: HTMLSpanElement[] = [];
    for (let line = viewport.firstLine; line <= viewport.lastLine; line++) {
        const number = document.createElement("span"); number.textContent = String(line + 1);
        number.style.top = `${12 + line * viewport.lineHeight - viewport.scrollTop}px`; spans.push(number);
    }
    gutter.replaceChildren(...spans);
}
function renderProblems(): void {
    if (!project || panel !== "problems") return;
    const captured = project, state = captured.language.state.getSnapshot(), host = element("panel-content");
    const list = document.createElement("div"); list.className = "demo-problems";
    if (!state.diagnostics.length) {
        const note = document.createElement("p"); note.className = "panel-note";
        note.textContent = state.status === "failed" ? state.message : state.checking || state.status === "starting" ? "Checking types…" : "No problems in this project.";
        list.append(note);
    }
    for (const problem of state.diagnostics) {
        const item = document.createElement("button"); item.textContent = `${problem.name} · TS${problem.code}: ${problem.message}`;
        item.addEventListener("click", () => {
            const file = captured.files.find(file => file.resource.documentId === problem.documentId);
            if (project !== captured || !file || editor?.snapshot().composing || captured.workspace.document(problem.documentId).revision !== problem.revision) return;
            mountFile(file, true); file.view.setSelection(problem.revision, { anchor: problem.from, head: problem.to });
            editor?.viewport.revealOffset(problem.from); editor?.focus();
        }); list.append(item);
    }
    host.replaceChildren(list);
}
function renderLanguage(): void {
    if (!project || disposed) return;
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
    const current = project.workspace.document(active.resource.documentId), selection = active.view.getSnapshot().selection;
    const line = current.buffer.lineAt(selection.head), column = selection.head - current.buffer.offsetAt(line);
    element("cursor").textContent = `Ln ${line + 1}, Col ${column + 1}`;
    element("status").textContent = project.message;
    element("analysis-status").textContent = presentation.status === "failed" ? "Analysis unavailable" : presentation.status === "ready"
        ? "TypeScript 5.9.3 · syntax & emit" : "TypeScript · analyzing…";
    element("analysis-retry").hidden = presentation.status !== "failed";
    button("save").disabled = project.saving;
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
        const tab = element("files").querySelector<HTMLButtonElement>(`[data-file="${file.name}"]`);
        if (tab) { tab.textContent = `${file.name}${file.resource.metadata.getSnapshot().dirty ? " ●" : ""}`; tab.setAttribute("aria-pressed", String(file === active)); }
    }
    document.title = `${project.dirty() ? "● " : ""}${active.name} · StTropez`;
    presentation.update(current);
}
function detachView(): void {
    languageView?.destroy(); languageView = undefined;
    stopView?.(); stopView = undefined; stopFind?.(); stopFind = undefined;
    viewListeners?.abort(); viewListeners = undefined;
    find?.destroy(); find = undefined; presentation.search = undefined;
    if (comparison) comparison.destroy(); else editor?.destroy();
    comparison = undefined; editor = undefined; reviewLabel = undefined;
    element("editor").replaceChildren(); element("panel-content").replaceChildren();
}
function mountFile(file: DemoFile, focus = false): void {
    if (!project || disposed || editor?.snapshot().composing) return;
    const viewState = editor?.captureView();
    const previous = active;
    if (previous && viewState) savedViews.set(previous.view.id, viewState);
    detachView(); active = file; activeFiles.set(project.sample.id, file.name);
    element("workspace").classList.toggle("reviewing", panel === "changes");
    if (panel === "changes") {
        comparison = mountTextComparison(element("panel-content"), project.workspace, file.tab, project.baseline(file),
            { view: file.view, workingDecorate: presentation.decorate, scrollLinked: true, rowsAligned: true, ariaLabel: `Changes in ${file.name}` });
        const labels = document.createElement("div"); labels.className = "demo-review-labels";
        const savedLabel = document.createElement("span"), workingLabel = document.createElement("span");
        reviewLabel = savedLabel;
        savedLabel.textContent = project.isReviewingConflict() ? "Other page's saved copy" : "Saved copy"; workingLabel.textContent = "Your changes";
        labels.append(savedLabel, workingLabel); element("panel-content").prepend(labels);
        editor = comparison.working;
    } else {
        editor = mountEditingCandidate(element("editor"), project.workspace, file.tab,
            { view: file.view, ariaLabel: file.name, decorate: presentation.decorate });
        renderProblems();
    }
    if (savedViews.has(file.view.id)) editor.restoreView(savedViews.get(file.view.id)!);
    viewListeners = new AbortController();
    editor.element.addEventListener("sttropez-render", renderGutter, { signal: viewListeners.signal });
    editor.input.addEventListener("compositionstart", renderMetadata, { signal: viewListeners.signal });
    editor.input.addEventListener("compositionend", renderMetadata, { signal: viewListeners.signal });
    editor.element.addEventListener("keydown", event => {
        if (event.isComposing || editor?.snapshot().composing || event.defaultPrevented) return;
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
    languageView = mountDemoLanguage(project.workspace, file, editor, project.language);
    renderMetadata(); renderLanguage(); renderOutput(); if (focus) editor.focus();
}
const savedViews = new Map<string, ReturnType<EditingCandidate["captureView"]>>();
async function openSample(id: SampleId): Promise<void> {
    if (editor?.snapshot().composing) { sample.value = project!.sample.id; return; }
    const generation = ++opening; sample.disabled = true;
    let next = projects.get(id);
    if (!next) { next = await DemoProject.open(id, () => project?.sample.id !== id || !editor?.snapshot().composing); if (disposed) { next.dispose(); return; } projects.set(id, next); }
    if (disposed || generation !== opening) return;
    stopWorkspace?.(); stopWorkspace = undefined;
    stopRecovery?.(); stopRecovery = undefined;
    stopLanguage?.(); stopLanguage = undefined;
    if (active && editor) savedViews.set(active.view.id, editor.captureView());
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
    if (!active || editor?.snapshot().composing) return; panel = next;
    element("workspace").classList.remove("collapsed"); element("panel-collapse").textContent = "Hide";
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
on("compare", () => setPanel("changes")); on("analysis-retry", () => presentation.retry());
on("complete", () => languageView?.complete());
on("inspect-type", () => languageView?.inspect()); on("signature", () => languageView?.signature());
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
        if (!disposed && project === captured && editor === view) languageView = mountDemoLanguage(captured.workspace, file, view, captured.language);
    }).catch(() => {});
});
on("panel-collapse", () => {
    if (panel === "changes") setPanel("javascript");
    const collapsed = element("workspace").classList.toggle("collapsed"); element("panel-collapse").textContent = collapsed ? "Show" : "Hide";
});
on("walkthrough-toggle", () => { element("walkthrough").hidden = !element("walkthrough").hidden; });
on("reset", () => {
    if (!project || editor?.snapshot().composing || !window.confirm("Restore the original sample in all its files? You can undo this change. The saved copy changes only when you save locally.")) return;
    project.reset(); renderMetadata(); editor?.focus();
});
async function save(reviewed = false): Promise<void> {
    const captured = project; if (!captured || editor?.snapshot().composing) return;
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
    if (!event.isComposing && !editor?.snapshot().composing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
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
