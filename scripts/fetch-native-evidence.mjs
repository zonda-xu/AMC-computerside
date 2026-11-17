import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve('output/native-evidence');
await mkdir(root, { recursive: true });
const provenanceUrl = 'https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@0.167.0-alpha.4.1';
const provenanceResponse = await fetch(provenanceUrl);
if (!provenanceResponse.ok) throw new Error('Codex provenance unavailable');
const provenance = await provenanceResponse.json();
const attestation = provenance.attestations.find(item => item.predicateType === 'https://slsa.dev/provenance/v1');
if (!attestation) throw new Error('Codex source provenance missing');
const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
const commit = statement.predicate.buildDefinition.resolvedDependencies.find(item => item.uri.startsWith('git+https://github.com/openai/codex@'))?.digest.gitCommit;
if (commit !== 'd2c035639366e0bf2c316aa2065c24aabc12bcdc') throw new Error('Codex release source mismatch');
await writeFile(join(root, 'codex-alpha4.1-provenance.json'), JSON.stringify(statement, null, 2));
for (const [name, repo, revision, pattern] of [
  ['codex-alpha4.1', 'openai/codex', 'd2c035639366e0bf2c316aa2065c24aabc12bcdc', /app-server-protocol\/schema\/json\/v2\/Thread(List|Read|TurnsList)(Params|Response)\.json$/],
  ['dsh-rc5', 'deepseek-ai/deepseek-harness', 'b830ec950faba0a46dda564be3e2d854afed94f1', /packages\/api\/session-controller\/(package.json|src\/(index|types|history|list)\.ts)$/]
]) {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/${revision}?recursive=1`);
  if (!response.ok) throw new Error(`${repo}: ${response.status}`);
  const tree = await response.json();
  if (tree.truncated) throw new Error('Truncated source tree');
  const paths = tree.tree.filter(item => item.type === 'blob' && pattern.test(item.path)).map(item => item.path);
  await writeFile(join(root, `${name}-paths.json`), JSON.stringify(paths, null, 2));
  for (const path of paths) {
    const source = await fetch(`https://raw.githubusercontent.com/${repo}/${revision}/${path}`);
    if (!source.ok) throw new Error(`${path}: ${source.status}`);
    const target = join(root, name, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, await source.text());
  }
  console.log(name, revision, paths);
}
const metadata = await (await fetch('https://registry.npmjs.org/@deepseek-ai/dsh-api-session-controller/0.2.1-rc.5')).json();
const archive = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
if (integrity !== 'sha512-9kcolv2E00fuMMXWDbMn4K2JRMdAf8Ql5wME1CaGxgManvLjPM2Ymc46o2TJnwH4kO2gUtVKUrP9hcreHd148g==') throw new Error('DSH package integrity mismatch');
const archivePath = join(root, 'dsh-controller-rc5.tgz');
await writeFile(archivePath, archive);
const entry = execFileSync('tar', ['-xOf', archivePath, 'package/lib/index.js'], { maxBuffer: 4 * 1024 * 1024 });
await writeFile(join(root, 'dsh-controller-index.js'), entry);
console.log('DSH controller entry SHA256', createHash('sha256').update(entry).digest('hex'));
const fixtures = resolve('tests/contracts/codex-generated/alpha4.1');
await mkdir(fixtures, { recursive: true });
const evidence = { package: '@openai/codex', version: '0.167.0-alpha.4.1', gitCommit: commit, provenanceUrl, schemas: {} };
for (const method of ['ThreadList', 'ThreadRead', 'ThreadTurnsList']) {
  for (const suffix of ['Params', 'Response']) {
    const path = `codex-rs/app-server-protocol/schema/json/v2/${method}${suffix}.json`;
    const response = await fetch(`https://raw.githubusercontent.com/openai/codex/d2c035639366e0bf2c316aa2065c24aabc12bcdc/${path}`);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    const text = await response.text();
    await writeFile(join(fixtures, `${method}${suffix}.json`), text);
    evidence.schemas[`${method}${suffix}.json`] = createHash('sha256').update(text).digest('hex');
  }
}
await writeFile(join(fixtures, 'source.json'), JSON.stringify(evidence, null, 2) + '\n');
