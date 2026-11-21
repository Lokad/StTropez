export type EditorCommand = Readonly<{ id: string; label: string; enabled?: () => boolean; run: () => void | boolean }>;
export type EditorCommands = Readonly<{
    register: (command: EditorCommand) => { dispose(): void };
    run: (id: string) => boolean;
    list: () => readonly Readonly<{ id: string; label: string; enabled: boolean }>[];
}>;
export type EditorKeymap = Readonly<{
    bind: (keys: string, id: string, options?: Readonly<{ shared?: boolean }>) => { dispose(): void };
    unbind: (keys: string) => void;
    /** Dispatch shared bindings from a host-owned control. Editor input dispatches its own keys. */
    handle: (event: KeyboardEvent) => boolean;
}>;

const modifiers = ["ctrl", "meta", "alt", "shift"];
function stroke(text: string, apple: boolean): string {
    const parts = text.toLowerCase().split("+"), key = parts.pop()!;
    const names = parts.map(part => part === "mod" ? (apple ? "meta" : "ctrl") : part);
    if (!key || modifiers.includes(key) || names.some(part => !modifiers.includes(part)) || new Set(names).size !== names.length)
        throw new TypeError(`Invalid key stroke: ${text}`);
    return [...modifiers.filter(name => names.includes(name)), key].join("+");
}
function eventStroke(event: KeyboardEvent): string {
    const key = event.key === " " ? "space" : event.key === "+" ? "plus" : event.key.toLowerCase();
    return (event.ctrlKey ? "ctrl+" : "") + (event.metaKey ? "meta+" : "") + (event.altKey ? "alt+" : "") + (event.shiftKey ? "shift+" : "") + key;
}

type Binding = Readonly<{ id: string; shared: boolean }>;
/** Bindings belong to one mounted view. Only the prefix of a pending chord retains event-time state. */
export function createCommandRegistry(apple: boolean, available: () => boolean, chordCurrent: () => () => boolean) {
    const entries = new Map<string, EditorCommand>();
    const bindings = new Map<string, Map<string, Binding>>();
    let disposed = false;
    let prefix: { keys: Map<string, Binding>; event: KeyboardEvent; current: () => boolean; listeners: AbortController; timer: number } | undefined;
    function reset() {
        if (!prefix) return;
        clearTimeout(prefix.timer); prefix.listeners.abort(); prefix = undefined;
    }
    const enabled = (entry: EditorCommand) => available() && (entry.enabled?.() ?? true);
    const commands: EditorCommands = Object.freeze({
        register(command) {
            if (disposed || !command.id.trim() || !command.label.trim() || entries.has(command.id)) throw new Error(`Cannot register command: ${command.id}`);
            const entry = Object.freeze({ ...command });
            entries.set(entry.id, entry);
            return { dispose() {
                if (entries.get(entry.id) !== entry) return;
                entries.delete(entry.id); reset();
                for (const [first, group] of bindings) {
                    for (const [last, binding] of group) if (binding.id === entry.id) group.delete(last);
                    if (!group.size) bindings.delete(first);
                }
            } };
        },
        run(id) {
            const entry = entries.get(id);
            return !!entry && enabled(entry) && entries.get(id) === entry && entry.run() !== false;
        },
        list: () => Object.freeze(Array.from(entries.values(), entry => Object.freeze({ id: entry.id, label: entry.label, enabled: enabled(entry) }))),
    });
    function sequence(keys: string) {
        const parts = keys.trim().split(/\s+/);
        if (parts.length > 2) throw new TypeError("A binding accepts one stroke or a two-stroke chord.");
        return [stroke(parts[0]!, apple), parts[1] ? stroke(parts[1], apple) : ""] as const;
    }
    function handle(event: KeyboardEvent, sharedOnly: boolean, execute: (id: string) => boolean): boolean {
        if (event.defaultPrevented && prefix?.event === event) return false;
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph") || !event.cancelable) {
            reset(); return false;
        }
        if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return false;
        const key = eventStroke(event), pending = prefix, group = bindings.get(key);
        if (!group && !pending) return false;
        reset();
        if (!available()) return false;
        const accept = (binding: Binding | undefined) => !!binding && (!sharedOnly || binding.shared) && execute(binding.id);
        if (pending && pending.event.target === event.target && pending.current()) {
            const suffix = pending.keys.get(key);
            if (key === "escape" || accept(suffix)) { event.preventDefault(); return true; }
            if (suffix && (!sharedOnly || suffix.shared)) return false;
        }
        if (!group) return false;
        if (group.has("")) {
            if (!accept(group.get(""))) return false;
        } else {
            if (sharedOnly && ![...group.values()].some(binding => binding.shared)) return false;
            const listeners = new AbortController(), options = { signal: listeners.signal };
            event.target?.addEventListener("focusout", reset, options);
            event.target?.addEventListener("compositionstart", reset, options);
            event.view?.addEventListener("blur", reset, options);
            prefix = { keys: group, event, current: chordCurrent(), listeners, timer: window.setTimeout(reset, 1500) };
        }
        event.preventDefault(); return true;
    }
    const keymap: EditorKeymap = Object.freeze({
        bind(keys, id, options) {
            const [first, last] = sequence(keys);
            if (!entries.has(id)) throw new Error(`Unknown command: ${id}`);
            const group = bindings.get(first) ?? new Map<string, Binding>();
            if (group.has(last) || group.has("") || !last && group.size) throw new Error(`Key binding conflicts: ${keys}`);
            const binding = { id, shared: options?.shared ?? false };
            reset(); group.set(last, binding); bindings.set(first, group);
            return { dispose() { if (bindings.get(first)?.get(last) === binding) keymap.unbind(keys); } };
        },
        unbind(keys) {
            const [first, last] = sequence(keys), group = bindings.get(first);
            if (group?.delete(last)) { reset(); if (!group.size) bindings.delete(first); }
        },
        handle: event => handle(event, true, commands.run),
    });
    return { commands, keymap, reset, handleEditor: (event: KeyboardEvent, execute: (id: string) => boolean) => handle(event, false, execute),
        dispose() { disposed = true; reset(); bindings.clear(); entries.clear(); } };
}
