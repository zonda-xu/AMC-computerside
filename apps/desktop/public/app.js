const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('amc-token') || '';
if (token) sessionStorage.setItem('amc-token', token);
history.replaceState(null, '', '/');
let state, step = 0, reached = 0, environment, ticket, qrData, folder, network;
let busy = false, offline = false, deviceSignature = '';
const labels = { codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', 'deepseek-harness': 'DeepSeek Harness' };
const commandDefaults = { codex: 'codex', 'claude-code': 'claude', opencode: 'opencode', 'deepseek-harness': 'dsh' };
const docs = { codex: 'https://developers.openai.com/codex/cli/', 'claude-code': 'https://code.claude.com/docs/en/setup', opencode: 'https://opencode.ai/docs/', 'deepseek-harness': '' };
const probeResults = new Map();
const nextLabels = ['继续，选择连接方式 →', '继续，接入 AI 终端 →', '保存配置，进入配对 →', '查看已配对设备 →', '返回配对页面'];
function notice(message = '', info = false) { $('#notice').textContent = message; $('#notice').classList.toggle('info', info); $('#notice').hidden = !message; }
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(path === 'save' ? 120000 : 25000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作没有完成，请重试。');
  return result;
}
async function action(button, task, loading = '处理中…') {
  if (busy) return;
  busy = true; const text = button?.textContent; if (button) { button.disabled = true; button.textContent = loading; }
  notice();
  try { await task(); } catch (error) { notice(error.message === 'Failed to fetch' ? '助手连接已断开，请重新运行电脑端启动入口。' : error.message); }
  finally { busy = false; if (button) { button.disabled = false; button.textContent = text; } updateNavigation(); }
}
function showStep(index) {
  step = index; reached = Math.max(reached, step);
  $$('[data-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.panel) !== step; });
  $$('[data-step]').forEach(button => { if (Number(button.dataset.step) === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
  if (step !== 3) clearPair();
  updateNavigation(); $(`#title-${step}`).focus();
}
function updateNavigation() {
  $('#back').hidden = step === 0; $('#back').disabled = busy;
  $('#next').textContent = nextLabels[step];
  $('#next').disabled = busy || (step === 0 && !environment?.openssl);
  $('#step-count').textContent = `第 ${step + 1} 步，共 5 步`;
  $$('[data-step]').forEach(button => { button.disabled = busy || Number(button.dataset.step) > reached; });
}
function currentMode() { return $('input[name=mode]:checked').value; }
function updateAddresses() {
  const previous = $('#address').value;
  const list = environment?.addresses || state.addresses;
  $('#address').replaceChildren();
  const values = currentMode() === 'relay' ? [{ name: 'EasyTier', address: state.system.address }] : list;
  if (!values.length) { const option = new Option('未找到私有 IPv4 地址，请重新检测', ''); $('#address').add(option); }
  values.forEach(item => $('#address').add(new Option(`${item.address} · ${item.name}`, item.address)));
  if (values.some(item => item.address === previous)) $('#address').value = previous;
  $('#address-help').textContent = currentMode() === 'relay' ? `需要本机已实际取得 ${state.system.address}；保存时会再次检查。` : '选择手机能够访问的网卡；一般选择 Wi-Fi 或以太网，避开虚拟机网卡。';
  $('#lan-help').hidden = currentMode() !== 'lan'; $('#relay-help').hidden = currentMode() !== 'relay';
}
async function checkEnvironment() {
  environment = await api('check', {});
  $('#node-check').textContent = `已就绪 · ${environment.node}`; $('#node-icon').textContent = '✓'; $('#node-icon').className = 'check-icon pass';
  $('#ssl-check').textContent = environment.openssl ? '已找到 OpenSSL，可创建本机的独立证书。' : '未找到 OpenSSL，请展开下方安装指引。';
  $('#ssl-icon').textContent = environment.openssl ? '✓' : '!'; $('#ssl-icon').className = 'check-icon ' + (environment.openssl ? 'pass' : 'fail');
  $('#net-check').textContent = environment.addresses.length ? `${environment.addresses.length} 个可用地址 · ${environment.addresses.map(a => a.address).join(' / ')}` : '尚未发现私有 IPv4 地址，请连接 Wi-Fi 或以太网。';
  $('#net-icon').textContent = environment.addresses.length ? '✓' : '!'; $('#net-icon').className = 'check-icon ' + (environment.addresses.length ? 'pass' : 'fail');
  if (!environment.openssl) $('#install-help').open = true;
  updateAddresses(); updateNavigation();
}
function buildRuntimes() {
  for (const [id, name] of Object.entries(labels)) {
    const config = state.config?.runtimes[id];
    const row = document.createElement('div'); row.className = 'runtime'; row.dataset.engine = id;
    row.innerHTML = `<div class="runtime-heading"><label><input type="checkbox" id="enable-${id}"><span></span></label></div><div class="runtime-body"><label for="command-${id}">程序名或可执行文件的完整路径（不含参数）</label><div class="input-action"><input id="command-${id}" autocomplete="off" spellcheck="false"><button class="secondary">检测版本</button></div><p class="runtime-status" aria-live="polite">尚未检测</p></div>`;
    row.querySelector('label span').textContent = name;
    const enabled = row.querySelector('input[type=checkbox]'); enabled.checked = config ? config.enabled !== false && config.expectedVersion !== 'DISABLED' : id === 'codex';
    const input = row.querySelector('input:not([type=checkbox])'); input.value = config?.command || commandDefaults[id];
    if (docs[id]) { const link = document.createElement('a'); link.href = docs[id]; link.textContent = '安装与登录说明'; link.target = '_blank'; link.rel = 'noreferrer'; row.querySelector('.runtime-heading').append(link); }
    row.querySelector('button').addEventListener('click', event => void action(event.currentTarget, () => probe(id), '检测中…'));
    const update = () => { row.querySelector('.runtime-body').hidden = !enabled.checked; updateDsh(); };
    enabled.addEventListener('change', update);
    input.addEventListener('input', () => { probeResults.delete(id); row.querySelector('.runtime-status').textContent = '路径已修改，请重新检测。'; row.querySelector('.runtime-status').className = 'runtime-status'; });
    row.querySelector('.runtime-body').hidden = !enabled.checked; $('#runtimes').append(row);
  }
  updateDsh();
}
function updateDsh() {
  $('#dsh-help').hidden = !$('#enable-deepseek-harness')?.checked;
  const separator = state.platform === 'win32' ? '\\' : '/';
  $('#dsh-config').textContent = JSON.stringify({ gatewayUrl: 'ws://127.0.0.1:8898', tokenFile: state.root + separator + 'dsh-bridge.secret', hostVersion: probeResults.get('deepseek-harness')?.version || state.config?.runtimes['deepseek-harness']?.expectedVersion || '替换为完整的 DSH 版本输出' }, null, 2);
}
async function probe(id) {
  const row = $(`[data-engine="${id}"]`), output = row.querySelector('.runtime-status');
  output.textContent = '正在读取 --version 输出…';
  const result = await api('probe', { engine: id, command: $(`#command-${id}`).value.trim() }); probeResults.set(id, result);
  output.textContent = result.installed ? `已检测到 ${result.version} · 登录与真实任务待验证` : result.detail;
  output.className = 'runtime-status ' + (result.installed ? 'pass' : 'fail'); updateDsh();
  return result;
}
function setupInput() {
  return { name: $('#host-name').value.trim(), mode: currentMode(), address: $('#address').value, publicHost: $('#public-host').value.trim(), workspace: $('#workspace').value.trim(),
    runtimes: Object.fromEntries(Object.keys(labels).map(id => [id, { enabled: $(`#enable-${id}`).checked, command: $(`#command-${id}`).value.trim() }])) };
}
function validateNetwork() {
  if (!$('#host-name').value.trim()) throw new Error('请填写这台电脑的名称。');
  if (!$('#address').value) throw new Error('请选择可用的本机地址。');
  if (currentMode() === 'relay' && !$('#public-host').value.trim()) throw new Error('请填写中转服务器域名。');
  const list = environment?.addresses || state.addresses;
  if (!list.some(a => a.address === $('#address').value)) throw new Error('指定 IP 尚未出现在本机网卡上，请先启动 EasyTier，再点击重新检测网卡。');
}
async function advance() {
  if (step === 0) { if (!environment?.openssl) throw new Error('请先安装 OpenSSL。'); showStep(1); }
  else if (step === 1) { validateNetwork(); showStep(2); }
  else if (step === 2) {
    validateNetwork(); if (!$('#workspace').value.trim()) throw new Error('请选择项目目录。');
    state = await api('save', setupInput()); updateState(); showStep(3);
    notice('配置已保存在这台电脑。点击下方按钮启动网关并生成二维码。', true);
  } else if (step === 3) showStep(4); else showStep(3);
}
function updateState() {
  $('#gateway-dot').classList.toggle('online', state.running);
  $('#gateway-status').textContent = state.running ? '网关正在运行' : '网关尚未启动'; $('#stop').hidden = !state.running;
  if (state.config) {
    $('#endpoint').textContent = state.config.endpoint; $('#workspace-summary').textContent = state.config.workspace;
    $('#fingerprint').textContent = state.config.fingerprint; $('#data-location').textContent = state.root;
    $('#generate-pair').textContent = state.running ? '生成新的配对二维码' : '启动网关并生成二维码';
    $('#host-name').disabled = state.running; $('#workspace').disabled = state.running;
  }
  if (!state.running && ticket) { clearPair(); $('#qr-status').textContent = '网关已停止，请重新启动。'; }
  if (state.pairingUsed && ticket) { clearPair(); $('#qr-status').textContent = '这张二维码已完成配对。'; $('#qr-announce').textContent = '手机已完成配对，这张二维码不再有效。'; }
  const active = state.devices.filter(d => !d.revoked);
  $('#paired-banner').hidden = !active.length; $('#paired-banner').textContent = `已配对 ${active.length} 台手机：${active.map(d => d.name).join('、')}。可继续查看首次任务指引。`;
  const signature = JSON.stringify(state.devices);
  if (signature === deviceSignature) return;
  deviceSignature = signature;
  const focusedDevice = document.activeElement?.dataset?.deviceId;
  $('#devices').replaceChildren();
  if (!state.devices.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '还没有已配对的手机。返回上一步，扫描二维码完成配对。'; $('#devices').append(p); }
  state.devices.forEach(device => {
    const row = document.createElement('div'); row.className = 'device';
    const text = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
    title.textContent = device.name; detail.textContent = device.revoked ? '已撤销访问权限' : '已建立信任 · ' + device.id;
    text.append(title, detail); row.append(text);
    if (!device.revoked) { const button = document.createElement('button'); button.dataset.deviceId = device.id; button.className = 'secondary'; button.textContent = '撤销访问'; button.addEventListener('click', () => void action(button, async () => { await api('revoke', { id: device.id }); await refresh(); notice('已撤销该设备的访问权限，重新使用需要扫码配对。', true); })); row.append(button); }
    $('#devices').append(row);
  });
  if (focusedDevice) { const replacement = $$('#devices button').find(button => button.dataset.deviceId === focusedDevice); if (replacement) replacement.focus(); else { $('#devices').tabIndex = -1; $('#devices').focus(); } }
}
async function refresh() { state = await api('state'); updateState(); }
function clearPair() { ticket = undefined; qrData = undefined; $('#qr-dialog').close(); $('#qr-large').removeAttribute('src'); $('#qr').hidden = true; $('#qr').removeAttribute('src'); $('#qr-empty').hidden = false; $('#download-qr').disabled = true; $('#download-json').disabled = true; $('#qr-status').textContent = '尚未生成'; $('#zoom-qr').disabled = true; }
function updateTimer() {
  if (!ticket) return;
  const remaining = Math.max(0, Math.ceil((ticket.expiresAt - Date.now()) / 1000));
  if (!remaining) { clearPair(); $('#qr-status').textContent = '二维码已过期，请重新生成。'; $('#qr-announce').textContent = '二维码已过期，请重新生成。'; return; }
  $('#qr-status').textContent = `剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} · 仅可兑换一次`;
}
function download(filename, data, type) {
  const href = URL.createObjectURL(new Blob([data], { type })); const link = document.createElement('a'); link.href = href; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
async function browse(path) {
  folder = await api('folders', { path }); $('#folder-browser').hidden = false; $('#folder-current').textContent = folder.path;
  $('#folder-up').disabled = folder.path === folder.parent; $('#folder-list').replaceChildren();
  folder.entries.forEach(item => { const button = document.createElement('button'); button.textContent = item.name; button.addEventListener('click', () => void action(button, () => browse(item.path))); $('#folder-list').append(button); });
  if (!folder.entries.length) { const p = document.createElement('p'); p.textContent = '没有可显示的子文件夹，可直接选择当前目录。'; $('#folder-list').append(p); }
}
async function init() {
  state = await api('state'); $('#system-label').textContent = state.system.name + ' 版';
  $('#host-name').value = state.config?.name || state.name; $('#workspace').value = state.config?.workspace || '';
  const instructions = {
    win32: 'Windows：安装 Node.js 24（x64 或 ARM64）。OpenSSL 可由 Git for Windows 提供，助手会检测其默认安装目录。AI 程序支持原生 .exe 和常见 npm .cmd 启动器。',
    darwin: 'macOS：安装 Node.js 24.pkg。若未检测到 OpenSSL，可安装 Homebrew 的 openssl@3，并将其 bin 目录加入 PATH。Apple Silicon 与 Intel 均可使用对应的 Node.js 安装包。',
    linux: 'Linux：安装 Node.js 24 与 openssl。请使用带有浏览器的桌面会话；服务器上的无桌面会话可继续使用包内的命令行工具。'
  };
  $('#platform-help').textContent = instructions[state.platform] || instructions.linux;
  $('#firewall-help').textContent = state.platform === 'win32' ? 'Windows 防火墙如询问 Node.js 网络访问，仅允许你信任的“专用网络”。不需要关闭防火墙。' : state.platform === 'darwin' ? '在 macOS 系统设置的防火墙选项中，允许 Node.js 接收入站连接。' : '如启用了防火墙，仅为手机所在的可信子网放行 TCP 8899。';
  $('#et-command').textContent = state.platform === 'win32' ? '使用 EasyTier GUI 导入 host.toml，或在管理员终端运行 easytier-core.exe -c host.toml，使本机取得指定的虚拟网卡地址。' : '在已安装 EasyTier 的终端执行 sudo easytier-core -c host.toml，创建本机虚拟网卡。管理员权限仅用于网络组件。';
  $('#relay-mapping').textContent = `${state.system.name} 固定映射：服务器 TCP ${state.system.publicPort} → ${state.system.address}:8899。服务器和这台电脑必须使用同一份 App 网络密钥。`;
  $('#reopen-help').textContent = state.platform === 'win32' ? '双击 Start-Windows.cmd，保留启动窗口。' : state.platform === 'darwin' ? '打开 Start-macOS.command；若文件没有执行权限，按包内说明赋予权限后启动。' : '运行 Start-Linux.sh，或在文件管理器选择“在终端运行”。';
  buildRuntimes(); updateState();
  if (state.config) {
    const endpoint = new URL(state.config.endpoint), relay = endpoint.port !== '8899';
    $(`input[name=mode][value=${relay ? 'relay' : 'lan'}]`).checked = true;
    $('#public-host').value = relay ? endpoint.hostname : '';
  }
  await checkEnvironment(); if (state.config) { $('#address').value = state.config.address; reached = 4; showStep(3); }
  setInterval(() => { if (!busy) refresh().then(() => { if (offline) { offline = false; notice('助手已重新连接。', true); } }).catch(() => { if (!offline) { offline = true; notice('无法连接电脑助手。请确认启动窗口仍在运行，并重新打开助手。'); } $('#gateway-status').textContent = '助手连接已断开'; $('#gateway-dot').classList.remove('online'); clearPair(); }); }, 4000);
  setInterval(updateTimer, 1000);
}
$('#next').addEventListener('click', event => void action(event.currentTarget, advance, '正在保存…'));
$('#back').addEventListener('click', () => { notice(); showStep(Math.max(0, step - 1)); });
$$('[data-step]').forEach(button => button.addEventListener('click', () => { notice(); showStep(Number(button.dataset.step)); }));
$$('input[name=mode]').forEach(input => input.addEventListener('change', updateAddresses));
['#refresh-check', '#refresh-network'].forEach(id => $(id).addEventListener('click', event => void action(event.currentTarget, checkEnvironment, '检测中…')));
$('#probe-all').addEventListener('click', event => void action(event.currentTarget, async () => { await Promise.all(Object.keys(labels).filter(id => $(`#enable-${id}`).checked).map(probe)); }, '检测中…'));
$('#browse').addEventListener('click', event => void action(event.currentTarget, () => browse($('#workspace').value.trim() || state.home)));
$('#folder-up').addEventListener('click', event => void action(event.currentTarget, () => browse(folder.parent)));
$('#folder-select').addEventListener('click', () => { if (state.running) { notice('请先停止网关再修改项目目录。'); return; } $('#workspace').value = folder.path; $('#folder-browser').hidden = true; });
$('#folder-close').addEventListener('click', () => { $('#folder-browser').hidden = true; });
$('#generate-pair').addEventListener('click', event => void action(event.currentTarget, async () => {
  clearPair(); if (!state.running) await api('start', {});
  await refresh(); const result = await api('pair', {}); ticket = result.ticket; qrData = result.qr;
  $('#qr').src = qrData; $('#qr').hidden = false; $('#qr-empty').hidden = true; $('#download-qr').disabled = false; $('#download-json').disabled = false; $('#zoom-qr').disabled = false; updateTimer();
  $('#qr-announce').textContent = '新的配对二维码已生成，两分钟内有效。';
}, '正在准备二维码…'));
$('#download-qr').addEventListener('click', () => { if (!ticket || Date.now() >= ticket.expiresAt) { updateTimer(); return; } const link = document.createElement('a'); link.href = qrData; link.download = 'pairing-device.png'; link.click(); });
$('#download-json').addEventListener('click', () => { if (!ticket || Date.now() >= ticket.expiresAt) { updateTimer(); return; } download('pairing-device.json', JSON.stringify(ticket, null, 2), 'application/json'); });
$('#verify').addEventListener('click', event => void action(event.currentTarget, async () => { const result = await api('verify', {}); $('#verify-result').textContent = (result.ok ? '检测通过：' : '尚未连接：') + result.detail + (result.ok ? ' 请继续用手机实际扫码。' : ''); }, '正在检测…'));
$('#stop').addEventListener('click', () => $('#stop-dialog').showModal());
$('#stop-cancel').addEventListener('click', () => $('#stop-dialog').close());
$('#stop-confirm').addEventListener('click', event => void action(event.currentTarget, async () => { $('#stop-dialog').close(); await api('stop', {}); clearPair(); await refresh(); notice('网关已停止，手机连接已断开。', true); }));
$('#network-generate').addEventListener('click', event => void action(event.currentTarget, async () => { network = await api('network', { publicHost: $('#public-host').value.trim(), secret: $('#network-secret').value.trim() }); $('#network-secret').value = ''; $('#network-host').hidden = false; $('#network-relay').hidden = false; $('#network-note').hidden = false; notice('配置已生成，请分别下载。两份文件使用同一独立网络密钥。', true); }));
$('#network-host').addEventListener('click', () => network && download('host.toml', network.host, 'text/plain'));
$('#network-relay').addEventListener('click', () => network && download('relay.toml', network.relay, 'text/plain'));
const zoom = document.createElement('button'); zoom.id = 'zoom-qr'; zoom.className = 'text-button'; zoom.textContent = '放大二维码'; zoom.disabled = true; $('.download-actions').prepend(zoom);
$('#qr-status').removeAttribute('aria-live');
const announce = document.createElement('p'); announce.id = 'qr-announce'; announce.className = 'sr-only'; announce.setAttribute('role', 'status'); announce.setAttribute('aria-live', 'polite'); $('.qr-column').append(announce);
zoom.addEventListener('click', () => { if (!ticket || Date.now() >= ticket.expiresAt) { updateTimer(); return; } $('#qr-large').src = qrData; $('#qr-dialog').showModal(); });
$('#qr-close').addEventListener('click', () => $('#qr-dialog').close());
void init().catch(error => { notice(error.message); $('#next').disabled = true; });
