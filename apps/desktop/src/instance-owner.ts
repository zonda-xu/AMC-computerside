import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Old releases do not report their PID through HTTP. Check the actual listening
// socket before sending any OS signal, including after a graceful exit times out.
export async function ownsListener(pid: number, port: number) {
  try {
    if (process.platform === 'win32') {
      const netstat = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe');
      const { stdout } = await execute(netstat, ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      return stdout.split(/\r?\n/).some(line => {
        const fields = line.trim().split(/\s+/);
        return fields[0] === 'TCP' && fields[1] === '127.0.0.1:' + port && fields[2] === '0.0.0.0:0' && fields.at(-1) === String(pid);
      });
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execute('/usr/sbin/lsof', ['-nP','-a','-p',String(pid),'-iTCP:' + port,'-sTCP:LISTEN','-Fpn'], { timeout: 5000 });
      const lines = stdout.split('\n');
      return lines.includes('p' + pid) && lines.includes('n127.0.0.1:' + port);
    }
    const proc = '/proc/' + pid;
    const local = '0100007F:' + port.toString(16).toUpperCase().padStart(4, '0');
    const rows = (await readFile(proc + '/net/tcp', 'utf8')).trim().split('\n').map(line => line.trim().split(/\s+/));
    const sockets = new Set(rows.filter(row => row[1] === local && row[3] === '0A').map(row => 'socket:[' + row[9] + ']'));
    if (!sockets.size) return false;
    const fds = await readdir(proc + '/fd');
    const targets = await Promise.all(fds.map(fd => readlink(proc + '/fd/' + fd).catch(() => '')));
    return targets.some(target => sockets.has(target));
  } catch (error) {
    // lsof exits with 1 and no diagnostic when the requested socket is absent.
    const failure = error as { code?: number; stderr?: string };
    if (process.platform === 'darwin' && failure.code === 1 && !failure.stderr?.trim()) return false;
    return undefined;
  }
}

// For a completely unresponsive listener there is no authenticated HTTP reply
// to identify the program. Verify its launcher independently of the lock file.
export async function isPackagedAssistant(pid: number) {
  try {
    if (process.platform === 'win32') {
      const script = [
        '$p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $env:AMC_CHECK_PID)',
        '$parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$p.ParentProcessId)',
        String.raw`if ($p.Name -eq "node.exe" -and $p.CommandLine -match '(?:^|[\s"\\/])launch\.mjs(?:"|\s|$)' -and $parent.Name -eq "cmd.exe" -and $parent.CommandLine -match '(?:^|[\s"\\/])Start-Windows\.cmd(?:"|\s|$)') { [Console]::Write("AMC") }`
      ].join('\n');
      const { stdout } = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 6500, env: { ...process.env, AMC_CHECK_PID: String(pid) }
      });
      return stdout.trim() === 'AMC';
    }
    const cwd = process.platform === 'darwin'
      ? (await execute('/usr/sbin/lsof', ['-a','-p',String(pid),'-d','cwd','-Fn'], { timeout: 5000 })).stdout.split('\n').find(line => line.startsWith('n'))?.slice(1)
      : await readlink('/proc/' + pid + '/cwd');
    if (!cwd) return false;
    const command = (await execute('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 })).stdout.trim();
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    return pkg.name === 'amc-computerside' && /(?:^|[\s/])node\s+["']?(?:[^\n]*\/)?(?:launch|start)\.mjs(?:["'\s]|$)/.test(command);
  } catch { return false; }
}
