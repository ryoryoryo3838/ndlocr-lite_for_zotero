const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'ndlocr-safety-'));
  const dir = path.join(root, 'storage'); fs.mkdirSync(dir);
  const pdf = path.join(dir, 'doc.pdf'); fs.writeFileSync(pdf, 'original');
  const item = { id: 1, key: 'KEY', libraryID: 1, attachmentFilename: 'doc.pdf', getFilePathAsync: async () => pdf };
  const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  const io = {
    exists: async p => fs.existsSync(p), stat: async p => ({ size: fs.statSync(p).size }),
    makeDirectory: async p => fs.mkdirSync(p, { recursive: true }),
    copy: async (a,b) => fs.copyFileSync(a,b), move: async (a,b) => fs.renameSync(a,b),
    read: async (p,o) => fs.readFileSync(p).subarray(0,o?.maxBytes),
    write: async (p,b) => fs.writeFileSync(p,b), writeUTF8: async (p,s) => fs.writeFileSync(p,s),
    writeJSON: async (p,o) => fs.writeFileSync(p,JSON.stringify(o)), readJSON: async p => JSON.parse(fs.readFileSync(p)),
    remove: async p => fs.rmSync(p,{recursive:true,force:true})
  };
  const alerts = [];
  const Zotero = { isWin:false, DataDirectory:{dir:root}, Utilities:{randomString:()=> 'xyz', Internal:{md5Async:async p=>md5(p)}},
    Prefs:{set(){}}, File:{getResourceAsync:async()=>''}, logError(){}, debug(){},
    Attachments:{getStorageDirectory:()=>({path:dir})},
    ProgressWindow:function(){this.changeHeadline=()=>{};this.show=()=>{};this.startCloseTimer=()=>{};this.ItemProgress=function(){this.setText=()=>{};this.setProgress=()=>{}};}
  };
  const ctx = vm.createContext({ Zotero, IOUtils:io, PathUtils:{join:path.join,parent:path.dirname,filename:path.basename}, Services:{prompt:{confirm:()=>true, alert:(w,t,m)=>alerts.push(m)}}, ChromeUtils:{importESModule:()=>({})}, console });
  vm.runInContext('var NDLOCRIndex;'+fs.readFileSync(path.join(__dirname,'../plugin/ndlocr-index.js'),'utf8')+';this.plugin=NDLOCRIndex;',ctx);
  const p=ctx.plugin; p.pref=k=>({pdfOutput:'replace',backupOriginal:false})[k]; p.checkEnv=async()=>({ok:true,dir:root}); p.classify=async()=>({path:pdf}); p.applyIndex=async()=>{};
  return {root,dir,pdf,item,md5,io,p,alerts,Zotero,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('forced re-OCR refuses edits made before OCR', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'original OCR');
  const replaced=f.md5(f.pdf); await f.p.writeSidecar(f.item,{text:'old',pages:1,dpi:150},{replaced:true,originalMD5:original,originalSize:8,replacedMD5:replaced,backup:null});
  fs.writeFileSync(f.pdf,'user edits'); let called=false;
  f.p.runOCR=async (env,source,cb,out)=>{called=true;fs.writeFileSync(out,'new OCR');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'user edits'); assert.equal(called,false);
});

test('replacement retains restoration metadata if indexing fails', async t=>{
  const f=fixture(); t.after(f.cleanup);
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(out,'original OCR');return {text:'new',pages:1,dpi:150,incremental:true}};
  f.p.applyIndex=async()=>{throw new Error('index failed')};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  const side=await f.p.readSidecar(f.item);
  assert.ok(side?.replaced); assert.equal(side.replacedMD5,f.md5(f.pdf));
  await f.p.restorePDF(f.item,side); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('non-incremental re-OCR preserves the original after backup-free incremental OCR', async t=>{
  const f=fixture(); t.after(f.cleanup);
  let incremental=true;
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(out,incremental?'original OCR':'rewritten PDF');return {text:'new',pages:1,dpi:150,incremental}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  incremental=false; await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  const side=await f.p.readSidecar(f.item);
  await f.p.restorePDF(f.item,side); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('setup does not treat an unrelated virtual environment as an installation', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const project=path.join(f.root,'project'); fs.mkdirSync(path.join(project,'.venv'),{recursive:true});
  f.p._run=async()=>({exitCode:0,output:''});
  const r=await f.p.setup(project);
  assert.equal(r.dir,path.join(project,'ndlocr-lite-zotero'));
  assert.equal(fs.existsSync(path.join(project,'install_mac.command')),false);
});

test('failed restore copy does not damage the replaced PDF or backup', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const backup=path.join(f.root,'original.pdf'); fs.copyFileSync(f.pdf,backup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'rewritten PDF');
  const side={replaced:true,backup,originalMD5:original,replacedMD5:f.md5(f.pdf)};
  const copy=f.io.copy; f.io.copy=async (a,b)=>{if(a===backup){fs.writeFileSync(b,'partial');throw new Error('copy failed');}return copy(a,b)};
  await assert.rejects(f.p.restorePDF(f.item,side));
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'rewritten PDF'); assert.equal(fs.readFileSync(backup,'utf8'),'original');
});

test('initial OCR refuses edits made during OCR', async t=>{
  const f=fixture(); t.after(f.cleanup);
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(f.pdf,'user edits');fs.writeFileSync(out,'new OCR');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'user edits');
});

test('OCR edits do not overwrite an existing backup file', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const backup=f.p.backupPath(f.item); fs.mkdirSync(path.dirname(backup),{recursive:true}); fs.writeFileSync(backup,'valuable backup');
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(f.pdf,'user edits');fs.writeFileSync(out,'new OCR');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(fs.readFileSync(backup,'utf8'),'valuable backup');
});

test('replacement never overwrites an unrelated existing backup', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const backup=f.p.backupPath(f.item); fs.mkdirSync(path.dirname(backup),{recursive:true}); fs.writeFileSync(backup,'valuable backup');
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(out,'new OCR');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(fs.readFileSync(backup,'utf8'),'valuable backup');
});

test('corrupted existing backup cannot become the only restoration path', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); const backup=path.join(f.root,'backup.pdf'); fs.writeFileSync(backup,'corrupt'); fs.writeFileSync(f.pdf,'old OCR');
  await f.p.writeSidecar(f.item,{text:'old',pages:1,dpi:150},{replaced:true,backup,originalMD5:original,originalSize:null,replacedMD5:f.md5(f.pdf)});
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(out,'new OCR');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'old OCR');
});

test('invalid incremental output cannot discard the only original', async t=>{
  const f=fixture(); t.after(f.cleanup);
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(out,'not appended');return {text:'new',pages:1,incremental:true}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  const side=await f.p.readSidecar(f.item);
  if (side?.replaced) await f.p.restorePDF(f.item,side);
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('interruption on first OCR without prior sidecar removes the pending record', async t=>{
  const f=fixture(); t.after(f.cleanup); const sidePath=path.join(f.dir,'.zotero-ndlocr.json');
  let snapshot; const move=f.io.move;
  f.io.move=async(a,b)=>{if(b===f.pdf) snapshot=fs.readFileSync(sidePath,'utf8'); return move(a,b)};
  f.p.runOCR=async(env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.ok(snapshot); fs.writeFileSync(f.pdf,'original'); fs.writeFileSync(sidePath,snapshot);
  assert.equal(await f.p.readSidecar(f.item),null); assert.equal(fs.existsSync(sidePath),false);
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('interruption refuses recovery when the PDF has unexpected edits', async t=>{
  const f=fixture(); t.after(f.cleanup); const sidePath=path.join(f.dir,'.zotero-ndlocr.json');
  let snapshot; const move=f.io.move;
  f.io.move=async(a,b)=>{if(b===f.pdf) snapshot=fs.readFileSync(sidePath,'utf8'); return move(a,b)};
  f.p.runOCR=async(env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.ok(snapshot); fs.writeFileSync(f.pdf,'user edits'); fs.writeFileSync(sidePath,snapshot);
  await assert.rejects(f.p.readSidecar(f.item));
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'user edits'); assert.equal(fs.readFileSync(sidePath,'utf8'),snapshot);
});

test('sidecar cleanup failure after commit leaves recoverable metadata', async t=>{
  const f=fixture(); t.after(f.cleanup); const sidePath=path.join(f.dir,'.zotero-ndlocr.json');
  await f.p.writeSidecar(f.item,{text:'old index',pages:2,dpi:150},{ocrItemKey:'ATTACHED'});
  const prior=fs.readFileSync(sidePath,'utf8'); const remove=f.io.remove; let failed=false;
  f.io.remove=async(p,o)=>{if(p.startsWith(sidePath+'.tmp-')&&!failed){failed=true;throw new Error('cleanup failure');}return remove(p,o)};
  f.p.runOCR=async(env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(failed,true); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
  assert.deepEqual(JSON.parse(JSON.stringify(await f.p.readSidecar(f.item))),JSON.parse(prior));
  assert.deepEqual(JSON.parse(fs.readFileSync(sidePath,'utf8')),JSON.parse(prior));
});

test('interrupted initial replacement restores prior non-replacement sidecar', async t=>{
  const f=fixture(); t.after(f.cleanup);
  await f.p.writeSidecar(f.item,{text:'old index',pages:2,dpi:150},{ocrItemKey:'ATTACHED'});
  const sidePath=path.join(f.dir,'.zotero-ndlocr.json'), prior=fs.readFileSync(sidePath,'utf8');
  let snapshot; const move=f.io.move;
  f.io.move=async(a,b)=>{if(b===f.pdf) snapshot=fs.readFileSync(sidePath,'utf8');return move(a,b)};
  f.p.runOCR=async(env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.ok(snapshot); fs.writeFileSync(f.pdf,'original'); fs.writeFileSync(sidePath,snapshot);
  const recovered=await f.p.readSidecar(f.item);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered)),JSON.parse(prior));
  assert.deepEqual(JSON.parse(fs.readFileSync(sidePath,'utf8')),JSON.parse(prior));
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('interrupted re-OCR recovers prior sidecar and index metadata', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'original OCR');
  await f.p.writeSidecar(f.item,{text:'old indexed text',pages:3,dpi:100},{replaced:true,originalMD5:original,originalSize:8,replacedMD5:f.md5(f.pdf),backup:null,ocrItemKey:'OLD'});
  const sidePath=path.join(f.dir,'.zotero-ndlocr.json');
  const prior=fs.readFileSync(sidePath,'utf8');
  const index=path.join(f.dir,'index-cache'); fs.writeFileSync(index,'old indexed text');
  let snapshot; const move=f.io.move;
  f.io.move=async(a,b)=>{if(b===f.pdf) snapshot=fs.readFileSync(sidePath,'utf8'); return move(a,b)};
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new text',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.ok(snapshot); fs.writeFileSync(f.pdf,'original OCR'); fs.writeFileSync(sidePath,snapshot);
  const recovered=await f.p.readSidecar(f.item);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered)),JSON.parse(prior));
  assert.deepEqual(JSON.parse(fs.readFileSync(sidePath,'utf8')),JSON.parse(prior));
  assert.equal(fs.readFileSync(index,'utf8'),'old indexed text');
  await f.p.restorePDF(f.item,recovered); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('concurrent sidecar read cannot undo an in-flight replacement journal', async t=>{
  const f=fixture(); t.after(f.cleanup); const sidePath=path.join(f.dir,'.zotero-ndlocr.json');
  const move=f.io.move; let attempted=false;
  f.io.move=async(a,b)=>{if(b===f.pdf){attempted=true; try {await f.p.readSidecar(f.item)} catch (_) {} } return move(a,b)};
  f.p.runOCR=async(env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new',pages:1,incremental:false}};
  f.p.applyIndex=async()=>{throw new Error('index failure')};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.ok(attempted); assert.equal(fs.existsSync(sidePath),true);
  const side=await f.p.readSidecar(f.item); assert.equal(side.replacedMD5,f.md5(f.pdf));
  await f.p.restorePDF(f.item,side); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('a PDF move that succeeds then reports an error retains recoverable metadata', async t=>{
  const f=fixture(); t.after(f.cleanup); const move=f.io.move; let failed=false;
  f.io.move=async(a,b)=>{await move(a,b);if(b===f.pdf && !failed){failed=true;throw new Error('post-move failure');}};
  f.p.runOCR=async(env,source,cb,out)=>{fs.writeFileSync(out,'rewritten PDF');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  const side=await f.p.readSidecar(f.item); assert.ok(side?.replaced);
  assert.equal(side.replacedMD5,f.md5(f.pdf));
  await f.p.restorePDF(f.item,side); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
});

test('backup-free restore refuses an edit made during truncation', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'original OCR');
  const side={replaced:true,originalMD5:original,originalSize:8,replacedMD5:f.md5(f.pdf),backup:null};
  const write=f.io.write; f.io.write=async(p,b)=>{await write(p,b); if(p===f.pdf+'.ndlocr-tmp') fs.writeFileSync(f.pdf,'user edits');};
  await assert.rejects(f.p.restorePDF(f.item,side));
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'user edits');
});

test('forced re-OCR refuses edits made during OCR', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'original OCR');
  await f.p.writeSidecar(f.item,{text:'old',pages:1,dpi:150},{replaced:true,originalMD5:original,originalSize:8,replacedMD5:f.md5(f.pdf),backup:null});
  f.p.runOCR=async (env,source,cb,out)=>{fs.writeFileSync(f.pdf,'user edits');fs.writeFileSync(out,'new OCR');return {text:'new',pages:1,incremental:false}};
  await f.p.runBatch(null,[f.item],{force:true,label:'test'});
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'user edits');
});


test('restoreItems retries after the PDF move reports failure without losing the index', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const backup=path.join(f.root,'backup.pdf'); fs.copyFileSync(f.pdf,backup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'OCR PDF');
  await f.p.writeSidecar(f.item,{text:'indexed text',pages:1},{replaced:true,backup,originalMD5:original,replacedMD5:f.md5(f.pdf)});
  f.p.collectPDFs=items=>items; f.p.alert=()=>{}; f.p.isPDF=()=>true;
  const index=path.join(f.dir,'index'); fs.writeFileSync(index,'indexed text');
  const move=f.io.move; let failed=false;
  f.io.move=async(a,b)=>{await move(a,b); if(b===f.pdf&&!failed){failed=true; throw Error('crash after move');}};
  await f.p.restoreItems(null,[f.item]);
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
  const side=await f.p.readSidecar(f.item);
  assert.equal(side.replaced,undefined); assert.equal(side.text,'indexed text');
  assert.equal(fs.readFileSync(index,'utf8'),'indexed text');
});


test('cancelled setup does not promise an in-place retry', async t=>{
  const f=fixture(); t.after(f.cleanup);
  f.p._run=async()=>{f.p.cancelRequested=true;return {exitCode:1,output:''}};
  const result=await f.p.setup(f.root);
  assert.match(result.msg,/不完全|未完了/);
  assert.doesNotMatch(result.msg,/続きから/);
});


test('removeIndex retries after sidecar commit fails and retains the index until retry', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'original OCR');
  await f.p.writeSidecar(f.item,{text:'indexed text',pages:1},{replaced:true,backup:null,originalMD5:original,originalSize:8,replacedMD5:f.md5(f.pdf)});
  let cleared=0; f.Zotero.DB={executeTransaction:async fn=>fn()};
  f.Zotero.Fulltext={clearItemWords:async()=>{cleared++},indexItems:async()=>{}}; f.Zotero.Notifier={trigger:async()=>{}};
  const move=f.io.move; let sideMoves=0;
  f.io.move=async(a,b)=>{if(b===path.join(f.dir,'.zotero-ndlocr.json') && ++sideMoves===2) throw Error('sidecar commit failed'); return move(a,b)};
  await assert.rejects(f.p.removeIndex(f.item),/sidecar commit failed/);
  assert.equal(cleared,0); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original');
  assert.equal((await f.p.readSidecar(f.item)).text,'indexed text');
  await f.p.removeIndex(f.item); assert.equal(cleared,1);
  assert.equal(await f.p.readSidecar(f.item),null);
});

test('restore recovery refuses unexpected user edits and preserves journal and backup', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const backup=path.join(f.root,'backup.pdf'); fs.copyFileSync(f.pdf,backup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'OCR PDF');
  await f.p.writeSidecar(f.item,{text:'indexed text',pages:1},{replaced:true,backup,originalMD5:original,replacedMD5:f.md5(f.pdf)});
  const side=await f.p.readSidecar(f.item), move=f.io.move;
  f.io.move=async(a,b)=>{if(b===f.pdf){fs.writeFileSync(f.pdf,'user edits'); throw Error('interrupted');} return move(a,b)};
  await assert.rejects(f.p.restoreWithJournal(f.item,side));
  const sidePath=path.join(f.dir,'.zotero-ndlocr.json'), journal=fs.readFileSync(sidePath,'utf8');
  await assert.rejects(f.p.readSidecar(f.item),/自動復旧できません/);
  assert.equal(fs.readFileSync(sidePath,'utf8'),journal);
  assert.equal(fs.readFileSync(f.pdf,'utf8'),'user edits'); assert.equal(fs.readFileSync(backup,'utf8'),'original');
});

test('restore interruption before PDF move rolls back journal without changing PDF', async t=>{
  const f=fixture(); t.after(f.cleanup);
  const original=f.md5(f.pdf); fs.writeFileSync(f.pdf,'original OCR');
  await f.p.writeSidecar(f.item,{text:'indexed text',pages:1},{replaced:true,backup:null,originalMD5:original,originalSize:8,replacedMD5:f.md5(f.pdf)});
  const side=await f.p.readSidecar(f.item), move=f.io.move;
  f.io.move=async(a,b)=>{if(b===f.pdf) throw Error('before move'); return move(a,b)};
  await assert.rejects(f.p.restoreWithJournal(f.item,side));
  const recovered=await f.p.readSidecar(f.item);
  assert.equal(recovered.replaced,true); assert.equal(recovered.pendingRestore,undefined);
  assert.equal(recovered.text,'indexed text'); assert.equal(fs.readFileSync(f.pdf,'utf8'),'original OCR');
});
