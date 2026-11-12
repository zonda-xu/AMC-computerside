const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 13) {
  console.error('需要 Node.js 24.13+（24.x）。当前版本：' + process.versions.node + '\n请安装 https://nodejs.org/en/download/archive/v24.18.0 中对应系统的版本。');
  process.exitCode = 1;
} else {
  try { await import('./apps/desktop/src/main.ts'); }
  catch (error) { console.error('电脑连接助手无法启动：' + error.message + '\n请检查是否完整解压，以及当前用户是否有数据目录的写入权限。'); process.exitCode = 1; }
}
