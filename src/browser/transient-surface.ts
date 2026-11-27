import type { TextEditor } from "./text-editor.ts";

const priorities = { hover: 0, completion: 1, signature: 2, explicit: 3 } as const;
type Companion = "completion" | "signature";
type Owner = { dismiss: () => void; priority: number; kind?: Companion | undefined };
const active = new WeakMap<TextEditor, Set<Owner>>();

/** A signature can accompany a completion list. Other surfaces compete for the same editor. */
export function transientSurface(editor: TextEditor, dismiss: () => void, kind?: Companion) {
    const scope = editor.workspace.createNotificationScope();
    const owners = active.get(editor) ?? new Set<Owner>();
    active.set(editor, owners);
    const owner: Owner = { dismiss, priority: 0, kind };
    return {
        claim(trigger: keyof typeof priorities = "explicit") {
            const priority = priorities[trigger];
            if (owners.has(owner)) {
                owner.priority = Math.max(owner.priority, priority);
                return true;
            }
            const displaced = [...owners].filter(peer => !kind || !peer.kind || peer.kind === kind);
            if (trigger !== "explicit" && displaced.some(peer => priority <= peer.priority)) return false;
            scope.assertWritable();
            for (const peer of displaced) owners.delete(peer);
            owner.priority = priority;
            owners.add(owner);
            for (const peer of displaced) peer.dismiss();
            return owners.has(owner);
        },
        release() {
            owners.delete(owner);
        },
    };
}
