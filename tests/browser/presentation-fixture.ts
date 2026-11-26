import { test } from "./fixtures.ts";
import { editorModules } from "../helpers/fixture-modules.ts";
import type { DocumentId, Workspace } from "../../src/index.ts";
import type { TextComparison, TextEditor } from "../../src/browser/index.ts";

type Fixture = { workspace: Workspace; editor: TextEditor; host: HTMLElement; resource: DocumentId; comparison?: TextComparison };
declare global { interface Window { presentationFixture: Fixture } }

export const presentationTest = test.extend({
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
    page: async ({ page }, use) => {
        await editorModules(page, "/presentation-fixture/");
        await page.goto("/presentation-fixture/");
        await page.addStyleTag({ path: "src/browser/editor.css" });
        await use(page);
    },
});
