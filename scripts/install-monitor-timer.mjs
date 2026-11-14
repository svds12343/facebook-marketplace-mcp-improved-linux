#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const allowed = new Set(['--dry-run', '--uninstall', '--enable']);
if (args.some(a => !allowed.has(a))) throw new Error('Supported options: --dry-run, --uninstall, --enable. The timer runs every 6 hours; background requests stay disabled unless explicitly enabled.');
if (process.platform !== 'linux' && !args.includes('--dry-run')) throw new Error('The systemd installer requires Linux.');
if (process.getuid?.() === 0 && !args.includes('--dry-run')) throw new Error('Run this installer as the Ubuntu user who saved the Facebook session, without sudo.');
const unitDirectory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const quote = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('Paths and environment settings cannot contain newlines or NUL.');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
};
const execQuote = value => quote(value).replaceAll('$', '$$');
const env = {
  FB_DATA_DIR: path.resolve(process.env.FB_DATA_DIR || path.join(os.homedir(), '.fb-marketplace')),
  FB_MONITOR_REQUEST_BUDGET: process.env.FB_MONITOR_REQUEST_BUDGET || '6',
};
for (const key of ['FB_COOKIES_FILE', 'CHROME_PROFILE', 'FB_SEARCH_DOC_ID']) if (process.env[key]) env[key] = key === 'FB_COOKIES_FILE' ? path.resolve(process.env[key]) : process.env[key];
if (!/^\d+$/.test(env.FB_MONITOR_REQUEST_BUDGET) || +env.FB_MONITOR_REQUEST_BUDGET < 1 || +env.FB_MONITOR_REQUEST_BUDGET > 6) throw new Error('FB_MONITOR_REQUEST_BUDGET must be 1–6.');
const service = `[Unit]
Description=Facebook Marketplace saved-search and price checks
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${root.replaceAll("%", "%%")}
ExecStart=${execQuote(process.execPath)} ${execQuote(path.join(root, 'dist/cli/check-monitors.js'))}
${Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')}
UMask=0077
NoNewPrivileges=true
TimeoutStartSec=45min
`;
const timer = `[Unit]
Description=Check Facebook Marketplace every 6 hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
Persistent=true
Unit=facebook-marketplace.service

[Install]
WantedBy=timers.target
`;
function systemctl(...params) {
  const child = spawnSync('systemctl', ['--user', ...params], { stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`systemctl --user ${params.join(' ')} failed. Use a normal SSH session with the user systemd bus available.`);
}
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ directory: unitDirectory, service, timer }, null, 2));
} else if (args.includes('--uninstall')) {
  systemctl('disable', '--now', 'facebook-marketplace.timer');
  systemctl('stop', 'facebook-marketplace.service');
  for (const name of ['service', 'timer']) fs.rmSync(path.join(unitDirectory, `facebook-marketplace.${name}`), { force: true });
  systemctl('daemon-reload');
  console.log('Timer removed. Saved searches, watches, alerts and sessions were kept.');
} else {
  if (!fs.existsSync(path.join(root, 'dist/cli/check-monitors.js'))) throw new Error('Run npm run build before installing the timer.');
  fs.mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
  for (const [name, content] of [['service', service], ['timer', timer]]) {
    const destination = path.join(unitDirectory, `facebook-marketplace.${name}`);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  }
  systemctl('daemon-reload');
  if (args.includes('--enable')) {
    const child = spawnSync(process.execPath, [path.join(root, 'dist/cli/automation.js'), 'enable'], { stdio: 'inherit', env: { ...process.env, ...env } });
    if (child.status !== 0) throw new Error('Could not enable background checks.');
  }
  systemctl('enable', '--now', 'facebook-marketplace.timer');
  systemctl('list-timers', 'facebook-marketplace.timer', '--no-pager');
  const linger = spawnSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], { encoding: 'utf8' });
  if (linger.stdout?.trim() !== 'yes') console.log('To keep checks running after SSH logout and at boot, run: sudo loginctl enable-linger "$USER"');
  console.log('Background requests are disabled by default; use npm run monitors:enable to opt in. Limits: 1 authenticated request/minute, 24/day, at most 6 search/detail calls/run. Alerts stay in the MCP inbox. Ask ChatGPT to read_alerts. Reinstall the timer after moving the repository or changing Node versions.');
}
