import type { MountedTextEditor } from "./text-editor.ts";
import type { TextViewport } from "./viewport.ts";

type Kind = "render" | "fold" | "scroll" | "input" | "pointerdown" | "compositionend" | "resize";
type Callback = (pane: TextViewport, event?: Event) => void;
type Binding = { mount: MountedTextEditor; base: AbortController; stops: Map<Kind, () => void> };
type Registration = { callback: Callback };
export type ComparisonPanes = ReturnType<typeof createComparisonPanes>;

/** One attachment owner and one native/fold observation per pane and requested event kind. */
export function createComparisonPanes(working: MountedTextEditor, compositionChanged: () => void) {
    const listeners = new Map<Kind, Set<Registration>>(), replacements = new Set<(previous: MountedTextEditor | undefined) => void>();
    let reference: Binding | undefined, disposed = false, resize: ResizeObserver | undefined;
    const source = bind(working, false);
    const current = (binding: Binding) => !disposed && (binding === source || binding === reference);
    function emit(kind: Kind, binding: Binding, event?: Event): void {
        const observers = listeners.get(kind);
        for (const entry of observers ? [...observers] : []) if (current(binding) && observers!.has(entry)) entry.callback(binding.mount.editor.viewport, event);
    }
    function watch(binding: Binding, kind: Kind): () => void {
        const pane = binding.mount.editor.viewport;
        if (kind === "render") return pane.onRender(() => emit(kind, binding));
        if (kind === "fold") return pane.view.folding.subscribe(() => emit(kind, binding));
        if (kind === "resize") {
            resize ??= new ResizeObserver(entries => {
                if (entries.some(entry => entry.target === source.mount.editor.viewport.element || entry.target === reference?.mount.editor.viewport.element)) emit("resize", source);
            });
            resize.observe(pane.element); return () => resize!.unobserve(pane.element);
        }
        const events = new AbortController();
        const types = kind === "input" ? ["keydown", "beforeinput"] : [kind];
        for (const type of types) pane.element.addEventListener(type, event => emit(kind, binding, event), {
            signal: events.signal, capture: kind === "input" || kind === "pointerdown" || kind === "compositionend", passive: kind === "scroll"
        });
        return () => events.abort();
    }
    function bind(mount: MountedTextEditor, baseline: boolean): Binding {
        const editor = mount.editor, binding: Binding = { mount, base: new AbortController(), stops: new Map() };
        try {
            for (const type of ["compositionstart", "compositionend"]) editor.input.addEventListener(type, compositionChanged, { signal: binding.base.signal });
            if (baseline) editor.viewport.element.addEventListener("focus", () => editor.focus(), { signal: binding.base.signal });
            for (const [kind, observers] of listeners) if (observers.size) binding.stops.set(kind, watch(binding, kind));
            return binding;
        } catch (error) { unbind(binding); throw error; }
    }
    function unbind(binding: Binding): void { binding.base.abort(); for (const stop of binding.stops.values()) stop(); binding.stops.clear(); }
    function observe(observation: Partial<Record<Kind, Callback>>): () => void {
        if (disposed) return () => {};
        const stops: (() => void)[] = [];
        try {
            for (const [kind, callback] of Object.entries(observation) as [Kind, Callback][]) {
                if (!callback) continue;
                let observers = listeners.get(kind); if (!observers) { observers = new Set(); listeners.set(kind, observers); }
                const entry = { callback }; observers.add(entry);
                stops.push(() => {
                    if (!observers.delete(entry) || observers.size) return;
                    for (const binding of [source, reference]) { binding?.stops.get(kind)?.(); binding?.stops.delete(kind); }
                    if (kind === "resize") resize?.disconnect();
                });
                if (observers.size === 1) for (const binding of [source, reference]) if (binding) binding.stops.set(kind, watch(binding, kind));
            }
        } catch (error) { for (const stop of stops) stop(); throw error; }
        return () => { for (const stop of stops) stop(); };
    }
    return Object.freeze({ working,
        reference: () => reference?.mount,
        setReference(mount: MountedTextEditor | undefined): void {
            if (disposed || reference?.mount === mount) return;
            const previous = reference; if (previous) unbind(previous); reference = undefined;
            if (mount) reference = bind(mount, true);
            for (const listener of [...replacements]) if (replacements.has(listener)) listener(previous?.mount);
        },
        observe,
        onReferenceChange(listener: (previous: MountedTextEditor | undefined) => void): () => void {
            if (disposed) return () => {}; replacements.add(listener); return () => { replacements.delete(listener); };
        },
        dispose(): void {
            if (disposed) return; disposed = true; unbind(source); if (reference) unbind(reference);
            reference = undefined; resize?.disconnect(); listeners.clear(); replacements.clear();
        }
    });
}
