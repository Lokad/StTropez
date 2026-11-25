import { listenUntil } from "./listen.ts";
import type { TextEditor } from "./text-editor.ts";

export type EditorCommand = Readonly<{
    id: string;
    label: string;
    owner?: string;
    category?: string;
    enabled?: (argument: unknown, editor: TextEditor) => boolean;
    run: (argument: unknown, editor: TextEditor) => void | boolean;
}>;
type CommandInfo = Readonly<{ id: string; label: string; owner: string; category: string; enabled: boolean }>;
type BindingOptions = Readonly<{ shared?: boolean; priority?: number; repeat?: boolean }>;
export type EditorCommands = Readonly<{
    register: (command: EditorCommand, shortcuts?: BindingOptions & { readonly keys: readonly string[] }) => { dispose(): void };
    run: (id: string, argument?: unknown) => boolean;
    get: (id: string, argument?: unknown) => CommandInfo | undefined;
    list: () => readonly CommandInfo[];
}>;
export type EditorKeymap = Readonly<{
    bind: (keys: string, id: string, options?: BindingOptions) => { dispose(): void };
    unbind: (keys: string) => void;
    /** Configured sequences for this command on this mount, including shared shortcuts. */
    getShortcuts: (id: string) => readonly string[];
    /** Dispatch shared bindings from a host-owned control. Editor input dispatches its own keys. */
    handle: (event: KeyboardEvent) => boolean;
}>;

const modifiers = ["ctrl", "meta", "alt", "shift"];
function stroke(text: string, apple: boolean): string {
    const parts = text.toLowerCase().split("+"), key = parts.pop()!;
    const names = parts.map(part => part === "mod" ? (apple ? "meta" : "ctrl") : part);
    if (!key || modifiers.includes(key) || (key.startsWith("code:") && !/^code:[a-z0-9]+$/.test(key))
        || names.some(part => !modifiers.includes(part)) || new Set(names).size !== names.length)
        throw new TypeError(`Invalid key stroke: ${text}`);
    return [...modifiers.filter(name => names.includes(name)), key].join("+");
}

// Resolve punctuation shortcuts from the position and legend together. The same position
// can carry different shortcut keys on French and US keyboards. Shift remains a modifier.
function shortcutPunctuation({ code, key }: KeyboardEvent): string | undefined {
    switch (code) {
        case "Comma":
            if (key === ";" || key === ".") return ".";
            break;
        case "Period":
            if (key === ":" || key === "/") return "/";
            if (key === "." || key === ">") return ".";
            break;
        case "Slash":
            if (key === "/" || key === "?") return "/";
            break;
        case "Minus":
            if (key === ")" || key === "°") return "[";
            break;
        case "BracketLeft":
            if (key === "[" || key === "{") return "[";
            if (key === "Dead" || key === "^" || key === "¨") return "]";
            break;
        case "BracketRight":
            if (key === "]" || key === "}") return "]";
            break;
        case "Backslash":
            if (key === "\\" || key === "|" || key === "*" || key === "µ") return "\\";
    }
}

type Binding = Readonly<{ id: string; keys: string; shared: boolean; priority: number; repeat: boolean }>;
type Strokes = Map<string, readonly Binding[]>;
// A shadow-tree key event can expose a different target after dispatch finishes.
function chordTarget(event: KeyboardEvent): EventTarget | null { return event.composedPath()[0] ?? event.target; }

type CommandScope = {
    conflicts: (id: string) => boolean;
    bind: EditorKeymap["bind"];
    removeBindings: (id: string) => void;
};

export function commandRegistration(entries: Map<string, EditorCommand>, scopes: readonly CommandScope[]): EditorCommands["register"] {
    return (command, shortcuts) => {
        const entry = Object.freeze({ ...command });
        if (!entry.id.trim() || !entry.label.trim() || scopes.some(scope => scope.conflicts(entry.id))) {
            throw new Error(`Cannot register command: ${entry.id}`);
        }
        entries.set(entry.id, entry);
        const registration = { dispose() {
            if (entries.get(entry.id) !== entry) return;
            entries.delete(entry.id);
            for (const scope of scopes) scope.removeBindings(entry.id);
        } };
        try {
            for (const keys of shortcuts?.keys ?? []) {
                for (const scope of scopes) scope.bind(keys, entry.id, shortcuts);
            }
        } catch (error) {
            registration.dispose();
            throw error;
        }
        return registration;
    };
}

/** Bindings belong to one mounted view. Only the prefix of a pending chord retains event-time state. */
export function createCommandRegistry(apple: boolean, available: () => boolean, chordCurrent: () => () => boolean,
    pane: () => TextEditor, shared?: ReadonlyMap<string, EditorCommand>) {
    const entries = new Map<string, EditorCommand>();
    const bindings = new Map<string, Strokes>();
    let disposed = false;
    let prefix: { keys: Strokes; event: KeyboardEvent; target: EventTarget | null; current: () => boolean; listeners: AbortController; timer: number } | undefined;
    function reset() {
        if (!prefix) return;
        clearTimeout(prefix.timer); prefix.listeners.abort(); prefix = undefined;
    }
    const lookup = (id: string) => disposed ? undefined : entries.get(id) ?? shared?.get(id);
    const enabled = (entry: EditorCommand, argument?: unknown) => available() && (entry.enabled?.(argument, pane()) ?? true);
    const describe = (entry: EditorCommand, argument?: unknown): CommandInfo =>
        Object.freeze({ id: entry.id, label: entry.label, owner: entry.owner ?? "host",
            category: entry.category ?? "General", enabled: enabled(entry, argument) });
    const scope: CommandScope = {
        conflicts: id => disposed || !!lookup(id),
        bind: (...args) => keymap.bind(...args),
        removeBindings(id) {
            reset();
            for (const [first, group] of bindings) {
                for (const [last, choices] of group) {
                    const kept = choices.filter(binding => binding.id !== id);
                    if (!kept.length) group.delete(last);
                    else if (kept.length !== choices.length) group.set(last, kept);
                }
                if (!group.size) bindings.delete(first);
            }
        },
    };
    const commands: EditorCommands = Object.freeze({
        register: commandRegistration(entries, [scope]),
        run(id, argument) {
            const entry = lookup(id);
            return !!entry && enabled(entry, argument) && lookup(id) === entry && entry.run(argument, pane()) !== false;
        },
        get(id, argument) {
            const entry = lookup(id);
            return entry && describe(entry, argument);
        },
        list: () => Object.freeze((disposed ? [] : [...entries.values(), ...(shared?.values() ?? [])]).map(entry => describe(entry))),
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
        const modifiers = (event.ctrlKey ? "ctrl+" : "") + (event.metaKey ? "meta+" : "") + (event.altKey ? "alt+" : "");
        const mods = modifiers + (event.shiftKey ? "shift+" : "");
        const character = event.key === " " ? "space" : event.key === "+" ? "plus" : event.key.toLowerCase();
        const punctuation = (event.ctrlKey || event.metaKey) && !event.altKey ? shortcutPunctuation(event) : undefined;
        const key = mods + (punctuation ?? character);
        const physical = mods + "code:" + event.code.toLowerCase();
        // Other symbols and digits can require Shift to produce their binding.
        const shiftedCharacter = punctuation === undefined && event.shiftKey && /^[\p{P}\p{S}0-9]$/u.test(event.key);
        function match(table: ReadonlyMap<string, unknown>): string {
            if (table.has(key)) return key;
            if (shiftedCharacter && !table.has(physical)) return modifiers + character;
            return physical;
        }
        const pending = prefix, group = bindings.get(match(bindings));
        if (!group && !pending) return false;
        reset();
        if (!available()) return false;
        const accept = (group: Strokes, stroke: string) => group.get(stroke)?.some(binding => {
            if ((sharedOnly && !binding.shared) || !group.get(stroke)?.includes(binding)) return false;
            if (event.repeat && !binding.repeat) {
                const entry = lookup(binding.id);
                return !!entry && enabled(entry);
            }
            return execute(binding.id);
        });
        if (pending && pending.target === chordTarget(event) && pending.current()) {
            const suffix = match(pending.keys);
            const bound = pending.keys.get(suffix)?.some(binding => !sharedOnly || binding.shared);
            if (key === "escape" || bound) {
                if (key !== "escape") accept(pending.keys, suffix);
                event.preventDefault(); return true;
            }
        }
        if (!group) return false;
        if (group.has("")) {
            if (!accept(group, "")) return false;
        } else {
            if (sharedOnly && ![...group.values()].some(choices => choices.some(binding => binding.shared))) return false;
            const listeners = new AbortController(), listen = listenUntil(listeners.signal);
            const target = chordTarget(event);
            listen(target, "focusout", reset);
            listen(target, "compositionstart", reset);
            listen(event.view, "blur", reset);
            prefix = { keys: group, event, target, current: chordCurrent(), listeners, timer: window.setTimeout(reset, 1500) };
        }
        event.preventDefault(); return true;
    }
    const keymap: EditorKeymap = Object.freeze({
        bind(keys, id, options) {
            const [first, last] = sequence(keys);
            if (!lookup(id)) throw new Error(`Unknown command: ${id}`);
            const group: Strokes = bindings.get(first) ?? new Map(), choices = group.get(last) ?? [], priority = options?.priority ?? 0;
            if (!Number.isFinite(priority)) throw new RangeError("Key binding priority must be finite.");
            if (choices.some(binding => binding.priority === priority) || (last ? group.has("") : group.size && !group.has("")))
                throw new Error(`Key binding conflicts: ${keys}`);
            const binding = { id, keys: keys.trim().replace(/\s+/g, " "), shared: options?.shared ?? false, priority, repeat: options?.repeat ?? true };
            reset(); group.set(last, [...choices, binding].sort((a, b) => b.priority - a.priority)); bindings.set(first, group);
            return { dispose() {
                const current = bindings.get(first)?.get(last);
                if (!current?.includes(binding)) return;
                if (current.length === 1) keymap.unbind(keys);
                else { reset(); group.set(last, current.filter(choice => choice !== binding)); }
            } };
        },
        unbind(keys) {
            const [first, last] = sequence(keys), group = bindings.get(first);
            if (group?.delete(last)) { reset(); if (!group.size) bindings.delete(first); }
        },
        getShortcuts(id) {
            const keys: string[] = [];
            for (const group of bindings.values()) for (const choices of group.values()) {
                const binding = choices.find(choice => choice.id === id);
                if (binding) keys.push(binding.keys);
            }
            return Object.freeze(keys);
        },
        handle: event => handle(event, true, commands.run),
    });
    return { commands, keymap, scope, reset, handleEditor: (event: KeyboardEvent, execute: (id: string) => boolean) => handle(event, false, execute),
        dispose() { disposed = true; reset(); bindings.clear(); entries.clear(); } };
}
