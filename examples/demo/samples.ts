import type { FoldRange } from "../../src/index.ts";

export type SampleId = "pricing" | "shipping" | "errors" | "unicode" | "large" | "catalogue" | "templates" | "results" | "outline" | "documentation" | "navigation" | "diagnostics" | "actions" | "host";
export type DemoSample = Readonly<{ id: SampleId; title: string; description: string; files: Readonly<Record<string, string>>; indentSize?: 2 | 4;
    initialFiles?: readonly string[]; initialFolds?: Readonly<Record<string, readonly FoldRange[]>>; declarations?: Readonly<Record<string, string>> }>;

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

const readyToShip = cart.every(item => item.name !== ""
    && item.quantity >= 1 && item.quantity <= 99);
if (!readyToShip) console.warn("Check name and count.");
const total = calculateTotal(cart, 0.1);
console.log(\`Your total is €\${total.toFixed(2)}.\`);
`;

export const sampleChoices: readonly Readonly<{ id: SampleId; title: string }>[] = Object.freeze([
    { id: "pricing", title: "Shopping cart" }, { id: "shipping", title: "Shipping quotes" }, { id: "errors", title: "Fix a type error" },
    { id: "unicode", title: "Languages & Unicode" }, { id: "large", title: "Large file · 100,000 lines" },
    { id: "catalogue", title: "Completion catalogue · 1,200 fields" },
    { id: "templates", title: "Snippets & lazy completion" },
    { id: "results", title: "Project-wide results · 1,200 uses" },
    { id: "outline", title: "Host outline · indentation folding" },
    { id: "documentation", title: "Documentation & help links" },
    { id: "navigation", title: "Unopened files & navigation" },
    { id: "diagnostics", title: "Diagnostic details" },
    { id: "actions", title: "Project actions" },
    { id: "host", title: "Host integrations · paste & notes" },
]);

/** Large fixtures are built only on explicit selection. */
export function demoSample(id: SampleId): DemoSample {
    if (id === "shipping") return { id, title: "Shipping quotes", indentSize: 4,
        description: "Turn on View → Minimap. Hover to locate the rate table, then jump to the quote calculation. Change a rate and open Changes to review your edit.",
        files: { "shipping.ts": `type Zone = "local" | "regional";

interface Parcel {
    weightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
}

interface Service {
    name: string;
    days: number;
    limitKg: number;
    baseCents: Record<Zone, number>;
    perKgCents: number;
}

// Rates are in cents. The base charge covers the first kilogram.
const services: Service[] = [
    {
        name: "Ground",
        days: 4,
        limitKg: 30,
        baseCents: { local: 450, regional: 700 },
        perKgCents: 80,
    },
    {
        name: "Express",
        days: 1,
        limitKg: 20,
        baseCents: { local: 950, regional: 1400 },
        perKgCents: 160,
    },
    {
        name: "Bicycle courier",
        days: 1,
        limitKg: 5,
        baseCents: { local: 600, regional: Infinity },
        perKgCents: 0,
    },
];

/** Bulky parcels are charged by volume when that exceeds their scale weight. */
function billableKg(parcel: Parcel): number {
    const volume = parcel.lengthCm * parcel.widthCm * parcel.heightCm;
    return Math.max(1, Math.ceil(Math.max(parcel.weightKg, volume / 5000)));
}

function shippingQuotes(parcel: Parcel, zone: Zone) {
    const weight = billableKg(parcel);
    return services
        .filter(service => weight <= service.limitKg)
        .filter(service => Number.isFinite(service.baseCents[zone]))
        .map(service => ({
            name: service.name,
            days: service.days,
            cents: service.baseCents[zone] + (weight - 1) * service.perKgCents,
        }))
        .sort((a, b) => a.cents - b.cents || a.days - b.days);
}

const parcel: Parcel = {
    weightKg: 1.8,
    lengthCm: 40,
    widthCm: 30,
    heightCm: 20,
};

for (const quote of shippingQuotes(parcel, "local")) {
    console.log(quote.name, quote.days, (quote.cents / 100).toFixed(2));
}
` } };
    if (id === "host") {
        const workflow = '# Example-owned language; no compiler or execution.\ndataset Inventory:\n  columns sku, quantity\n  row "A-100", 12\n  row "B-200", 8\n\nrule Reorder:\n  when quantity < 10\n  emit "Review stock"\n';
        return { id, title: "Host integrations",
            description: "Reorder starts folded. Use Code → Fold group to expand both blocks. Click the Inventory source note to open its CSV, then Code → Back to return. Notes follow edits and folds. Code → Paste format selects literal text or table-to-CSV conversion; Insert example table uses the same path without your clipboard. Ctrl+Alt+V changes paste mode; Ctrl+Alt+M adds a note.",
            files: { "workflow.rules": workflow, "inventory.csv": '"sku","quantity"\r\n"C-300","5"\r\n' },
            initialFolds: { "workflow.rules": [{ id: "initial-reorder", from: workflow.indexOf("rule Reorder:"), to: workflow.length, group: "blocks", collapsed: true }] } };
    }
    if (id === "actions") return { id, title: "Project actions",
        description: "Use Ctrl+. or Code → Quick fix for a two-file refactor, a host command that adds a review note, or a refactor followed by a project check. The deliberate failure demonstrates recovery: earlier edits remain undoable. These labeled demo fixtures never execute your program. Ordinary small TypeScript fixes apply when selected.",
        files: { "main.ts": '// Demo project action fixture\nimport { exampleRate } from "./rate";\n\nconsole.log(100 * (1 - exampleRate));\n',
            "rate.ts": '// Demo project action fixture\nexport const exampleRate = 0.1;\n' } };
    if (id === "diagnostics") return { id, title: "Diagnostic details",
        description: "Open Problems: the price mismatch is a real TypeScript error, with a related declaration. The labeled Demo host warning demonstrates a deprecated tag and a help link. Select a related location to inspect it; replace legacyPrice with currentPrice to clear the warning.",
        files: { "details.ts": '// Demo diagnostic metadata fixture\nimport type { Product } from "./types";\n\nconst currentPrice = 12;\nconst legacyPrice = currentPrice;\nconst product: Product = { price: "twelve" };\nconsole.log(product, legacyPrice);\n',
            "types.ts": 'export interface Product {\n  price: number;\n}\n' } };
    if (id === "navigation") return { id, title: "Unopened files & navigation",
        description: "Ctrl+click (Cmd+click on Mac) or press F12 on formatLabel to open labels.ts. Try RecordId to open its read-only declaration. Alt+Left returns to your previous selection.",
        initialFiles: ["main.ts"],
        files: { "main.ts": 'import { formatLabel } from "./labels";\nimport type { RecordId } from "./contracts";\n\nexport interface LabelOptions { prefix: string; }\nconst record: RecordId = "record-42";\nconst label = formatLabel(record);\nconsole.log(label);\n',
            "labels.ts": 'import type { LabelOptions } from "./main";\n\n/** Format a stable label for display. */\nexport function formatLabel(id: string, options: LabelOptions = { prefix: "Label" }): string {\n  return `${options.prefix}: ${id}`;\n}\n' },
        declarations: { "contracts.d.ts": '/** An identifier supplied by a host contract. This declaration is read-only. */\nexport type RecordId = `record-${number}`;\n' } };
    if (id === "documentation") return { id, title: "Documentation & help",
        description: "Inspect applyDiscount with Hover or Code → Inspect type. Inside the call, open Code → Signature help and use ↑ or ↓ to switch between the percentage and fixed-amount overloads.",
        files: { "documentation.ts": [
            "/**", " * Apply a **percentage discount** to a price.", " *", " * Use a fraction such as `0.1` for *ten percent*.", " *",
            " * - Keeps {@linkcode price} unchanged.", " * - Returns a new discounted value.", " *", " * ```typescript", " * applyDiscount(50, 0.1); // 45", " * ```", " *",
            " * [TypeScript function guide](https://www.typescriptlang.org/docs/handbook/2/functions.html)", " *",
            " * @param price The **original price** before the discount.", " * @param rate A fraction between `0` and `1`.", " */",
            "export function applyDiscount(price: number, rate: number): number;",
            "/** Deduct a fixed amount from the price. */", "export function applyDiscount(price: number, deduction: { amount: number }): number;",
            "export function applyDiscount(price: number, discount: number | { amount: number }): number {",
            "  return typeof discount === \"number\" ? price * (1 - discount) : price - discount.amount;", "}", "", "const discounted = applyDiscount(50, 0.1);", "",
        ].join("\n") } };
    if (id === "outline") return { id, title: "Host outline",
        description: "A plain host-owned outline, with no language server or compiler. Indentation defines nested blocks; #region markers define the regions group. Use the gutter or Code → Collapse group, then Find to reveal hidden text.",
        files: { "workflow.txt": "#region workflow\npipeline\n  inputs\n    source\n    settings\n\n  steps\n    prepare\n      validate\n      normalize\n    publish\n      report\n#endregion\n\nnotes\n  Editable text; Tab changes indentation.\n  Each view keeps its own collapsed blocks.\n" } };
    if (id === "results") return { id, title: "Project-wide results",
        description: "Open Problems to browse 300 type errors. In uses.ts, select sharedValue, then use Code → Find references or Rename to review all 1,201 occurrences. Results are paged; one undo restores a rename.",
        files: { "uses.ts": "const sharedValue = 1;\n" + Array.from({ length: 1200 }, (_, i) => `const use${i} = sharedValue;`).join("\n") + "\n",
            "problems.ts": Array.from({ length: 300 }, (_, i) => `const problem${i}: number = "needs a number";`).join("\n") + "\n" } };
    if (id === "templates") return { id, title: "Snippets & lazy completion", indentSize: 4,
        description: "Demo template provider: go to the end (Ctrl+End), press Ctrl+Space and Tab. Edit linked names, Tab/Shift+Tab through fields, Alt+Up/Down for choices; Escape finishes.",
        files: { "templates.ts": "// Demo-owned templates demonstrate the public completion protocol.\n// TypeScript still checks, colors and compiles these files.\n\ntemplate",
            "types.ts": 'export interface TemplateRecord {\n    state: "draft" | "ready";\n}\n' } };
    if (id === "catalogue") return { id, title: "Completion catalogue", indentSize: 4,
        description: "Go to the end (Ctrl+End), type catalogue. and explore 1,200 fields. Filter by typing item119, then choose with arrows and Tab.",
        files: { "catalogue.ts": "// A real TypeScript object supplies every completion candidate.\nconst catalogue = {\n"
            + Array.from({ length: 1200 }, (_, i) => `    item${String(i).padStart(4, "0")}: ${i},`).join("\n")
            + "\n};\n\n// Try catalogue. on the next line, or request completion with Ctrl+Space.\n" } };
    if (id === "large") return { id, title: "Large file", description: "Jump to the end, edit, search and undo in a 100,000-line file.",
        files: { "large.ts": Array.from({ length: 100_000 }, (_, i) => `// Row ${i + 1}: try editing or searching here.`).join("\n") } };
    if (id === "unicode") return { id, title: "Languages & Unicode", description: "Edit accents, emoji and different writing systems. Amber outlines mark unusual characters, including intentional emoji joiners. Code → Inspect source characters explains those near your cursor; Character warnings turns the outlines on or off.", files: {
        "greetings.ts": `// Invisible: a\u200bb | Non-breaking: a\u00a0b
const greetings = ["Bonjour", "日本語", "你好", "مرحبا", "שלום"];
const accents = "café · cafe\u0301";
const emoji = "👩‍💻 · 👨‍👩‍👧‍👦 · 🇫🇷";

// Multiline text keeps its syntax colors when you scroll.
const invitation = \`Welcome!
Choose a greeting: \${greetings.join(", ")}
Enjoy your visit.\`;

console.log(invitation, accents, emoji);
` } };
    return { id, title: id === "errors" ? "Fix a type error" : "Shopping cart", indentSize: 4,
        description: id === "errors" ? "The discount should be a number. Open Problems, then replace the string with 0.1 to fix the error."
            : "Edit the cart or compare the operators in readyToShip with View → Font ligatures.",
        files: { "main.ts": id === "errors" ? main.replace("calculateTotal(cart, 0.1)", 'calculateTotal(cart, "10%")') : main, "pricing.ts": pricing } };
}
