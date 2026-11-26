import type { TextEditor } from "./text-editor.ts";

const priorities = { hover: 0, completion: 1, signature: 2, explicit: 3 } as const;
type Owner = { dismiss: () => void; priority: number };
const active = new WeakMap<TextEditor, Owner>();

/** Explicit requests replace the current surface. Automatic requests yield to higher priorities. */
export function transientSurface(editor: TextEditor, dismiss: () => void) {
    const scope = editor.workspace.createNotificationScope();
    const owner: Owner = { dismiss, priority: 0 };
    return {
        claim(trigger: keyof typeof priorities = "explicit") {
            const priority = priorities[trigger];
            const previous = active.get(editor);
            if (previous !== owner && previous && trigger !== "explicit" && priority <= previous.priority) return false;
            if (previous !== owner) scope.assertWritable();
            owner.priority = previous === owner ? Math.max(owner.priority, priority) : priority;
            active.set(editor, owner);
            if (previous !== owner) previous?.dismiss();
            return active.get(editor) === owner;
        },
        release() {
            if (active.get(editor) === owner) active.delete(editor);
        },
    };
}
