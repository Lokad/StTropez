export type SampleId = "pricing" | "errors" | "unicode" | "large";
export type DemoSample = Readonly<{ id: SampleId; title: string; description: string; files: Readonly<Record<string, string>> }>;

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
]);

/** Large fixtures are built only on explicit selection. */
export function demoSample(id: SampleId): DemoSample {
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
