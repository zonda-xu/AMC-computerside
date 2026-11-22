import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from '../helpers.ts';
import { parseDelimited, previewProject, resultPath, sessionArtifacts } from '../../apps/gateway/src/artifacts.ts';

test('result references stay inside the authorized workspace and come from the current round',async()=>{
  const f=await fixture();try{
    await mkdir(join(f.w.path,'out'));await writeFile(join(f.w.path,'out','结果.csv'),'a,b\n1,2');await writeFile(join(f.w.path,'old.txt'),'old');
    f.s.runId='second';f.s.messages=[{id:'old',role:'assistant',text:'[old](old.txt)',complete:true,runId:'first'},{id:'request',role:'user',text:'make a table',complete:true,runId:'second'},{id:'answer',role:'assistant',text:'[表格](out/%E7%BB%93%E6%9E%9C.csv) [secret](../../private.txt) ![remote](https://example.com/a.png)',complete:true,runId:'second'},{id:'abandoned',role:'assistant',text:'[old](old.txt)',complete:true,abandoned:true}];
    const files=await sessionArtifacts(f.s,f.w);assert.equal(files.length,1);assert.equal(files[0].kind,'table');assert.equal(files[0].path,'out/结果.csv');
    assert.equal(resultPath(f.w,'../secret.txt'),undefined);assert.equal(resultPath(f.w,'data:image/png;base64,abcd'),undefined);assert.equal(resultPath(f.w,'file://outside/share/file.txt'),undefined);
    assert.equal(resultPath(f.w,join(f.w.path,'out','结果.csv')),'out/结果.csv');
    await assert.rejects(previewProject(f.w,'../b/absent.txt'));
  }finally{await f.close();}
});
test('Markdown links parse fragments before decoding and literal file paths preserve # and %',async()=>{
  const f=await fixture();
  try{
    const expected=['样本#1.txt','progress 100%25#raw.txt','tool%23#copy.txt','plain.md','url#result.txt','literal%23.txt'];
    await Promise.all([...expected,'样本'].map(name=>writeFile(join(f.w.path,name),name)));
    const url=pathToFileURL(join(f.w.path,'url#result.txt'));
    url.hash='heading';
    f.s.runId='current';
    f.s.messages=[{id:'answer',role:'assistant',complete:true,runId:'current',text:[
      '[样本](<'+encodeURIComponent('样本#1.txt')+'#section>)',
      '[普通段落](plain.md#heading)', '[本文件段落](#heading)',
      '`progress 100%25#raw.txt`', '[百分号只解码一次](literal%2523.txt)'
    ].join(' ')}];
    f.s.tools=[{id:'tool',title:'Saved file',status:'completed',runId:'current',
      detail:JSON.stringify({outputPath:join(f.w.path,'tool%23#copy.txt')})}];
    f.s.result={url:url.href};
    const files=await sessionArtifacts(f.s,f.w);
    assert.deepEqual(files.map(f=>f.path).sort(),expected.sort());
  }finally{await f.close();}
});
test('CSV preview respects quoted newlines and escaped quotes, and never evaluates formulas',()=>{
  const table=parseDelimited('name,value\r\n"line\nbreak","say ""yes"""\r\nformula,=1+2',',');
  assert.deepEqual(table,{columns:['name','value'],rows:[['line\nbreak','say "yes"'],['formula','=1+2']],truncated:false});
  assert.equal(parseDelimited('a\n'+Array(300).fill('x').join('\n'),',').rows.length,200);
  assert.equal(parseDelimited('a\n'+Array(300).fill('x').join('\n'),',').truncated,true);
});
test('image previews use file signatures; HTML remains inert text; other files remain downloadable',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.w.path,'fake.png'),'<script>alert(1)</script>');await assert.rejects(previewProject(f.w,'fake.png'),/signature/);
    await writeFile(join(f.w.path,'report.html'),'<script>alert(1)</script>');const html=await previewProject(f.w,'report.html');assert.equal(html.kind,'text');assert.equal(html.mime,'text/plain');
    await writeFile(join(f.w.path,'report.xlsx'),Buffer.from('example'));assert.equal((await previewProject(f.w,'report.xlsx')).kind,'file');
    await writeFile(join(f.w.path,'large.txt'),Buffer.alloc(1024*1024+1));assert.equal((await previewProject(f.w,'large.txt')).kind,'file');
  }finally{await f.close();}
});
