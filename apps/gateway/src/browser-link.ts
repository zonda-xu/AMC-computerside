import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { requireValue } from '../../../packages/protocol/src/validation.ts';

function publicIp(ip: string): boolean {
  if (isIP(ip) === 6) return /^[23][\da-f]{3}:/i.test(ip) && !/^2001:(?:db8|0):/i.test(ip);
  const [a,b] = ip.split('.').map(Number);
  return isIP(ip)===4 && a>0 && a<224 && a!==10 && a!==127 && !(a===100 && b>=64 && b<128)
    && !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) && !(a===192 && (b===168 || b===0)) && !(a===198 && [18,19].includes(b));
}
export async function validatePublicLink(raw: string) {
  requireValue(raw.length<=4096 && !/[\x00-\x1f]/.test(raw),'invalid_url','链接格式无效');
  const url=new URL(raw);
  requireValue(['https:','http:'].includes(url.protocol) && !url.username && !url.password,'invalid_url','请选择公网 HTTP 或 HTTPS 链接');
  const addresses=await lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true});
  requireValue(addresses.length>0 && addresses.every(a=>publicIp(a.address)), 'private_url','请选择公网地址',400);
  return url.href;
}

// The official cage-mobile-link client creates a one-use private HTML entry.
// Its bootstrap token, room identity and session cookie never cross the phone link.
export class CageBrowser {
  private auth?: {stamp:string; origin:string; cookie:string};
  private queue: Promise<unknown> = Promise.resolve();
  open(launchFile: string | undefined, url: string) {
    const result=this.queue.catch(()=>{}).then(()=>this.openInCage(launchFile,url));
    this.queue=result;
    return result;
  }
  private async openInCage(file: string | undefined, url: string) {
    requireValue(file && isAbsolute(file),'cage_unconfigured','请先在电脑工作台选择已配对 Cage 客户端生成的本机 HTML 入口',409);
    const fd=await open(file,'r');
    let entry:string;
    try {
      const info=await fd.stat(); requireValue(info.isFile() && info.size<=16384,'cage_entry','Cage 入口文件无效',409);
      const bytes=Buffer.alloc(16385);const {bytesRead}=await fd.read(bytes,0,bytes.length,0);
      requireValue(bytesRead===info.size,'cage_entry','Cage 入口已更换，请重试',409);
      entry=bytes.toString('utf8',0,bytesRead);
    } finally {await fd.close();}
    const match=entry.match(/http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/link-bootstrap#([a-zA-Z0-9_-]{16,200})/);
    requireValue(match,'cage_entry','请选择 Cage 客户端生成的本机 HTML 入口',409);
    const origin='http://'+match[1]+':'+match[2];
    const stamp=createHash('sha256').update(match[0]).digest('hex');
    if(this.auth?.stamp!==stamp) {
      const r=await fetch(origin+'/link-session',{method:'POST',redirect:'error',headers:{Origin:origin,'Content-Type':'application/json'},
        body:JSON.stringify({token:match[3]}),signal:AbortSignal.timeout(8000)});
      const cookie=(r.headers.get('set-cookie')||'').split(';')[0];
      requireValue(r.status===204 && cookie.startsWith('cage_mobile_link_'+match[2]+'=') && /^[\w=-]+$/.test(cookie),
        'cage_pairing','Cage 入口已经使用或过期，请由已配对客户端生成新的入口文件',409);
      this.auth={stamp,origin,cookie};
    }
    const id=randomUUID();
    const res=await fetch(origin+'/api/mobile/browser/open',{method:'POST',redirect:'error',
      headers:{Origin:origin,Cookie:this.auth.cookie,'Content-Type':'application/json'},body:JSON.stringify({id,width:900,height:760,url}),signal:AbortSignal.timeout(35000)});
    if(res.status===401 || res.status===403)this.auth=undefined;
    requireValue(res.ok,'cage_open','Cage 远程浏览器拒绝打开链接（HTTP '+res.status+'），请检查配对与主机环境',409);
    const data=await res.json() as { id?:string };
    requireValue(data.id===id,'cage_open','Cage 未确认这次打开请求',409);
    return { opened:true, browser:'Cage' };
  }
}
