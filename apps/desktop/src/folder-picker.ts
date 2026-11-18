import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const windowsDialog = [
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$dialog.Description = "AMC - Select a project folder"',
  '$dialog.SelectedPath = $env:AMC_PICKER_START',
  'try { if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }'
].join('\n');
const macDialog = 'on run argv\ntry\nreturn POSIX path of (choose folder with prompt "AMC · 选择项目文件夹" default location (POSIX file (item 1 of argv)))\non error number -128\nreturn ""\nend try\nend run';

export async function pickHostFolder(start?: string) {
  const initial = start && isAbsolute(start) && await stat(start).then(s => s.isDirectory(), () => false) ? start : homedir();
  const options = { windowsHide:true, timeout:300000, encoding:'utf8' as const, env:{...process.env, AMC_PICKER_START:initial} };
  const kde = process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes('kde');
  const linux: [string,string[]][] = [
    ['zenity',['--file-selection','--directory','--title=AMC · 选择项目文件夹','--filename='+initial+sep]],
    ['kdialog',['--getexistingdirectory',initial,'--title','AMC · 选择项目文件夹']]
  ];
  const commands: [string,string[]][] = process.platform === 'win32'
    ? [['powershell.exe',['-NoProfile','-NonInteractive','-STA','-Command',windowsDialog]]]
    : process.platform === 'darwin' ? [['/usr/bin/osascript',['-e',macDialog,initial]]] : kde ? linux.reverse() : linux;
  for (const [command,args] of commands) {
    try {
      const { stdout } = await execute(command,args,options);
      const selected = stdout.replace(/[\r\n]+$/, '');
      if (!selected) return { path:null };
      if (!isAbsolute(selected) || !(await stat(selected)).isDirectory()) throw new Error('系统未返回有效文件夹');
      return { path:await realpath(selected) };
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stderr?:string };
      if (e.code === 'ENOENT') continue;
      if (Number(e.code) === 1 && !e.stderr?.trim()) return { path:null };
      throw new Error('系统文件夹选择器未能打开，可以在连接助手输入电脑上的绝对路径。');
    }
  }
  throw new Error('当前桌面没有可用的系统文件夹选择器，可以手动输入路径。');
}
