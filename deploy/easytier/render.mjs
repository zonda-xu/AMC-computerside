import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
export function validate(p){
  if(p.schemaVersion!==2||p.networkName!=='agent-console-mesh'||p.peerListenPort!==12080||p.networkCIDR!=='10.89.90.0/24'||p.gatewayLocalPort!==8899||!p.networkSecretRef?.startsWith('secret:'))throw new Error('Profile differs from isolated v1.6 network');
  const mapping=new Map([['10.89.90.3',18541],['10.89.90.4',18542],['10.89.90.2',18543]]);
  if(p.hosts?.length!==3||new Set(p.hosts.map(h=>h.hostId)).size!==3||new Set(p.hosts.map(h=>h.overlayIPv4)).size!==3||new Set(p.hosts.map(h=>h.publicPort)).size!==3)throw new Error('Host identities and IPs/ports must be unique');
  for(const h of p.hosts)if(mapping.get(h.overlayIPv4)!==h.publicPort)throw new Error('Unexpected per-host TCP mapping');
}
export function toml(p,secret){validate(p);if(!/^[A-Za-z0-9_-]{43,}$/.test(secret))throw new Error('Use a fresh >=256-bit base64url secret');return `instance_name = "agent-console-easytier-relay"\nlisteners = ["tcp://0.0.0.0:12080"]\n\n[network_identity]\nnetwork_name = "agent-console-mesh"\nnetwork_secret = "${secret}"\n\n[flags]\nno_tun = true\nprivate_mode = true\n\n`+p.hosts.map(h=>`[[port_forward]]\nbind_addr = "0.0.0.0:${h.publicPort}"\ndst_addr = "${h.overlayIPv4}:8899"\nproto = "tcp"\n`).join('\n');}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const p=JSON.parse(await readFile(process.argv[2]||'deploy/easytier/profile.example.json','utf8'));
  const out=resolve(process.argv[3]||'data/easytier');await mkdir(out,{recursive:true,mode:0o700});
  await writeFile(join(out,'relay.toml'),toml(p,process.env.ET_NETWORK_SECRET||''),{mode:0o600,flag:'wx'});
  console.log(`Rendered ${out}/relay.toml. No Docker deployment or route changes were performed.`);
}
