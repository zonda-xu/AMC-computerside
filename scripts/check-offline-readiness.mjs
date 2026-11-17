import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.325', integrity: 'sha512-MhSm2Fhk3DA/hhjdCKXDZWlnykpPWJjX42SogllAHMplY9ZKT+Ltb8QPtQxpe225Imfs4A8IKaNE4biivA+fHg==' },
  { name: '@opencode/client', version: '2.3.0', integrity: 'sha512-xu74XGiYIqLZ2FzIrtjaR5UNWWXY3fRln0WLgZoQTR/wWMgG+T9XGQQGCl8ry8jnCFsJVokiHemBqft9oMzC1A==' },
  { name: '@opencode/cli', version: '2.3.0', integrity: 'sha512-Q5RV8jLJ4O8bY2O8X2hkBOkgPf6+nDB9MEkz/Q/Cc4Ojd2SwUFFzEd1LzgNGKiXiS7g/9+/X4eqhrxY60fLMOQ==' }
];
const sdkPeers = { '@anthropic-ai/sdk': '>=0.93.0', '@modelcontextprotocol/sdk': '^1.29.0', zod: '^4.0.0' };
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

async function readManifest(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { status: 'ready', value }
      : { status: 'invalid', value: {} };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'invalid', value: {} };
  }
}

function satisfies(version, range) {
  if (range === '*' || range === '') return typeof version === 'string';
  if (typeof version !== 'string' || !exactVersion.test(version) || typeof range !== 'string') return false;
  const parts = version.split('.').map(Number);
  return range.split('||').some(alternative => {
    const terms = alternative.trim().split(/\s+/);
    return terms.every(term => {
      const partial = /^(\^|~)?(\d+)(?:\.(\d+|x|\*))?(?:\.(x|\*))?$/i.exec(term);
      if (partial) return parts[0] === Number(partial[2]) && (partial[3] === undefined || /^(?:x|\*)$/i.test(partial[3]) || parts[1] === Number(partial[3]));
      const match = /^(>=|<=|>|<|\^|~|=)?(\d+)\.(\d+)\.(\d+)$/.exec(term);
      if (!match) return false;
      const base = match.slice(2).map(Number);
      const delta = parts[0] - base[0] || parts[1] - base[1] || parts[2] - base[2];
      switch (match[1]) {
        case '>=': return delta >= 0;
        case '<=': return delta <= 0;
        case '>': return delta > 0;
        case '<': return delta < 0;
        case '^': return delta >= 0 && (base[0] > 0 ? parts[0] === base[0] : base[1] > 0 ? parts[0] === 0 && parts[1] === base[1] : parts[0] === 0 && parts[1] === 0 && parts[2] === base[2]);
        case '~': return delta >= 0 && parts[0] === base[0] && parts[1] === base[1];
        default: return delta === 0;
      }
    });
  });
}

export async function inspectDependencyClosure(root = defaultRoot, options = {}) {
  root = resolve(root);
  const manifest = await readManifest(join(root, 'package.json'));
  const lock = await readManifest(join(root, 'package-lock.json'));
  const validPackages = lock.value.packages !== null && typeof lock.value.packages === 'object' && !Array.isArray(lock.value.packages);
  const entries = validPackages ? lock.value.packages : {};
  const checks = [], inventory = [], skipped = [], visited = new Set();
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const compatible = pkg => ['os', 'cpu'].every(field => {
    const values = pkg[field], current = field === 'os' ? platform : arch;
    return !Array.isArray(values) || (!values.includes(`!${current}`) && (values.every(value => value.startsWith('!')) || values.includes(current) || values.includes('any')));
  });
  const fail = (id, actual) => checks.push({ id, status: 'blocked', actual });
  if (manifest.status !== 'ready' && !options.additionalRoots) fail('closure.manifest', manifest.status);
  if (lock.status !== 'ready' || !validPackages) fail('closure.lockfile', lock.status === 'ready' ? 'invalid packages map' : lock.status);
  async function visit(name, parent = '', optional = false, range = '*', optionalPeer = false) {
    if (!packageName.test(name)) { fail('closure.name', name); return; }
    const candidates = [];
    let cursor = parent;
    while (cursor) {
      if (!cursor.endsWith('node_modules')) candidates.push(`${cursor}/node_modules/${name}`);
      const next = dirname(cursor).replaceAll('\\', '/');
      cursor = next === '.' ? '' : next;
    }
    candidates.push(`node_modules/${name}`);
    let key, installed;
    for (const candidate of candidates) {
      const value = await readManifest(join(root, candidate, 'package.json'));
      if (value.status !== 'missing') { key = candidate; installed = value; break; }
    }
    if (!key) {
      const lockedKey = candidates.find(candidate => entries[candidate]);
      if (optional && ((lockedKey && !compatible(entries[lockedKey])) || optionalPeer)) { skipped.push({ name, parent, reason: lockedKey ? 'other-platform' : 'optional-peer-absent' }); return; }
      fail(`closure.${parent || 'root'}.${name}`, 'missing installed dependency'); return;
    }
    const entry = entries[key];
    if (optional && entry && !compatible(entry)) { skipped.push({ name, parent, reason: 'other-platform' }); return; }
    if (!compatible(installed.value)) { fail(`closure.${key}.platform`, `${platform}/${arch}`); return; }
    if (installed.status !== 'ready' || installed.value.name !== name || !entry || entry.link || installed.value.version !== entry.version || typeof entry.integrity !== 'string' || !/^sha(?:512|256|1)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
      fail(`closure.${key}.lock`, 'installed name/version and real lock integrity required'); return;
    }
    if ((await lstat(join(root, key))).isSymbolicLink()) { fail(`closure.${key}.link`, 'symbolic links are not distributable'); return; }
    if (!satisfies(installed.value.version, range)) fail(`closure.${key}.range`, `expected ${range}, installed ${installed.value.version}`);
    if (visited.has(key)) return;
    visited.add(key);
    inventory.push({ path: key, name, version: installed.value.version, integrity: entry.integrity });
    for (const pkg of [entry, installed.value]) {
      for (const [child, range] of Object.entries(pkg.dependencies ?? {})) if (!(child in (pkg.optionalDependencies ?? {}))) await visit(child, key, false, range);
      for (const [child, range] of Object.entries(pkg.optionalDependencies ?? {})) await visit(child, key, true, range);
      for (const [child, range] of Object.entries(pkg.peerDependencies ?? {})) await visit(child, key, pkg.peerDependenciesMeta?.[child]?.optional === true, range, pkg.peerDependenciesMeta?.[child]?.optional === true);
    }
  }
  for (const name of new Set([...Object.keys(manifest.value.dependencies ?? {}), ...(options.additionalRoots ?? [])])) await visit(name, '', false, manifest.value.dependencies?.[name] ?? '*');
  inventory.sort((a, b) => a.path.localeCompare(b.path));
  return { ready: checks.length === 0, platform, arch, checks, inventory, skipped };
}

export async function inspectOfflineReadiness(root = defaultRoot, options = {}) {
  root = resolve(root);
  const checks = [];
  const add = (id, status, expected, actual = null) => checks.push({ id, status, expected, actual });
  const compare = (id, actual, expected) => add(id, actual === undefined || actual === null ? 'missing' : actual === expected ? 'ready' : 'mismatch', expected, actual);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  add('node.version', satisfies(nodeVersion, '>=24.13.0 <25.0.0') ? 'ready' : 'mismatch', '>=24.13.0 <25', nodeVersion);
  const lock = await readManifest(join(root, 'package-lock.json'));
  add('lockfile', lock.status, 'readable root package-lock.json');
  const packages = lock.value.packages;
  const validPackages = packages !== null && typeof packages === 'object' && !Array.isArray(packages);
  if (lock.status === 'ready') add('lockfile.packages', validPackages ? 'ready' : 'invalid', 'npm packages map');
  const entries = validPackages ? packages : {};
  for (const target of targets) {
    const key = `node_modules/${target.name}`;
    const entry = entries[key];
    compare(`${target.name}.lock.version`, entry?.version, target.version);
    compare(`${target.name}.lock.integrity`, entry?.integrity, target.integrity);
    const installed = await readManifest(join(root, key, 'package.json'));
    add(`${target.name}.manifest`, installed.status, 'readable installed package.json');
    compare(`${target.name}.installed.name`, installed.status === 'ready' ? installed.value.name : undefined, target.name);
    compare(`${target.name}.installed.version`, installed.status === 'ready' ? installed.value.version : undefined, target.version);
    const peers = new Map();
    if (target.name === '@anthropic-ai/claude-agent-sdk') {
      for (const [name, range] of Object.entries(sdkPeers)) peers.set(name, [range]);
    }
    for (const manifest of [entry, installed.value]) {
      for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
        peers.set(name, [...(peers.get(name) ?? []), range]);
      }
    }
    for (const [name, ranges] of peers) {
      const id = `${target.name}.peer.${name}`;
      if (!packageName.test(name)) {
        add(`${id}.name`, 'invalid', 'valid npm package name');
        continue;
      }
      const scope = target.name.startsWith('@') ? target.name.split('/')[0] : undefined;
      const candidates = [`${key}/node_modules/${name}`, ...(scope ? [`node_modules/${scope}/node_modules/${name}`] : []), `node_modules/${name}`];
      let peerKey = candidates[candidates.length - 1];
      let peerInstalled;
      for (const candidate of candidates) {
        const manifest = await readManifest(join(root, candidate, 'package.json'));
        if (manifest.status !== 'missing' || candidate === candidates[candidates.length - 1]) {
          peerKey = candidate;
          peerInstalled = manifest;
          break;
        }
      }
      const peerEntry = entries[peerKey];
      const version = peerEntry?.version;
      add(`${id}.lock.version`, version === undefined ? 'missing' : typeof version === 'string' && exactVersion.test(version) && ranges.every(range => satisfies(version, range)) ? 'ready' : 'mismatch', `exact version satisfying ${ranges.join(' and ')} (unsupported ranges block)`, version ?? null);
      const integrity = peerEntry?.integrity;
      add(`${id}.lock.integrity`, integrity === undefined ? 'missing' : typeof integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ? 'ready' : 'mismatch', 'locked SHA-512 integrity (no plan digest for peer)', integrity ?? null);
      add(`${id}.manifest`, peerInstalled.status, 'readable resolved installed package.json');
      compare(`${id}.installed.name`, peerInstalled.status === 'ready' ? peerInstalled.value.name : undefined, name);
      compare(`${id}.installed.version`, peerInstalled.status === 'ready' ? peerInstalled.value.version : undefined, typeof version === 'string' && exactVersion.test(version) ? version : 'exact lock version required');
    }
  }
  const closure = await inspectDependencyClosure(root, { ...options, additionalRoots: targets.map(target => target.name) });
  checks.push(...closure.checks);
  return {
    ready: checks.every(check => check.status === 'ready'),
    provenance: 'dependency-readiness: local Node, lock metadata and installed manifests; plan section 12.1 SHA-512 comparison only',
    nativeVerified: false,
    limitations: 'No archive or installed-file hashing, dependency code loading, native execution, service, network, installation or credential checks. Closure compares installed manifests with lock metadata, not package bytes. Unsupported target peer ranges block readiness.',
    closure,
    checks
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) {
    console.error('Usage: node scripts/check-offline-readiness.mjs [--json]');
    process.exitCode = 2;
  } else {
    const report = await inspectOfflineReadiness();
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : [
      `Offline dependency readiness: ${report.ready ? 'ready' : 'blocked'}`,
      report.provenance,
      'Native verified: false',
      ...report.checks.map(check => `${check.status}: ${check.id}`)
    ].join('\n'));
    process.exitCode = report.ready ? 0 : 1;
  }
}
