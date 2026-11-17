import test from "node:test";
import assert from "node:assert/strict";
import {TextBuffer,WordCursor} from "../src/index.ts";
import type {WordOptions} from "../src/index.ts";
function boundary(buffer:TextBuffer,offset:number,direction:-1|1,options:WordOptions={}):number{
  const cursor=new WordCursor(buffer,offset,direction,{...options,skipWhitespace:false});let prior=0,result;
  do{result=cursor.next(256);assert.ok(result.workUnits-prior<=512);assert.ok(result.readUnits<=result.workUnits+512);prior=result.workUnits;}while(result.status==="running");
  assert.equal(result.status,"ready");const answer=result.offset!;cursor.dispose();return answer;
}
test("lexical run boundaries exclude neighboring whitespace and stay inside captured raw-line bounds",()=>{
  const text="before\r\nalpha_beta  gamma.delta 😀 café\r\nafter",buffer=TextBuffer.from(text),from=text.indexOf("alpha"),to=text.lastIndexOf("\r\n"),options={from,to};
  assert.equal(boundary(buffer,from+3,-1,options),from);assert.equal(boundary(buffer,from+3,1,options),from+10);
  assert.equal(boundary(buffer,from+10,1,options),from+12);assert.equal(boundary(buffer,from+12,-1,options),from+10);
  assert.equal(boundary(buffer,to-1,1,options),to);assert.equal(boundary(buffer,from,-1,options),from);
  assert.equal(new WordCursor(buffer,from+3,1).next().offset,from+12);assert.equal(buffer.readMetrics().textExports,0);
  for(const options of [{from:-1},{to:buffer.length+1},{from:from+1},{to:from-1}])assert.throws(()=>new WordCursor(buffer,from,1,options),RangeError);
});
test("run scans yield over millions of word, symbol and whitespace units and release cancelled captures",()=>{
  for(const token of ["x","!"," ","東","\u0301","\u3000"]){const original=TextBuffer.from(token.repeat(2400000)),buffer=original.replace(255,255,token),cursor=new WordCursor(buffer,1200000,1,{skipWhitespace:false});
    const first=cursor.next(256);assert.equal(first.status,"running");assert.ok(first.readUnits<=768);assert.equal(boundary(buffer,1200000,-1),0);assert.equal(boundary(buffer,1200000,1),buffer.length);assert.equal(buffer.readMetrics().textExports,0);
    cursor.dispose();assert.equal(cursor.next().status,"disposed");assert.equal(cursor.next().offset,null);
  }
});

test("Unicode runs preserve raw clipped surrogate seams and the final whitespace control",()=>{
  const buffer=TextBuffer.from("!"+"𐐀".repeat(300)+"?");
  for(const [offset,direction,from,to,expected] of [[1,1,0,602,601],[601,-1,0,602,1],
    [2,1,2,600,3],[600,-1,2,600,599],[300,1,0,602,301],[300,-1,0,602,299],
    [3,1,3,599,599],[599,-1,3,599,3]] as const){
    assert.equal(boundary(buffer,offset,direction,{from,to}),expected,JSON.stringify({offset,direction,from,to}));
  }
  for(const spaces of ["\u00a0 \u2028","\u0085\u2029\t","\u2028\u0085\u00a0"]){
    const source=TextBuffer.from("東".repeat(260)+spaces+"\u0301".repeat(260)+"𐐀"),control=/[\t\u2028]$/u.test(spaces);
    assert.equal(boundary(source,0,1),260);
    assert.equal(boundary(source,260,1),control?263:523);
    assert.equal(boundary(source,263,1),523);
    assert.equal(boundary(source,523,-1),control?263:260);
    assert.equal(boundary(source,525,-1),523);
    assert.equal(source.readMetrics().textExports,0);
  }
  assert.equal(buffer.readMetrics().textExports,0);
});
test("Unicode and fragmented run scans match an independent complete grapheme/run table",()=>{
  const segmenter=new Intl.Segmenter(undefined,{granularity:"grapheme"}),tokens=["alpha","βγ","東京","नम","123","_","é","👩‍💻","!?","😀","  ","\t","\r\n","\u0301"];
  let seed=0x291b;const random=(limit:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%limit;};
  for(let trial=0;trial<180;trial++){
    const text=Array.from({length:3+random(18)},()=>tokens[random(tokens.length)]!).join("");let buffer=TextBuffer.from("");for(let i=0;i<text.length;){const end=Math.min(text.length,i+1+random(13));buffer=buffer.replace(buffer.length,buffer.length,text.slice(i,end));i=end;}
    const clusters=[...segmenter.segment(text)],runs:{from:number;to:number;kind:string}[]=[];
    for(const c of clusters){const kind=/^\p{White_Space}/u.test(c.segment)?"space":/^[\p{L}\p{N}\p{Pc}]/u.test(c.segment)?"word":"symbol",last=runs.at(-1);if(last?.kind===kind)last.to=c.index+c.segment.length;else runs.push({from:c.index,to:c.index+c.segment.length,kind});}
    for(const c of clusters){const run=runs.find(r=>r.from<=c.index&&r.to>c.index)!;assert.equal(boundary(buffer,c.index,1),run.to,JSON.stringify({text,offset:c.index,direction:1}));assert.equal(boundary(buffer,c.index+c.segment.length,-1),run.from,JSON.stringify({text,offset:c.index,direction:-1}));}
    assert.equal(buffer.readMetrics().textExports,0);
  }
});
