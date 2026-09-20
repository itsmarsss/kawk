// Install (Add to Home Screen / Install app) status and instructions, stated honestly: installing is not proof of
// background push, HTTPS is required off-machine, and iOS push exists only for the Home Screen app.
import type { PushEnvironment } from './push.ts';

export type WorkerState = 'pending' | 'registered' | 'failed' | 'unsupported';
export interface InstallEnvironment extends Pick<PushEnvironment, 'isIOS' | 'standalone' | 'isSecureContext' | 'protocol' | 'hostname' | 'hasServiceWorker'> {
  /** The browser fired `beforeinstallprompt` and the page holds the deferred prompt (Chromium only). */
  canPrompt: boolean;
  worker: WorkerState;
  userAgent: string;
}
export interface InstallView { status: string; tone: '' | 'ok' | 'warn' | 'bad'; steps: string[]; note: string; showInstallButton: boolean }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isSafari = (ua: string) => /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg\//.test(ua);

export function describeInstall(env: InstallEnvironment): InstallView {
  const note = 'Installing gives a Home Screen icon and a standalone window. It does not by itself prove background notifications: only a test push that appears on this device does.';
  if (env.standalone) {
    return { status: 'Running as the installed KAWK app', tone: 'ok', showInstallButton: false, note,
      steps: ['Press Start here to record; the app keeps working while you use other views.', 'Enable notifications below, then Send test push and watch for the system banner on this device.'] };
  }
  if (!env.isSecureContext && !LOCAL_HOSTS.has(env.hostname)) {
    return { status: `Not installable from ${env.protocol}//${env.hostname}: install and push need HTTPS (or localhost)`, tone: 'bad', showInstallButton: false, note,
      steps: ['Open the HTTPS address of this server (MEMORY_TLS_CERT/KEY, default port 8443).', 'A phone must trust the certificate and use the same hostname or IP the certificate names.'] };
  }
  if (env.worker === 'unsupported') return { status: 'This browser has no service worker: install and push are unavailable here', tone: 'warn', showInstallButton: false, steps: [], note };
  if (env.worker === 'failed') return { status: 'Service worker registration failed: the page works, install/push do not', tone: 'bad', showInstallButton: false, steps: ['Reload the page; if it keeps failing, check the browser console (Debug view lists page errors).'], note };
  if (env.isIOS) {
    return { status: 'Open in a browser tab on iPhone/iPad: add KAWK to the Home Screen to install', tone: 'warn', showInstallButton: false, note,
      steps: ['In Safari, tap Share, then “Add to Home Screen”, then Add.', 'Open KAWK from the Home Screen icon (not from Safari).', 'Press Enable notifications there. iOS 16.4 or newer delivers web push only to Home Screen apps.', 'Grant camera and microphone when Start asks; Continuity Camera applies to the Mac, not to the phone app.'] };
  }
  if (env.canPrompt) return { status: 'Installable: this browser can install KAWK now', tone: 'ok', showInstallButton: true, steps: ['Press Install app, or use the browser menu → Install KAWK.', 'Open the installed window and press Enable notifications.'], note };
  if (isSafari(env.userAgent)) return { status: 'Running in a Safari tab', tone: '', showInstallButton: false, steps: ['macOS Safari: File → Add to Dock… installs KAWK as an app.', 'Notifications can also be enabled from this tab; a test push must show a banner to be believed.'], note };
  return { status: 'Running in a browser tab', tone: '', showInstallButton: false, note,
    steps: ['Chrome / Edge: use the install icon in the address bar or the browser menu → Install KAWK.', `Service worker: ${env.worker === 'registered' ? 'registered' : 'registering…'}; the shell is cached, API and media are never cached.`] };
}
