import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeInstall, type InstallEnvironment } from '../src/install.ts';

const base: InstallEnvironment = { isIOS: false, standalone: false, isSecureContext: true, protocol: 'https:', hostname: 'kawk.local', hasServiceWorker: true, canPrompt: false, worker: 'registered', userAgent: 'Mozilla/5.0 Chrome/130 Safari/537.36' };

test('installed app: ok tone, and the note still says a test push is the only proof of background delivery', () => {
  const v = describeInstall({ ...base, standalone: true });
  assert.equal(v.tone, 'ok'); assert.match(v.status, /installed KAWK app/); assert.equal(v.showInstallButton, false);
  assert.match(v.note, /does not by itself prove background notifications/);
});

test('plain http off-machine: not installable, HTTPS steps; localhost over http is fine', () => {
  const v = describeInstall({ ...base, isSecureContext: false, protocol: 'http:', hostname: '192.168.1.20' });
  assert.equal(v.tone, 'bad'); assert.match(v.status, /http:\/\/192\.168\.1\.20.*HTTPS/); assert.match(v.steps.join(' '), /8443/); assert.match(v.steps.join(' '), /trust the certificate/);
  const l = describeInstall({ ...base, isSecureContext: false, protocol: 'http:', hostname: 'localhost' });
  assert.notEqual(l.tone, 'bad');
});

test('iOS tab: Home Screen steps and the iOS 16.4 push rule; nothing claims the phone was tested', () => {
  const v = describeInstall({ ...base, isIOS: true, userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1' });
  assert.equal(v.tone, 'warn'); assert.match(v.steps[0]!, /Share.*Add to Home Screen/); assert.match(v.steps.join(' '), /iOS 16\.4/); assert.match(v.steps.join(' '), /Continuity Camera applies to the Mac/);
  assert.doesNotMatch(v.status + v.steps.join(' ') + v.note, /verified/);
});

test('Chromium prompt available → Install button; Safari tab → Add to Dock; worker failure is visible', () => {
  assert.equal(describeInstall({ ...base, canPrompt: true }).showInstallButton, true);
  assert.match(describeInstall({ ...base, userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18 Safari/605' }).steps[0]!, /Add to Dock/);
  const f = describeInstall({ ...base, worker: 'failed' });
  assert.equal(f.tone, 'bad'); assert.match(f.status, /registration failed/);
  assert.match(describeInstall({ ...base, worker: 'unsupported' }).status, /no service worker/);
});
