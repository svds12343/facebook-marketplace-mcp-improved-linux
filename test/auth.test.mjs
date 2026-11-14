import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cookiesToHeader, loadFacebookAuth, parseFacebookAuth, readFacebookAuth, saveFacebookAuth } from '../dist/facebook/auth.js';

const cookie = (name, value, extras = {}) => ({ domain: '.facebook.com', name, value,
  path: '/', expires: -1, secure: true, httpOnly: true, ...extras });
const session = () => [cookie('c_user', '12345'), cookie('xs', 'test-session')];
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-auth-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('accepts storage state, exported arrays and domain-cookie exporter fields', () => {
  assert.equal(parseFacebookAuth({ cookies: session(), origins: [] }).cookies.length, 2);
  assert.equal(parseFacebookAuth(session()).cookies.length, 2);
  const exported = session().map(c => ({ ...c, domain: 'facebook.com', hostOnly: false,
    expires: undefined, expirationDate: Date.now() / 1000 + 3600 }));
  assert.equal(parseFacebookAuth(exported).cookies.length, 2);
});

test('drops unrelated, lookalike, host-only, and expired cookies', () => {
  const auth = parseFacebookAuth([...session(),
    cookie('foreign', 'secret', { domain: '.notfacebook.com' }),
    cookie('foreign2', 'secret', { domain: '.facebook.com.example.org' }),
    cookie('mobile', 'secret', { domain: 'm.facebook.com' }),
    cookie('apex', 'secret', { domain: 'facebook.com', hostOnly: true }),
    cookie('expired', 'secret', { expires: 1 }),
    cookie('valid', 'ok', { domain: 'www.facebook.com' }),
  ]);
  assert.deepEqual(auth.cookies.map(c => c.name), ['c_user', 'xs', 'valid']);
});

test('requires unexpired root-scoped c_user and xs', () => {
  assert.throws(() => parseFacebookAuth([cookie('c_user', '1')]), /xs/);
  assert.throws(() => parseFacebookAuth([cookie('c_user', '1', { expires: 1 }), cookie('xs', 'x')]), /c_user/);
  assert.throws(() => parseFacebookAuth([cookie('c_user', '1', { path: '/other' }), cookie('xs', 'x')]), /c_user/);
});

test('rejects header injection without reflecting cookie values', () => {
  const secret = 'private-value\r\nInjected: yes';
  assert.throws(() => parseFacebookAuth([...session(), cookie('bad', secret)]), error => {
    assert.doesNotMatch(error.message, /private-value|Injected/);
    return /Invalid characters/.test(error.message);
  });
  for (const entry of [cookie('bad;name', 'x'), cookie('bad', 'x;y'), cookie('bad', 'x y')]) {
    assert.throws(() => parseFacebookAuth([...session(), entry]), /Invalid characters/);
  }
});

test('cookie headers enforce host, path and transport scope', () => {
  const auth = parseFacebookAuth([...session(), cookie('api_only', '1', { path: '/api' })]);
  assert.doesNotMatch(cookiesToHeader(auth.cookies), /api_only/);
  assert.match(cookiesToHeader(auth.cookies, 'https://www.facebook.com/api/graphql/'), /api_only=1/);
  assert.doesNotMatch(cookiesToHeader(auth.cookies, 'https://www.facebook.com/apix'), /api_only/);
  assert.throws(() => cookiesToHeader(auth.cookies, 'https://example.com/'), /only be sent/);
  assert.throws(() => cookiesToHeader(auth.cookies, 'http://www.facebook.com/'), /only be sent/);
});

test('atomic session save is private, filtered and does not overwrite a good file with invalid input', t => {
  const filename = path.join(temporary(t), 'nested', 'session.json');
  saveFacebookAuth({ cookies: [...session(), cookie('other', 'secret', { domain: '.example.com' })], userAgent: 'TestAgent/1' }, filename);
  const contents = fs.readFileSync(filename, 'utf8');
  assert.doesNotMatch(contents, /example.com|secret/);
  assert.equal(readFacebookAuth(filename).userAgent, 'TestAgent/1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.throws(() => saveFacebookAuth([], filename), /c_user/);
  assert.equal(fs.readFileSync(filename, 'utf8'), contents);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['session.json']);
});

test('malformed JSON errors do not echo credential fragments', t => {
  const filename = path.join(temporary(t), 'broken.json');
  fs.writeFileSync(filename, '{"xs":"sensitive-value",broken');
  assert.throws(() => readFacebookAuth(filename), error => {
    assert.doesNotMatch(error.message, /sensitive-value/);
    return /Cannot read valid session JSON/.test(error.message);
  });
});

test('explicit missing cookie file gives actionable instructions and no platform fallback', async t => {
  const old = process.env.FB_COOKIES_FILE;
  process.env.FB_COOKIES_FILE = path.join(temporary(t), 'missing.json');
  t.after(() => old === undefined ? delete process.env.FB_COOKIES_FILE : process.env.FB_COOKIES_FILE = old);
  await assert.rejects(loadFacebookAuth(), /npm run login/);
});

test('CLI import works without X11 and without opening a browser', t => {
  const directory = temporary(t);
  const input = path.join(directory, 'export.json');
  const output = path.join(directory, 'state', 'session.json');
  fs.writeFileSync(input, JSON.stringify(session()));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/login.ts', '--import', input], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, DISPLAY: '', FB_COOKIES_FILE: output },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFacebookAuth(output).cookies.length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /test-session/);
});

test('Linux browser login diagnoses missing DISPLAY before attempting launch', { skip: process.platform !== 'linux' }, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/login.ts'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, DISPLAY: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DISPLAY is empty.*MobaXterm/);
});
