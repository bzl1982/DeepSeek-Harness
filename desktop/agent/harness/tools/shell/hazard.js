'use strict';
/**
 * harness/tools/shell/hazard.js
 * 危险命令黑名单集中维护（PROTOCOL §4.3）。
 * 命中任一规则即把 shell.exec 的权限等级从 EXECUTE 升级为 ADMIN，需要二次确认。
 *
 * 规则分两部分：
 *  1. 跨平台通用模式（rm -rf、mkfs、shutdown、reg delete 等）
 *  2. Windows/PowerShell 专属模式（Remove-Item -Recurse -Force C:\、Format-Volume 等）
 *
 * 全部用正则对命令文本做大小写不敏感匹配；命中即返回 { hit: true, rule, reason }。
 */

// 每条规则：{ re: RegExp, reason: string }
// 注意：正则使用 i 标志；写在源码里时小心转义。
const RULES = [
  // —— 文件系统大规模删除 ——
  { re: /\brm\s+-rf?\s+(-\w+\s+)*\/(\s|$)/i, reason: 'rm -rf / 根目录递归删除' },
  { re: /\brm\s+-rf?\s+(-\w+\s+)*~(\s|$)/i, reason: 'rm -rf ~ 用户主目录递归删除' },
  { re: /\brm\s+-rf?\s+(-\w+\s+)*\$HOME/i, reason: 'rm -rf $HOME 用户主目录递归删除' },
  { re: /\brm\s+-rf?\s+(-\w+\s+)*(\\|\/)(\s|$)/i, reason: 'rm -rf 根盘符递归删除' },
  { re: /\bdel\s+\/[sqf]/i, reason: 'del /s /q 递归强制删除' },
  { re: /\brmdir\s+\/s/i, reason: 'rmdir /s 递归删除目录树' },
  { re: /Remove-Item[\s\S]{0,80}-Recurse[\s\S]{0,80}-Force/i, reason: 'Remove-Item -Recurse -Force 递归强制删除' },
  { re: /Format-Volume\b/i, reason: 'Format-Volume 格式化磁盘卷' },
  { re: /\bmkfs\.[a-z0-9]/i, reason: 'mkfs 格式化文件系统' },
  { re: /\bdd\s+if=.*\bof=\/dev\//i, reason: 'dd 写入裸块设备' },

  // —— 关机 / 重启 ——
  { re: /\bshutdown\b/i, reason: 'shutdown 关机/重启系统' },
  { re: /Stop-Computer\b/i, reason: 'Stop-Computer 关闭本机' },
  { re: /Restart-Computer\b/i, reason: 'Restart-Computer 重启本机' },

  // —— 注册表 ——
  { re: /\breg\s+delete\b/i, reason: 'reg delete 删除注册表项' },
  { re: /Remove-ItemProperty[\s\S]{0,80}HKLM/i, reason: '删除 HKLM 注册表项' },

  // —— 用户 / 账户 ——
  { re: /\bnet\s+user\b/i, reason: 'net user 操作用户账户' },
  { re: /Add-LocalUser\b/i, reason: 'Add-LocalUser 创建本地用户' },
  { re: /Set-LocalUser\b/i, reason: 'Set-LocalUser 修改本地用户' },

  // —— 包管理写操作 ——
  { re: /choco\s+uninstall\b/i, reason: 'choco uninstall 卸载软件包' },
  { re: /npm\s+publish\b/i, reason: 'npm publish 公开发布包' },
  { re: /npm\s+unpublish\b/i, reason: 'npm unpublish 撤回已发布包' },
  { re: /pip\s+uninstall\b/i, reason: 'pip uninstall 卸载 Python 包' },
  { re: /apt(-get)?\s+remove\b/i, reason: 'apt remove 卸载系统包' },
  { re: /apt(-get)?\s+purge\b/i, reason: 'apt purge 清除系统包' },

  // —— Git 高危写 ——
  { re: /git\s+push[\s\S]{0,40}--force(-with-ids)?/i, reason: 'git push --force 强制覆盖远端历史' },
  { re: /git\s+push[\s\S]{0,40}\+[^\s]+(\s|$)/i, reason: 'git push + 强制推送分支' },
  { re: /git\s+reset\s+--hard\b/i, reason: 'git reset --hard 丢弃本地未提交改动' },

  // —— 网络/系统服务 ——
  { re: /Set-ExecutionPolicy\b/i, reason: 'Set-ExecutionPolicy 修改 PowerShell 执行策略' },
  { re: /Disable-WindowsUpdate\b/i, reason: '禁用 Windows 更新' },
  { re: /bcdedit\b/i, reason: 'bcdedit 修改启动配置' },

  // —— 提权相关 ——
  { re: /\bsudo\b/i, reason: 'sudo 提权执行' },
  { re: /Start-Process[\s\S]{0,80}-Verb\s+RunAs/i, reason: 'Start-Process -Verb RunAs 提权启动' },
];

/**
 * 检查一条命令是否命中危险规则。
 * @param {string} command
 * @returns {{hit:boolean, rule:(string|null), reason:(string|null)}}
 */
function inspect(command) {
  if (typeof command !== 'string') return { hit: false, rule: null, reason: null };
  for (const r of RULES) {
    if (r.re.test(command)) {
      return { hit: true, rule: r.re.source, reason: r.reason };
    }
  }
  return { hit: false, rule: null, reason: null };
}

module.exports = {
  RULES,
  inspect,
};
