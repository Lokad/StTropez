import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {performance} from "node:perf_hooks";
import {distribution,environment,sourceIdentity} from "./measurement.mjs";
import {typeHostSuffix} from "./host-typing.mjs";
import {installHostReferenceProbe} from "./host-reference-probe.mjs";

/** Actual restored modules, with host-owned deferred local ports and shared interaction probes. */
export async function runPackagedPilot(browser,baseUrl,{directory,packageSha256,benchmark=false}) {
    const source=await sourceIdentity(),warmup=benchmark?3:0,measured=benchmark?10:1,cases=[],errors=[];
    let page,activeCase;await mkdir(directory,{recursive:true});
    try {
        for(const corpus of ["normal","lines-100000"]) {
            const original=corpus==="normal"?"const café = 'e\u0301 👩‍💻';\r\nconst end = 1;":Array.from({length:100000},(_,i)=>`const value${String(i).padStart(6,"0")} = 123;`).join("\n");
            const samples=[],warmupSamples=[];
            for(let iteration=0;iteration<warmup+measured;iteration++) {
                activeCase={corpus,iteration,stage:"mount"};page=await browser.newPage({viewport:{width:1440,height:1000}});
                page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>{if(message.type()==="error")errors.push(message.text());});
                await page.goto(new URL("/pilot",baseUrl).href);await page.waitForFunction(()=>typeof window.mountPackagedPilot==="function");
                await page.evaluate(text=>window.mountPackagedPilot(text),original);await page.evaluate(installHostReferenceProbe);
                const snapshot=()=>page.evaluate(()=>window.hostFixture.snapshot()),ready=()=>page.evaluate(()=>window.hostReferenceProbe.waitReady());
                const click=name=>page.getByRole("button",{name,exact:true}).click();
                const primary=page.getByRole("textbox",{name:"Primary source",exact:true}),peer=page.getByRole("textbox",{name:"Secondary source",exact:true}),working=page.getByRole("textbox",{name:"Comparison working source",exact:true});
                const exact=async(text,reference=false)=>assert.equal(await page.evaluate(({text,reference})=>{
                    const f=window.hostFixture,s=f.snapshot();if((reference?s.bindings.comparison?.baseline.length:s.source.length)!==text.length)return false;
                    for(let from=0;from<text.length;from+=32768)if((reference?f.referenceRange(from,Math.min(text.length,from+32768)):f.range(from,Math.min(text.length,from+32768)))!==text.slice(from,from+32768))return false;return true;
                },{text,reference}),true);
                const bounds=s=>{for(const v of s.bindings.views){assert.ok(v.metrics.inputUnits<=2600);assert.ok(v.metrics.viewport.rows<100&&v.metrics.viewport.readUnits<20000);}const c=s.bindings.comparison;assert.ok(c.input.inputUnits<=2600);assert.ok(c.workingViewport.rows+c.referenceViewport.rows<100);assert.ok(c.workingViewport.readUnits<20000&&c.referenceViewport.readUnits<20000);assert.deepEqual(s.errors,[]);};
                const type=async(input,text)=>{const history=await typeHostSuffix(input,text);await ready();const s=await snapshot();assert.equal(s.source.exports,0);bounds(s);return history;};
                const pending=async(version,text)=>{
                    await page.waitForFunction(()=>window.hostFixture.snapshot().pendingSaves.length===1);
                    const s=await snapshot(),rows=s.pendingSaves;assert.equal(rows.length,1);const captured=rows[0];assert.equal(captured.resourceId,s.source.id);assert.equal(captured.expectedServerVersion,version);assert.equal(captured.length,text.length);
                    assert.equal(await page.evaluate(({id,text})=>{const f=window.hostFixture;for(let from=0;from<text.length;from+=32768)if(f.pendingRange(id,from,Math.min(text.length,from+32768))!==text.slice(from,from+32768))return false;return true;},{id:captured.id,text}),true);return captured;
                };
                const respond=async(capture,kind)=>{assert.equal(await page.evaluate(({id,kind})=>window.hostFixture.respond(id,kind),{id:capture.id,kind}),true);await page.waitForFunction(()=>window.hostFixture.snapshot().pendingCommands===0);};
                await ready();const initial=await snapshot();bounds(initial);assert.equal(initial.source.dirty,false);assert.equal(initial.source.exports,0);assert.equal(initial.bindings.comparison.referenceIsWorkingBuffer,true);
                const ids=initial.bindings.views.map(v=>v.viewId),reviewId=initial.bindings.comparison.viewId;const began=performance.now();
                activeCase.stage="captured conflict";await primary.focus();await primary.press("Control+Home");const local=await type(primary,"local ");
                let expected="local "+original;await exact(expected);await click("Save source");const first=await pending("v0",expected);
                await primary.focus();const later=await type(primary,"later ");expected="local later "+original;await exact(expected);await respond(first,"conflict");await ready();
                assert.equal((await snapshot()).source.serverVersion,"v0");assert.equal((await snapshot()).source.saveStatus,"conflict");await exact(expected);assert.equal((await snapshot()).bindings.comparison.baseline.version,"saved:v0");
                await click("Review remote source");await ready();await exact("remote "+original,true);assert.equal((await snapshot()).bindings.comparison.baseline.version,"remote:v1");
                activeCase.stage="reviewed failure";await working.focus();await working.press("Control+Home");const correction=await type(working,"correct ");expected="correct local later "+original;await exact(expected);
                await click("Save reviewed source");const failed=await pending("v1",expected);await working.focus();const late=await type(working,"late ");expected="correct late local later "+original;await exact(expected);
                await respond(failed,"failure");await ready();assert.equal((await snapshot()).source.saveStatus,"failed");assert.equal((await snapshot()).source.serverVersion,"v0");assert.equal((await snapshot()).reportedFailures,1);
                activeCase.stage="point input after failure";await primary.focus();await ready();assert.equal((await snapshot()).bindings.views.find(v=>v.id==="primary").selection.head,25);
                await page.evaluate(()=>window.hostReferenceProbe.arm({kind:"input",text:"q"}));let pointStarted;
                const pointHistory=await typeHostSuffix(primary,"q",()=>{pointStarted=performance.now();return primary.press("q");});
                const point=await page.evaluate(()=>window.hostReferenceProbe.read());point.completeActionProxyMs=performance.now()-pointStarted;
                expected="correct late local later q"+original;await exact(expected);assert.equal(point.records.length,1);assert.equal(point.exports,0);bounds(await snapshot());
                activeCase.stage="reviewed retry and remount";await click("Save reviewed source");const retry=await pending("v1",expected);await working.focus();const tail=await type(working,"tail ");
                const submitted=expected;expected="correct late tail local later q"+original;await exact(expected);const beforeRemount=await snapshot();
                assert.deepEqual(beforeRemount.bindings.views.find(v=>v.id==="secondary").selection,{anchor:43,head:34,anchorAffinity:"before",headAffinity:"after"});
                assert.equal(await page.evaluate(()=>window.hostFixture.remount()),true);await ready();const remounted=await snapshot();
                assert.deepEqual(remounted.bindings.views.map(v=>v.viewId),ids);assert.equal(remounted.bindings.comparison.viewId,reviewId);assert.deepEqual(remounted.bindings.views.map(v=>v.selection),beforeRemount.bindings.views.map(v=>v.selection));assert.deepEqual(remounted.bindings.comparison.selection,beforeRemount.bindings.comparison.selection);assert.equal(remounted.source.revision,beforeRemount.source.revision);assert.equal(remounted.bindings.mounts,2);assert.equal(await working.evaluate(node=>node.ownerDocument.activeElement===node),true);
                await respond(retry,"saved");await ready();let s=await snapshot();assert.equal(s.source.serverVersion,"v2");assert.equal(s.source.dirty,true);assert.equal(s.lastOutcome.canonicalApplied,false);await exact(expected);
                await click("Show saved reference");await ready();await exact(submitted,true);await primary.focus();for(let i=0;i<tail.groups;i++)await primary.press("Control+z");await ready();await exact(submitted);assert.equal((await snapshot()).source.dirty,false);
                await peer.focus();for(let i=0;i<tail.groups;i++)await peer.press("Control+Shift+z");await ready();await exact(expected);assert.equal((await snapshot()).source.dirty,true);
                if(!benchmark)await page.screenshot({path:`${directory}/consumer-pilot-${browser.browserType().name()}-${corpus}.png`});
                activeCase.stage="canonical reply preserves later typing";await click("Save source");const canonical=await pending("v2",expected),canonicalText=expected+"\r\ncanonical server reply";
                await primary.focus();await primary.press("Control+Home");const newest=await type(primary,"new ");expected="new "+expected;await exact(expected);await respond(canonical,"canonical");await ready();
                s=await snapshot();assert.equal(s.source.serverVersion,"v3");assert.equal(s.source.dirty,true);assert.equal(s.lastOutcome.canonicalApplied,false);await exact(expected);await click("Show saved reference");await ready();await exact(canonicalText,true);
                activeCase.stage="dispose during pending save and late failure";await click("Save source");const finalSave=await pending("v3",expected);await primary.focus();await primary.press("Control+Home");const kept=await type(primary,"kept ");expected="kept "+expected;await exact(expected);
                const beforeDispose=await snapshot();bounds(beforeDispose);assert.equal(beforeDispose.trustedInputEvents,40);assert.equal(beforeDispose.untrustedInputEvents,0);assert.equal(beforeDispose.source.revision,40+2*tail.groups);assert.ok(beforeDispose.activity.background>0);
                await page.evaluate(()=>window.hostFixture.dispose());const detached=await snapshot();assert.equal(detached.diagnostics.views,0);assert.equal(detached.diagnostics.subscriptions,0);assert.equal(detached.diagnostics.tabs,0);assert.equal(detached.diagnostics.leases,1);assert.equal(detached.diagnostics.resources,1);
                await respond(finalSave,"failure");const retained=await snapshot();assert.equal(retained.pendingCommands,0);assert.equal(retained.diagnostics.leases,0);assert.equal(retained.diagnostics.views,0);assert.equal(retained.diagnostics.subscriptions,0);assert.equal(retained.source.dirty,true);assert.equal(retained.source.serverVersion,"v3");assert.equal(retained.source.saveStatus,"failed");assert.equal(retained.reportedFailures,2);await exact(expected);assert.equal(await page.locator(".st-editing-candidate").count(),0);
                await page.evaluate(()=>window.hostFixture.release());const released=await snapshot();assert.equal(released.diagnostics.resources,0);assert.equal(released.diagnostics.documents,0);assert.equal(released.diagnostics.leases,0);assert.equal(released.diagnostics.subscriptions,0);assert.equal(released.diagnostics.history.groups,0);
                const sample={iteration,point,pointHistory,workflowAutomationProxyMs:performance.now()-began,sourceLength:original.length,backgroundUpdates:beforeDispose.activity.background,trustedInputEvents:40,savePreconditions:[first,failed,retry,canonical,finalSave],typingGroups:{local,later,correction,late,tail,newest,kept},retainedViewIds:ids,retainedComparisonViewId:reviewId,beforeDispose,detached,retained,released};
                (iteration<warmup?warmupSamples:samples).push(sample);assert.deepEqual(errors,[]);console.log(JSON.stringify({corpus,iteration,measured:iteration>=warmup,semanticChecks:"passed",handlerMs:point.records[0].inputHandlerMs,readyMs:point.lastInputToFullReviewReadyProxyMs,workflowMs:sample.workflowAutomationProxyMs}));await page.close();page=undefined;
            }
            const stats=values=>({...distribution(values),max:Math.max(...values)}),large=original.length>100000;
            const metrics={inputHandlerMs:stats(samples.map(s=>s.point.records[0].inputHandlerMs)),inputToFullReviewReadyProxyMs:stats(samples.map(s=>s.point.lastInputToFullReviewReadyProxyMs)),completePointActionProxyMs:stats(samples.map(s=>s.point.completeActionProxyMs)),workflowAutomationProxyMs:stats(samples.map(s=>s.workflowAutomationProxyMs))};
            cases.push({corpus,length:original.length,warmup,measured,diagnosticOnly:!benchmark,...metrics,assessment:benchmark?{handlerMet:metrics.inputHandlerMs.p95<=16,readinessMet:metrics.inputToFullReviewReadyProxyMs.p95<=(large?250:100),pointActionMet:metrics.completePointActionProxyMs.p95<=(large?500:200)}:null,warmupSamples,samples});
        }
        assert.equal((await sourceIdentity()).sha256,source.sha256);
        const report={schemaVersion:1,source,created:new Date().toISOString(),packageSha256,benchmark,environment:{...environment(),browser:browser.browserType().name(),browserVersion:browser.version()},cases,errors,
            boundaries: "Restored assets, declarations and CSS only; the host owns local deferred ports and 20 Hz progress. " +
                "Each normal/100k workflow has a fresh page and controller. Actual typing continues through conflict, reviewed failure, retry, remount and canonical replies. " +
                "Shared undo returns to the saved value; disposal and a late failure retain unsaved source until explicit release. " +
                "Only the point q after failure is timed for the point assessment. Readiness starts at beforeinput and waits for exact model, all three working panes, immutable reference, caret, scans, diff and two frames. " +
                "The adapter handler excludes beforeinput and observer work; it is neither a complete traced callback nor full interaction latency. Complete point action includes automation and observations. " +
                "The whole workflow proxy includes controls, transport, local settlement, full-source/range oracles and cleanup, with no imposed service delay or point budget. " +
                "Semantic mode has one diagnostic sample per corpus and includes its screenshot inside the workflow proxy; it establishes no tail estimate. Benchmark mode has three warmups and ten measurements without screenshots. " +
                "Explicit save captures export once; ordinary typing creates buffers with zero exports. Undo can restore a previously explicitly exported saved buffer. " +
                "Native IME, reconversion, OS clipboard, physical display latency and production tails remain unverified."};
        const path=`${directory}/pilot-${benchmark?"bench-":""}${browser.browserType().name()}.json`;await writeFile(path,JSON.stringify(report,null,2));return report;
    }catch(error){const path=`${directory}/pilot-failure-${Date.now()}`;await writeFile(path+".json",JSON.stringify({source,packageSha256,activeCase,error:String(error?.stack??error),cases,snapshot:page?await page.evaluate(()=>window.hostFixture?.snapshot()).catch(()=>null):null,errors},null,2));if(page)await page.screenshot({path:path+".png",fullPage:true}).catch(()=>{});throw error;}
    finally{await page?.close();}
}
