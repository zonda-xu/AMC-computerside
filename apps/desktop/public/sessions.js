(() => {
  const el = id => document.getElementById(id);
  const dialog = el('session-library'), list = el('library-list'), thread = el('library-thread'), status = el('library-status');
  const call = input => api('session-library',input);
  let model = {items:[],workspaces:[],online:false}, selected = new Set(), current = '', signature='', timer, busy=false, reading=false;
  const make = (tag,text='') => {const node=document.createElement(tag);node.textContent=text;return node;};
  function button(parent,label,fn,disabled=false) {
    const b=make('button',label); b.type='button'; b.className='secondary'; b.disabled=disabled;
    b.onclick=async()=>{if(busy)return;busy=true;b.disabled=true;try{await fn();}catch(e){status.textContent=e.message;}
      finally{busy=false;b.disabled=disabled;signature='';await refresh().catch(e=>status.textContent=e.message);}};
    parent.append(b); return b;
  }
  const projectSelection = () => ({workspaceId:el('session-workspace').value,engine:el('library-engine').value});
  const sameProject = target => dialog.open && !el('archived-only').checked && Object.entries(target).every(([key,value])=>projectSelection()[key]===value);
  const requireProject = target => {if(!target.workspaceId)throw new Error('请先选定项目目录');};
  async function findNative(target,cursor) {
    requireProject(target);
    const rows=await call({operation:'discover',...target,cursor});
    if(!sameProject(target))return;
    const pane=el('native-history');
    if(!cursor)pane.replaceChildren();
    pane.querySelector('[data-more]')?.remove();
    for(const item of rows.items.filter(item=>!model.items.some(s=>s.id===item.registeredSessionId))) {
      button(pane,item.title,async()=>{
        const s=await call({operation:'import',candidateId:item.candidateId});
        if(!sameProject(target))return;
        current=s.id; await call({operation:'open',id:s.id,requestId:crypto.randomUUID()});await showThread(s.id);
      });
    }
    if(rows.cursor)button(pane,'更多电脑历史',()=>findNative(target,rows.cursor)).dataset.more='true';
    if(!pane.childElementCount)pane.append(make('p','本页会话均已在目录中，或平台没有其他历史'));
  }
  async function createNative(target) {
    requireProject(target);
    const key='amc-new-session:'+model.hostId+':'+target.workspaceId+':'+target.engine;
    const requestId=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,requestId);
    try{
      const row=await call({operation:'create',...target,requestId});
      sessionStorage.removeItem(key);
      if(sameProject(target)){current=row.id;await showThread(row.id);}
    }catch(e){
      const receipt=await call({operation:'receipt',requestId}).catch(()=>null);
      if(receipt?.status==='rejected')sessionStorage.removeItem(key);
      throw e;
    }
  }
  function visible() {
    const query=el('session-search').value.trim().toLowerCase(), workspace=el('session-workspace').value;
    return model.items.filter(s=>s.archived===el('archived-only').checked && (!workspace||s.ref.workspaceId===workspace) &&
      [s.title,labels[s.ref.engineId]].join(' ').toLowerCase().includes(query))
      .sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt);
  }
  function selectGroup(ids) {
    const remove=ids.every(id=>selected.has(id));
    ids.forEach(id=>remove?selected.delete(id):selected.add(id)); render();
  }
  async function edit(s,action,title) {
    return call({operation:'edit',id:s.id,change:{revision:s.revision,action,title,confirmNativeId:action==='delete'?s.ref.nativeSessionId:undefined}});
  }
  async function batch(items,action) {
    if(!items.length)return;
    if(action==='delete'&&!confirm('永久删除以下会话的原始对话和关联记录？\n'+items.map(s=>s.title).join('\n')))return;
    const errors=[];selected.clear();
    for(const s of items) {
      try{await edit(s,action); if(s.id===current){current='';thread.replaceChildren();}}
      catch(e){selected.add(s.id);errors.push(s.title+' · '+e.message);}
    }
    status.textContent=errors.join('\n') || (action==='delete'?'已删除':'已恢复');
  }
  function render() {
    const rows=visible(); list.replaceChildren();
    if(!rows.length)list.append(make('p','没有符合条件的会话'));
    const archived=el('archived-only').checked;
    for(const name of ['new-project-session','find-project-session'])el(name).disabled=archived||!model.online||!el('session-workspace').value;
    if(archived)el('native-history').replaceChildren();
    el('select-visible').hidden=el('restore-selected').hidden=el('delete-selected').hidden=!archived;
    el('restore-selected').disabled=!rows.some(s=>selected.has(s.id))||rows.some(s=>selected.has(s.id)&&s.deletionPending);
    el('delete-selected').disabled=!model.online||!rows.some(s=>selected.has(s.id));
    for(const w of model.workspaces){
      const group=rows.filter(s=>s.ref.workspaceId===w.id);if(!group.length)continue;
      const header=make('h3',w.name);list.append(header);
      if(archived)button(header,'选择本项目',()=>selectGroup(group.map(s=>s.id)));
      for(const s of group){
        const row=make('div');row.className='library-row';
        if(archived){const check=make('input');check.type='checkbox';check.checked=selected.has(s.id);check.setAttribute('aria-label','选择 '+s.title);check.onchange=()=>selectGroup([s.id]);row.append(check);}
        button(row,(s.pinned?'★ ':'')+s.title,async()=>{current=s.id;thread.replaceChildren();if(model.online&&!s.archived)await call({operation:'open',id:s.id,requestId:crypto.randomUUID()});await showThread(s.id);});
        row.append(make('small',labels[s.ref.engineId]+(s.deletionPending?' · 删除待重试':'')));
        if(archived){
          button(row,'恢复',()=>batch([s],'restore'),s.deletionPending);
          button(row,'删除',()=>batch([s],'delete'),!model.online);
        }else{
          button(row,s.pinned?'取消置顶':'置顶',()=>edit(s,s.pinned?'unpin':'pin'),!model.online);
          button(row,'改名',async()=>{const title=prompt('会话名称',s.title)?.trim();if(title)await edit(s,'rename',title);},!model.online);
          button(row,'归档',()=>edit(s,'archive'),!model.online);
        }
        list.append(row);
      }
    }
  }
  async function showThread(id) {
    const s=await call({operation:'read',id});if(current!==id||!dialog.open)return;
    if(thread.dataset.id!==id || !thread.querySelector('textarea')){
      thread.replaceChildren(make('h3'),make('article'),make('div'),make('textarea'),make('footer'));
      thread.dataset.id=id; thread.querySelector('textarea').setAttribute('aria-label','在本会话加单');
    }
    const key='amc-conversation:'+s.ref.hostId+':'+id, field=thread.querySelector('textarea');
    const saved=sessionStorage.getItem(key)||'';if(field.value!==saved)field.value=saved;
    field.oninput=()=>sessionStorage.setItem(key,field.value);
    thread.querySelector('h3').textContent=s.title;
    const history=thread.querySelector('article'), body=s.messages.map(m=>(m.role==='user'?'顾客':'店员')+'\n'+m.text).join('\n\n');
    if(history.textContent!==body)history.textContent=body;
    const actions=thread.querySelector('div'), foot=thread.querySelector('footer');actions.replaceChildren();foot.replaceChildren();
    if(s.archived||!model.online||s.binding?.state!=='attached'){field.disabled=true;return;}
    const generation=s.binding.generation;
    const command=(action,payload,requestId=crypto.randomUUID())=>call({operation:'command',id,action,generation,requestId,payload:{...payload,expectedGeneration:generation}});
    for(const i of s.interactions.filter(i=>i.status==='pending'&&i.kind==='permission')){
      actions.append(make('pre',i.title+'\n'+i.detail));
      for(const choice of i.choices)button(actions,choice.label,()=>command('decide',{interactionId:i.id,epoch:i.epoch,runId:i.runId,choiceId:choice.id}));
    }
    const pendingKey=key+':pending', pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');
    field.disabled=!!pending;
    button(foot,pending?'核对送达状态':'在原会话加单',async()=>{
      let order=pending;
      if(order){
        const receipt=await call({operation:'receipt',id,requestId:order.id});
        if(receipt){
          if(receipt.status==='native_accepted'){sessionStorage.removeItem(pendingKey);sessionStorage.removeItem(key);field.value='';}
          if(receipt.status==='rejected')sessionStorage.removeItem(pendingKey);
          status.textContent=receipt.detail||receipt.status;return;
        }
        if(order.generation!==generation)throw new Error('原连接代次已改变，请核对会话');
        if(!confirm('主机未收到这份任务单。使用原请求和原消息重试？'))return;
      }else{
        if(!field.value.trim())return;
        order={id:crypto.randomUUID(),generation,text:field.value};sessionStorage.setItem(pendingKey,JSON.stringify(order));
      }
      const receipt=await command('submit',{text:order.text,attachmentIds:[]},order.id);
      status.textContent=receipt.status==='received'?'消息已送达主机':receipt.detail||receipt.status;
    },!pending&&(!s.binding.capabilities.submit||!['completed','cancelled','failed','idle'].includes(s.state)));
    if(s.runId&&s.binding.capabilities.cancel&&['accepted','running','waiting_permission','waiting_input'].includes(s.state))button(foot,'停止本轮',()=>command('cancel',{runId:s.runId}));
  }
  async function refresh() {
    if(!dialog.open||reading)return;reading=true;
    try{
      model=await call({operation:'list'}); if(!dialog.open)return;
      const select=el('session-workspace'), projects=JSON.stringify(model.workspaces);
      if(select.dataset.items!==projects){const value=select.value;select.replaceChildren(new Option('所有项目',''),...model.workspaces.map(w=>new Option(w.name,w.id)));select.value=value;select.dataset.items=projects;}
      const next=JSON.stringify([model.items,model.online]);if(next!==signature){signature=next;render();}
      if(current&&model.items.some(s=>s.id===current))await showThread(current);else if(current){current='';thread.replaceChildren();}
    }finally{reading=false;}
  }
  for(const id of ['session-search','session-workspace','archived-only'])el(id).addEventListener('input',()=>{selected.clear();render();});
  el('select-visible').onclick=()=>selectGroup(visible().map(s=>s.id));
  for(const [id,action] of [['restore-selected','restore'],['delete-selected','delete']])el(id).onclick=async()=>{
    if(busy)return;busy=true;try{await batch(visible().filter(s=>selected.has(s.id)),action);}finally{busy=false;signature='';await refresh().catch(e=>status.textContent=e.message);}
  };
  for(const [id,fn] of [['new-project-session',createNative],['find-project-session',findNative]])el(id).onclick=async()=>{
    if(busy)return;busy=true;try{await fn(projectSelection());}catch(e){status.textContent=e.message;}
    finally{busy=false;signature='';await refresh().catch(e=>status.textContent=e.message);}
  };
  for(const id of ['library-engine','session-workspace'])el(id).addEventListener('input',()=>el('native-history').replaceChildren());
  el('save-cage-browser').onclick=async()=>{try{await call({operation:'browser-config',path:el('cage-launch-file').value.trim()});status.textContent='已保存 Cage 浏览器入口';}catch(e){status.textContent=e.message;}};
  el('register-project').onclick=async()=>{try{await call({operation:'register',name:el('library-project-name').value,path:el('library-project-path').value});await refresh();}catch(e){status.textContent=e.message;}};
  el('manage-sessions').onclick=()=>{dialog.showModal();signature='';void refresh().catch(e=>status.textContent=e.message);timer=setInterval(()=>{if(!busy)void refresh().catch(e=>status.textContent=e.message);},4000);};
  dialog.addEventListener('close',()=>{clearInterval(timer);selected.clear();current='';thread.replaceChildren();});
})();
