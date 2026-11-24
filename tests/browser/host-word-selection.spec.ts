import { ready,test,expect} from "./fixtures.ts";
import type {Page} from "@playwright/test";
const snapshot=(page:Page)=>page.evaluate(()=>window.hostFixture.snapshot());
const primary=(s:Awaited<ReturnType<typeof snapshot>>)=>s.bindings.views.find(v=>v.id==="primary")!;
const root=(page:Page)=>page.locator('.st-editor:has(> textarea[aria-label="Primary source"])');
const input=(page:Page)=>page.getByRole("textbox",{name:"Primary source",exact:true});
async function waitForReview(page: Page): Promise<void> {
    await ready(page);
    await page.waitForFunction(() => { const s = window.hostFixture.snapshot(); return window.hostFixture.settled && (s.bindings.comparison !== null); });
}
async function exact(page:Page,text:string):Promise<void>{expect(await page.evaluate(value=>{const f=window.hostFixture;return f.snapshot().source.length===value.length&&f.range(0,value.length)===value;},text)).toBe(true);}
const cases=[{name:"normal",count:60,before:"const ",selected:"sample",after:" = '😀 é';",inside:2},
  {name:"Unicode marks",count:60,before:"const ",selected:"café_東京",after:" = 1;",inside:2},{name:"emoji symbols",count:60,before:"const ",selected:"👩‍💻!?",after:" = 1;",inside:0},
  {name:"CJK identifiers",count:60,before:"const ",selected:"東京_9",after:" = 1;",inside:1},{name:"whitespace before leading mark",count:60,before:"const sample",selected:" \t",after:"́ next",inside:0}];
async function nativeReplacement(page:Page,entry:typeof cases[number]){
  const controlPage=await page.context().newPage();try{
    await controlPage.setContent('<textarea aria-label="Native replacement control"></textarea>');const control=controlPage.getByRole("textbox",{name:"Native replacement control"});await control.focus();
    await control.evaluate((element,entry)=>{if(!(element instanceof HTMLTextAreaElement))throw new Error("Missing native textarea.");element.value=entry.before+entry.selected+entry.after;element.setSelectionRange(entry.before.length,entry.before.length+entry.selected.length);element.addEventListener("input",event=>{element.dataset.trusted=String(event.isTrusted);},{once:true});},entry);
    await control.pressSequentially("q");const result=await control.evaluate(element=>{if(!(element instanceof HTMLTextAreaElement))throw new Error("Missing native textarea.");return{text:element.value,anchor:element.selectionStart,head:element.selectionEnd,trusted:element.dataset.trusted};});expect(result.text).toBe(entry.before+"q"+entry.after);expect(result.trusted).toBe("true");return result;
  }finally{await controlPage.close();}
}
for(const entry of cases)test(`plain ${entry.name} doubleclick selects the source word and typing replaces it as one undoable saved-reference edit`,async({page},testInfo)=>{
  const native=await nativeReplacement(page,entry);
  await testInfo.attach("native replacement control",{body:JSON.stringify(native),contentType:"application/json"});

  await page.goto(`/hosts/plain/`);await expect(input(page)).toBeVisible();const original=Array(entry.count).fill(entry.before+entry.selected+entry.after).join("\r\n"),from=entry.before.length,to=from+entry.selected.length;
  await page.evaluate(text=>{const f=window.hostFixture,s=f.snapshot();f.editSource(s.source.revision,[{from:0,to:s.source.length,insert:text}]);f.selectSource("secondary",f.snapshot().source.revision,{anchor:4,head:1});},original);
  await page.getByRole("button",{name:"Open source review",exact:true}).click();await waitForReview(page);await page.getByRole("button",{name:"Save source",exact:true}).click();await expect.poll(async()=>(await snapshot(page)).pendingSaves.length).toBe(1);await page.evaluate(()=>window.hostFixture.finishSave());await expect.poll(async()=>(await snapshot(page)).pendingCommands).toBe(0);
  await page.getByRole("button",{name:"Capture reference refresh",exact:true}).click();await page.getByRole("button",{name:"Finish reference refresh",exact:true}).click();await waitForReview(page);
  const comparison=page.getByRole("textbox",{name:"Comparison working source",exact:true});await comparison.press("Control+Home");await comparison.press("ArrowRight");await comparison.press("ArrowRight");await comparison.press("Shift+ArrowRight");await comparison.press("Shift+ArrowRight");await input(page).press("Control+Home");await waitForReview(page);await root(page).scrollIntoViewIfNeeded();
  const point=await root(page).evaluate((element,offset)=>{const row=element.querySelector(".st-viewport-row");if(!row)throw new Error("Missing first source row.");const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),nodes:Text[]=[];for(let node=walker.nextNode();node;node=walker.nextNode())nodes.push(node as Text);const locate=(offset:number)=>{for(const node of nodes){if(offset<=node.length)return{node,offset};offset-=node.length;}throw new Error("Missing sample word.");};const a=locate(offset),b=locate(offset+1),range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);const r=range.getBoundingClientRect();element.dataset.wordDoubleTrusted="false";element.addEventListener("dblclick",event=>{element.dataset.wordDoubleTrusted=String(event.isTrusted);},{once:true});return{x:r.left+r.width*.25,y:r.top+r.height*.5};},from+entry.inside);
  const before=await snapshot(page);await page.mouse.dblclick(point.x,point.y);await waitForReview(page);expect(await root(page).getAttribute("data-word-double-trusted")).toBe("true");const selected=await snapshot(page);
  expect(primary(selected).selection).toMatchObject({anchor:from,head:to});expect(selected.source.revision).toBe(before.source.revision);expect(selected.history).toEqual(before.history);expect(selected.bindings.views.find(v=>v.id==="secondary")!.selection).toEqual(before.bindings.views.find(v=>v.id==="secondary")!.selection);expect(selected.bindings.comparison!.selection).toEqual(before.bindings.comparison!.selection);
  await input(page).pressSequentially("q");await waitForReview(page);const expected=original.slice(0,from)+"q"+original.slice(to),edited=await snapshot(page);await exact(page,expected);expect(primary(edited).selection).toMatchObject({anchor:native.anchor,head:native.head});expect(edited.history.undoDepth).toBe(before.history.undoDepth+1);expect(edited.source.serverVersion).toBe("v1");expect(edited.source.dirty).toBe(true);expect(edited.bindings.comparison!.baseline!.version).toBe("reference:saved-v1");expect(await page.evaluate(text=>window.hostFixture.referenceRange(0,text.length)===text,original)).toBe(true);await expect(input(page)).toBeFocused();
  await input(page).press("Control+z");await waitForReview(page);await exact(page,original);expect((await snapshot(page)).source.dirty).toBe(false);await input(page).press("Control+Shift+z");await waitForReview(page);await exact(page,expected);
  await page.evaluate(()=>window.hostFixture.dispose());
});

async function longWord(page:Page,host:string){
  await page.goto(`/hosts/${host}/`);await expect(input(page)).toBeVisible();const original="x".repeat(200000);
  await page.evaluate(text=>{const f=window.hostFixture,s=f.snapshot();f.editSource(s.source.revision,[{from:0,to:s.source.length,insert:text}]);f.selectSource("secondary",f.snapshot().source.revision,{anchor:4,head:1});},original);await page.getByRole("button",{name:"Open source review",exact:true}).click();await waitForReview(page);
  await page.getByRole("button",{name:"Save source",exact:true}).click();await expect.poll(async()=>(await snapshot(page)).pendingSaves.length).toBe(1);await page.evaluate(()=>window.hostFixture.finishSave());await expect.poll(async()=>(await snapshot(page)).pendingCommands).toBe(0);await page.getByRole("button",{name:"Capture reference refresh",exact:true}).click();await page.getByRole("button",{name:"Finish reference refresh",exact:true}).click();await waitForReview(page);await input(page).press("Control+Home");await waitForReview(page);await root(page).scrollIntoViewIfNeeded();
  const point=await root(page).evaluate(element=>{const row=element.querySelector(".st-viewport-row");if(!row)throw new Error("Missing long source row.");const node=document.createTreeWalker(row,NodeFilter.SHOW_TEXT).nextNode();if(!node)throw new Error("Missing long source text.");const range=document.createRange();range.setStart(node,8);range.setEnd(node,9);const r=range.getBoundingClientRect();return{x:r.left+r.width*.25,y:r.top+r.height*.5};});return{original,point,before:await snapshot(page)};
}
test("double-clicking a long word makes it one undoable replacement", async ({ page }) => {
    const { original, point } = await longWord(page, "plain");
    await page.mouse.dblclick(point.x, point.y);
    await input(page).pressSequentially("q");
    await waitForReview(page);
    await exact(page, "q");
    await input(page).press("Control+z");
    await waitForReview(page);
    await exact(page, original);
    expect(primary(await snapshot(page)).selection).toMatchObject({ anchor: 0, head: original.length });
});
