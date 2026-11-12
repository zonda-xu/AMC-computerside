import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){
  let m;
  try{
    m=JSON.parse(line);if(m.id===undefined)continue;
    if(m.method==='initialize')reply(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'amc_permissions',version:'0.1.0'}});
    else if(m.method==='tools/list')reply(m.id,{tools:[{name:'approve',description:'Ask the authenticated console user for this native Claude permission or question.',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object',additionalProperties:true}},required:['tool_name','input']}}]});
    else if(m.method==='tools/call'){
      const endpoint=new URL(process.env.AMC_APPROVAL_URL);if(endpoint.hostname!=='127.0.0.1')throw new Error('Permission server must be loopback');
      const token=(await readFile(process.env.AMC_APPROVAL_TOKEN_FILE,'utf8')).trim();
      const r=await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(m.params.arguments)});
      if(!r.ok)throw new Error('Permission server rejected the call');reply(m.id,{content:[{type:'text',text:JSON.stringify(await r.json())}]});
    }else if(m.method==='ping')reply(m.id,{});
    else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported MCP method'}})+'\n');
  }catch{if(m?.id!==undefined)reply(m.id,{isError:true,content:[{type:'text',text:'Permission response unavailable; no permission granted'}]});}
}
