import test from "node:test";
import assert from "node:assert/strict";
const { moduleSpecifiers, portableDeclaration } = await import(new URL("../scripts/module-specifiers.mjs", import.meta.url).href) as {
    moduleSpecifiers(path: string, text: string): { value: string; from: number; to: number }[];
    portableDeclaration(path: string, text: string): string;
};

test("declaration modules become portable without rewriting data literals, package names or comments", () => {
    const declaration = `import './side.ts';
import type { A } from '../a.ts';
export { B } from './b.mts';
export type C = typeof import('./c.ts');
export type D = import('./d.tsx').D;
import E = require('./e.cts');
declare module './augment.d.ts' { export type Value = './data.ts'; }
export type Package = import('package.ts').Value;
// import('./comment.ts')
export type Text = "from './literal.ts'";
`;
    const result = portableDeclaration("index.d.ts", declaration);
    assert.deepEqual(moduleSpecifiers("index.d.ts", result).map(item => item.value),
        ["./side.js", "../a.js", "./b.mjs", "./c.js", "./d.js", "./e.cjs", "./augment.js", "package.ts"]);
    assert.ok(result.includes("export type Value = './data.ts'"));
    assert.ok(result.includes("// import('./comment.ts')")); assert.ok(result.includes('"from \'./literal.ts\'"'));
    assert.equal(portableDeclaration("index.d.ts", result), result);
    assert.throws(() => portableDeclaration("broken.d.ts", "export type X = import("), /Invalid module syntax/);
    const dynamic = "export const load = () => import('./lazy.ts');";
    assert.equal(moduleSpecifiers("host.ts", dynamic)[0]!.value, "./lazy.ts");
});
