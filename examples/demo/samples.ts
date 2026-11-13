export type SampleId = "pricing" | "errors" | "unicode" | "large" | "catalogue" | "templates" | "results" | "outline" | "documentation" | "navigation";
export type DemoSample = Readonly<{ id: SampleId; title: string; description: string; files: Readonly<Record<string, string>>;
    initialFiles?: readonly string[]; declarations?: Readonly<Record<string, string>> }>;

const pricing = `export interface CartItem {
    name: string;
    price: number;
    quantity: number;
}

/** Return the total after a percentage discount. */
export function calculateTotal(items: readonly CartItem[], discount = 0): number {
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return Math.round(subtotal * (1 - discount) * 100) / 100;
}
`;
const main = `import { calculateTotal } from "./pricing";
import type { CartItem } from "./pricing";

const cart: CartItem[] = [
    { name: "Notebook", price: 12, quantity: 2 },
    { name: "Pencil", price: 1.5, quantity: 4 },
];

// Try changing the discount, or explore pricing.ts.
const total = calculateTotal(cart, 0.1);
const message = \`Your total is €\${total.toFixed(2)}.\`;

console.log(message);
`;

export const sampleChoices: readonly Readonly<{ id: SampleId; title: string }>[] = Object.freeze([
    { id: "pricing", title: "Shopping cart" }, { id: "errors", title: "Fix a type error" },
    { id: "unicode", title: "Languages & Unicode" }, { id: "large", title: "Large file · 100,000 lines" },
    { id: "catalogue", title: "Completion catalogue · 1,200 fields" },
    { id: "templates", title: "Snippets & lazy completion" },
    { id: "results", title: "Project-wide results · 1,200 uses" },
    { id: "outline", title: "Host outline · indentation folding" },
    { id: "documentation", title: "Documentation & help links" },
    { id: "navigation", title: "Unopened files & navigation" },
]);

/** Large fixtures are built only on explicit selection. */
export function demoSample(id: SampleId): DemoSample {
    if (id === "navigation") return { id, title: "Unopened files & navigation",
        description: "Go to definition (F12) on formatLabel to load labels.ts, or on RecordId to read contracts.d.ts. Only main.ts starts in the editor. Alt+Left returns to the original location; labels.ts remains editable and saves with the project.",
        initialFiles: ["main.ts"],
        files: { "main.ts": 'import { formatLabel } from "./labels";\nimport type { RecordId } from "./contracts";\n\nexport interface LabelOptions { prefix: string; }\nconst record: RecordId = "record-42";\nconst label = formatLabel(record);\nconsole.log(label);\n',
            "labels.ts": 'import type { LabelOptions } from "./main";\n\n/** Format a stable label for display. */\nexport function formatLabel(id: string, options: LabelOptions = { prefix: "Label" }): string {\n  return `${options.prefix}: ${id}`;\n}\n' },
        declarations: { "contracts.d.ts": '/** An identifier supplied by a host contract. This declaration is read-only. */\nexport type RecordId = `record-${number}`;\n' } };
    if (id === "documentation") return { id, title: "Documentation & help",
        description: "Inspect applyDiscount with Hover or Code → Inspect type. Its documentation has formatting and a help link. Inside the call, use Code → Signature help. Help links open the TypeScript handbook; edited programs are never executed.",
        files: { "documentation.ts": [
            "/**", " * Apply a **percentage discount** to a price.", " *", " * Use a fraction such as `0.1` for *ten percent*.", " *",
            " * - Keeps the original price unchanged.", " * - Returns a new discounted value.", " *", " * ```typescript", " * applyDiscount(50, 0.1); // 45", " * ```", " *",
            " * [TypeScript function guide](https://www.typescriptlang.org/docs/handbook/2/functions.html)", " *",
            " * @param price The **original price** before the discount.", " * @param rate A fraction between `0` and `1`.", " */",
            "export function applyDiscount(price: number, rate: number): number {", "  return price * (1 - rate);", "}", "", "const discounted = applyDiscount(50, 0.1);", "",
        ].join("\n") } };
    if (id === "outline") return { id, title: "Host outline",
        description: "A plain host-owned outline, with no language server or compiler. Indentation defines nested blocks; #region markers define the regions group. Use the gutter or Code → Collapse group, then Find to reveal hidden text.",
        files: { "workflow.txt": "#region workflow\npipeline\n  inputs\n    source\n    settings\n\n  steps\n    prepare\n      validate\n      normalize\n    publish\n      report\n#endregion\n\nnotes\n  Editable text; Tab changes indentation.\n  Each view keeps its own collapsed blocks.\n" } };
    if (id === "results") return { id, title: "Project-wide results",
        description: "Open Problems to browse 300 type errors. In uses.ts, select sharedValue, then use Code → Find references or Rename to review all 1,201 occurrences. Results are paged; one undo restores a rename.",
        files: { "uses.ts": "const sharedValue = 1;\n" + Array.from({ length: 1200 }, (_, i) => `const use${i} = sharedValue;`).join("\n") + "\n",
            "problems.ts": Array.from({ length: 300 }, (_, i) => `const problem${i}: number = "needs a number";`).join("\n") + "\n" } };
    if (id === "templates") return { id, title: "Snippets & lazy completion",
        description: "Demo template provider: go to the end (Ctrl+End), press Ctrl+Space and Tab. Edit linked names, Tab/Shift+Tab through fields, Alt+Up/Down for choices; Escape finishes.",
        files: { "templates.ts": "// Demo-owned templates demonstrate the public completion protocol.\n// TypeScript still checks, colors and compiles these files.\n\ntemplate",
            "types.ts": 'export interface TemplateRecord {\n    state: "draft" | "ready";\n}\n' } };
    if (id === "catalogue") return { id, title: "Completion catalogue",
        description: "Go to the end (Ctrl+End), type catalogue. and explore 1,200 fields. Filter by typing item119, then choose with arrows and Tab.",
        files: { "catalogue.ts": "// A real TypeScript object supplies every completion candidate.\nconst catalogue = {\n"
            + Array.from({ length: 1200 }, (_, i) => `    item${String(i).padStart(4, "0")}: ${i},`).join("\n")
            + "\n};\n\n// Try catalogue. on the next line, or request completion with Ctrl+Space.\n" } };
    if (id === "large") return { id, title: "Large file", description: "Jump to the end, edit, search and undo in a 100,000-line file.",
        files: { "large.ts": Array.from({ length: 100_000 }, (_, i) => `// Row ${i + 1}: try editing or searching here.`).join("\n") } };
    if (id === "unicode") return { id, title: "Languages & Unicode", description: "Select and edit accents, emoji and text in different writing systems.", files: {
        "greetings.ts": `const greetings = ["Bonjour", "日本語", "你好", "مرحبا", "שלום"];
const accents = "café · cafe\u0301";
const emoji = "👩‍💻 · 👨‍👩‍👧‍👦 · 🇫🇷";

// Multiline text keeps its syntax colors when you scroll.
const invitation = \`Welcome!
Choose a greeting: \${greetings.join(", ")}
Enjoy your visit.\`;

console.log(invitation, accents, emoji);
` } };
    return { id, title: id === "errors" ? "Fix a type error" : "Shopping cart",
        description: id === "errors" ? "The discount should be a number. Open Problems, then replace the string with 0.1 to fix the error."
            : "A small project to explore. Edit the cart, open pricing.ts, then compare your changes.",
        files: { "main.ts": id === "errors" ? main.replace("calculateTotal(cart, 0.1)", 'calculateTotal(cart, "10%")') : main, "pricing.ts": pricing } };
}
