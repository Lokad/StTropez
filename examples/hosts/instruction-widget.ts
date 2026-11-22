import { isPrimaryShortcut, isUnmodifiedShortcut } from "../shared/host-shortcuts.ts";
import { exportText, textDifference } from "../../src/index.ts";
import type { TabId } from "../../src/index.ts";
import type { TextEditor } from "../../src/browser/index.ts";
import type { HostController } from "./controller.ts";
import type { InstructionCapture } from "./instruction.ts";
import type { InstructionField } from "./instruction-syntax.ts";

type FieldView = Readonly<{ start: number; end: number; direction: "forward" | "backward" | "none"; scrollTop: number }>;
export type InstructionViewState = { generation: number; fields: Partial<Record<InstructionField, FieldView>>; focus: InstructionField | undefined };
type InputCapture = Readonly<{ model: InstructionCapture; raw: string; projection: ReturnType<typeof exportText> }>;
type Field = { key: InstructionField; node: HTMLTextAreaElement; capture: InputCapture | undefined; composing: boolean; ignored: boolean };

export function mountInstructionWidget(host: HTMLElement, lane: HTMLElement, editor: TextEditor, controller: HostController, tabId: TabId, memory: InstructionViewState) {
    const owner = host.ownerDocument, win = owner.defaultView!, model = controller.instruction, target = controller.workspace.tabs.capture(tabId), listeners = new AbortController();
    let frame: number | undefined, panel: HTMLDivElement | undefined, fieldListeners: AbortController | undefined, fields: Field[] = [], status: HTMLOutputElement | undefined;
    let copy: HTMLButtonElement | undefined, finish: HTMLButtonElement | undefined, cancel: HTMLButtonElement | undefined;
    let disposed = false, visible = false, renders = 0, lastLayoutMs = 0, maxLayoutMs = 0, top = 0, anchorTop = 0, groupSerial = 0, groupField: InstructionField | undefined, groupAt = 0, groupRevision = -1;
    let layouts = 0, layoutWorkMs = 0, formInputs = 0, lastFormInputMs = 0;
    const current = () => { const tab = controller.workspace.tabs.resolve(target); return tab?.surface.kind === "text" && tab.surface.documentId === controller.source.documentId; };
    const capture = (field: Field): InputCapture | undefined => { const value = model.capture(field.key); return value ? { model: value, raw: model.state.getSnapshot().values[field.key], projection: exportText(model.state.getSnapshot().values[field.key], "lf") } : undefined; };
    const value = (field: Field, captured: InputCapture): string => {
        const diff = textDifference(captured.projection.text, field.node.value); if (!diff) return captured.raw;
        const inverse = captured.projection.mapping.invert(); return captured.raw.slice(0, inverse.map(diff.from, "before").offset) + diff.insert + captured.raw.slice(inverse.map(diff.to, "after").offset);
    };
    const recover = (field: Field, reason: string) => { const old = field.capture; field.capture = undefined; if (old) model.reject(old.model, value(field, old), reason); field.ignored = true; };
    const commit = (field: Field) => {
        if (field.composing || disposed) return; const old = field.capture ?? (field.ignored ? undefined : capture(field)); field.capture = undefined;
        if (!old) { sync(); return; }
        if (!current()) { model.reject(old.model, value(field, old), "instruction-view-expired"); sync(); return; }
        const now = win.performance.now(), revision = controller.workspace.document(controller.source.documentId).revision;
        if (groupField !== field.key || now - groupAt >= 1000 || groupRevision !== revision) { groupSerial++; groupField = field.key; }
        model.edit(old.model, value(field, old), editor.view, `instruction-${editor.view.id}-${model.state.getSnapshot().generation}-${groupSerial}`);
        groupAt = now; groupRevision = controller.workspace.document(controller.source.documentId).revision; sync();
    };
    const unmount = (restore: boolean) => {
        if (!panel) return; const focused = fields.find(f => owner.activeElement === f.node); memory.focus = focused?.key;
        for (const field of fields) { memory.fields[field.key] = { start: field.node.selectionStart, end: field.node.selectionEnd, direction: field.node.selectionDirection, scrollTop: field.node.scrollTop };
            if (field.capture) recover(field, "instruction-form-detached"); }
        fieldListeners?.abort(); observer.unobserve(panel); panel.remove(); panel = undefined; fields = []; visible = false;
        if (restore && focused) { editor.focus(); memory.focus = undefined; }
    };
    const mount = () => {
        if (panel) return; fieldListeners = new AbortController(); const signal = fieldListeners.signal;
        panel = owner.createElement("div"); panel.className = "host-instruction-form"; panel.setAttribute("role", "group"); panel.setAttribute("aria-label", "Anchored transfer instruction");
        const title = owner.createElement("strong"); title.textContent = "Transfer instruction"; panel.append(title);
        for (const [key, name] of [["destination", "Instruction destination"], ["batchSize", "Instruction batch size"]] as const) {
            const label = owner.createElement("label"), node = owner.createElement("textarea"), field: Field = { key, node, capture: undefined, composing: false, ignored: false };
            label.textContent = name; node.rows = 1; node.setAttribute("form", ""); if (key === "batchSize") node.inputMode = "numeric"; label.append(node); panel.append(label); fields.push(field);
            node.addEventListener("beforeinput", event => { if (field.ignored && field.composing) { event.preventDefault(); return; }
                if (!field.composing) { field.ignored = false; field.capture = capture(field); } if (!field.capture && event.cancelable) event.preventDefault(); }, { signal });
            node.addEventListener("input", () => { const start = win.performance.now(); formInputs++; try { commit(field); } finally { lastFormInputMs = win.performance.now() - start; } }, { signal });
            node.addEventListener("compositionstart", () => { field.composing = true; field.ignored = false; field.capture = capture(field); }, { signal });
            node.addEventListener("compositionend", () => { field.composing = false; if (!field.ignored) commit(field); else { field.capture = undefined; sync(); } }, { signal });
            node.addEventListener("blur", () => { groupField = undefined; if (!field.composing && field.capture) commit(field); }, { signal });
            node.addEventListener("keydown", event => {
                if (event.key === "Escape" && isUnmodifiedShortcut(event) && !field.composing) {
                    event.preventDefault(); event.stopPropagation(); editor.focus(); return;
                }
                const command = isPrimaryShortcut(event), key = event.key.toLowerCase();
                if (!command || !["s", "z", "y"].includes(key) || key === "s" && event.shiftKey) return; event.preventDefault(); event.stopPropagation();
                if (event.repeat || event.isComposing || field.composing || fields.some(f => !!f.capture)) return; groupField = undefined;
                if (key === "s") controller.save(); else { const d = controller.workspace.document(controller.source.documentId); controller.workspace[key === "y" || event.shiftKey ? "redo" : "undo"]({ documentId: d.id, expectedRevision: d.revision }); }
            }, { signal });
        }
        status = owner.createElement("output"); status.setAttribute("aria-label", "Instruction status"); panel.append(status);
        const controls = owner.createElement("div");
        const button = (name: string, invoke: () => void) => { const b = owner.createElement("button"); b.textContent = name; b.addEventListener("click", invoke, { signal }); controls.append(b); return b; };
        copy = button("Capture instruction copy", model.captureCopy); finish = button("Finish instruction copy", model.finishCopy); cancel = button("Cancel instruction copy", model.cancelCopy);
        button("Close instruction form", () => { model.clear(); editor.focus(); }); panel.append(controls); lane.append(panel); observer.observe(panel);
        sync();
        for (const field of fields) { const old = memory.fields[field.key]; if (old) { field.node.setSelectionRange(old.start, old.end, old.direction); field.node.scrollTop = old.scrollTop; }
            if (memory.focus === field.key && owner.activeElement === owner.body) field.node.focus({ preventScroll: true }); } memory.focus = undefined;
    };
    function sync() {
        const s = model.state.getSnapshot();
        if (memory.generation !== s.generation) { memory.generation = s.generation; memory.fields = {}; memory.focus = undefined; }
        for (const field of fields) {
            if ((!s.canEdit || !current()) && field.capture) recover(field, "instruction-edit-authority-changed");
            if (!field.composing && !field.capture) { const text = exportText(s.values[field.key], "lf").text; if (field.node.value !== text) field.node.value = text; }
            field.node.readOnly = !s.canEdit; field.node.setAttribute("aria-invalid", String(s.validation !== null));
        }
        if (status) status.textContent = [s.validation ?? s.message, model.copyDescription()].filter(Boolean).join(" "); if (copy) copy.disabled = s.validation !== null || !s.located || s.pendingCopy;
        if (finish) finish.disabled = !s.pendingCopy; if (cancel) cancel.disabled = !s.pendingCopy;
    }
    const place = () => {
        frame = undefined; if (disposed) return; const began = win.performance.now(), s = model.state.getSnapshot(); try {
        const active = s.active && current(); host.classList.toggle("host-instruction-enabled", active); lane.hidden = !active; sync();
        if (!active) { unmount(true); return; }
        const v = editor.viewport.activity(); if (v.pending || v.revision !== s.revision) { schedule(); return; }
        const root = editor.viewport.element.getBoundingClientRect(), box = lane.getBoundingClientRect(), folded = editor.view.folding.getSnapshot().index.hiddenBy(s.line);
        const point = s.located && !folded ? editor.viewport.rowBounds(s.line) : undefined;
        if (!point || box.width < 210 || point.top + point.height <= root.top || point.top >= root.bottom) {
            unmount(true); lane.dataset.state = folded ? "folded" : box.width < 210 ? "narrow" : "outside"; return;
        }
        lane.dataset.state = "visible"; mount(); anchorTop = point.top - box.top;
        top = Math.max(0, Math.min(Math.max(0, box.height - panel!.getBoundingClientRect().height), anchorTop)); panel!.style.top = `${top}px`; panel!.dataset.line = String(s.line); visible = true; renders++;
        } finally { lastLayoutMs = win.performance.now() - began; maxLayoutMs = Math.max(maxLayoutMs, lastLayoutMs); layoutWorkMs += lastLayoutMs; layouts++; }
    };
    function schedule() { if (!disposed && frame === undefined) frame = win.requestAnimationFrame(place); }
    const observer = new win.ResizeObserver(schedule); observer.observe(host);
    win.addEventListener("resize", schedule, { signal: listeners.signal });
    const stops = [editor.viewport.onRender(schedule), model.state.subscribe(() => { sync(); schedule(); }), editor.view.folding.subscribe(schedule)]; schedule();
    return Object.freeze({ hasPendingInput: () => fields.some(f => f.composing || !!f.capture),
        debug: () => ({ visible, pending: frame !== undefined, top, anchorTop, renders, layouts, layoutWorkMs, lastLayoutMs, maxLayoutMs, formInputs, lastFormInputMs, fieldNodes: fields.length, laneState: lane.dataset.state ?? "inactive", disposed }),
        dispose: () => { if (disposed) return; unmount(false); disposed = true; if (frame !== undefined) win.cancelAnimationFrame(frame); frame = undefined;
            observer.disconnect(); stops.forEach(stop => stop()); listeners.abort(); host.classList.remove("host-instruction-enabled"); lane.remove(); } });
}
