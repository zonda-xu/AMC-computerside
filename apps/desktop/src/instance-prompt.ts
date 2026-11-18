import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const title = 'AMC 电脑连接助手';
const replace = '关闭旧助手并启动';
const keep = '退出本次启动';

async function terminalChoice(message: string) {
  process.stdout.write(message + '\n输入 y 关闭旧助手并启动，按 Enter 保留旧助手并退出 [y/N] ');
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of lines) return /^(y|yes|关闭)$/i.test(line.trim());
    return false;
  } finally { lines.close(); }
}

export async function confirmReplacement(running: boolean | undefined) {
  const detail = running === false ? '' : '切换会暂时断开与手机的连接。\n';
  const message = '这台电脑已经打开了一个连接助手。\n' + detail + '要关闭旧助手并启动当前这份吗？';
  if (process.argv.includes('--terminal-prompt')) return terminalChoice(message);
  try {
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        'try { $choice = [Windows.Forms.MessageBox]::Show($owner, $env:AMC_PROMPT_TEXT, $env:AMC_PROMPT_TITLE, "YesNo", "Question", "Button2"); [Console]::Write($choice.ToString()) } finally { $owner.Dispose() }'
      ].join('\n');
      const { stdout } = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, env: { ...process.env, AMC_PROMPT_TITLE: title, AMC_PROMPT_TEXT: message + '\n\n是：' + replace + '\n否：' + keep }
      });
      return stdout.trim() === 'Yes';
    }
    if (process.platform === 'darwin') {
      const script = 'on run argv\nactivate\ntry\nset picked to button returned of (display dialog (item 1 of argv) with title (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button 1 cancel button 1)\nreturn picked\non error number -128\nreturn ""\nend try\nend run';
      const { stdout } = await execute('/usr/bin/osascript', ['-e', script, message, title, keep, replace]);
      return stdout.trim() === replace;
    }
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      const dialogs: [string, string[]][] = [
        ['zenity', ['--question', '--default-cancel', '--title', title, '--text', message, '--ok-label', replace, '--cancel-label', keep]],
        ['kdialog', ['--title', title, '--default', 'keep', '--menu', message, 'keep', keep, 'replace', replace]]
      ];
      if (process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes('kde')) dialogs.reverse();
      for (const [command, args] of dialogs) {
        try {
          const { stdout } = await execute(command, args);
          return command === 'zenity' || stdout.trim() === 'replace';
        }
        catch (error) {
          const e = error as NodeJS.ErrnoException;
          if (Number(e.code) === 1) return false;
          if (e.code !== 'ENOENT') throw error;
        }
      }
    }
  } catch { /* A host without an interactive desktop can still use its terminal. */ }
  if (process.stdin.isTTY) return terminalChoice(message);
  console.log('未获得关闭确认。如需切换，请在终端运行启动器并加上 --terminal-prompt。');
  return false;
}
