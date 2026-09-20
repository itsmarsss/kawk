# Remember PWA — the notification surface

The mini-LCD is demoted: the hub routes every displayed card through the notify tier
(`hub/remember_hub/notify/`), which pushes a **Web Push notification** to this PWA on the
wearer's phone — and iOS mirrors it to a paired **Apple Watch** when the phone is locked.
The PWA also shows a live in-app card feed (SSE) while open.

```
display.current ─► NotifyService ─ policy ─► WebPushSink ─► Apple/Google relay ─► phone ─► watch
       (bus)            │                                          (internet)
                        └────────► SSE /api/events ─► this page (LAN)
```

## Quick start (desktop / Android over plain HTTP)

```sh
uv sync --extra pwa                          # pywebpush (VAPID + payload crypto)
uv run --extra pwa python scripts/gen_vapid.py
make hub                                     # pwa server on :8092 (remember.toml [pwa])
```

Open `http://<hub-ip>:8092`, hit **Enable notifications**, then **Send test**.
Chrome on desktop/Android accepts push from plain HTTP only for `localhost` — for a
phone over LAN you need the HTTPS setup below (Android) and always for iOS.

## iPhone + Apple Watch (the full demo path)

iOS requires **(1) HTTPS with a cert the phone trusts, (2) Add to Home Screen, (3)
notification permission from a user tap** — in that order. iOS 16.4+.

1. `brew install mkcert && mkcert -install && mkcert <hub-ip>` → cert + key files;
   point `[pwa] certfile/keyfile` in `remember.toml` at them.
2. AirDrop `"$(mkcert -CAROOT)/rootCA.pem"` to the phone → install the profile
   (Settings → General → VPN & Device Management) → **enable full trust** in
   Settings → General → About → Certificate Trust Settings.
3. Safari → `https://<hub-ip>:8092` → Share → **Add to Home Screen** → launch from the icon.
4. Tap **Enable notifications** → allow → **Send test**.
5. Lock the phone: the test notification lands on the Apple Watch automatically
   (standard iOS mirroring; nothing watch-specific to build).

The hub needs internet for the push leg (hub → Apple/Google relay) — the venue-WiFi
fallback ladder in AGENTS.md §14 applies. TODO(verify): step 2–5 on a real iPhone the
morning of the demo; simulators do not do Web Push.

## Notification policy (remember.toml `[pwa]`)

- `min_priority = 10` — profile cards and above buzz; idle never does.
- `cooldown_s = 3.0` — identical consecutive cards collapse to one buzz.
- Cards with `priority >= 25` (answer/alert/enroll) are sent with push `Urgency: high`.
- Same-tag notifications replace each other on the phone (no pile-up).

## Files

- `index.html` / `app.js` / `style.css` — app shell, SSE feed, subscribe flow
- `sw.js` — service worker: `push` → notification, click → focus
- `manifest.webmanifest`, `icons/` — installability (icons via `scripts/gen_pwa_icons.py`)
- Hub side: `hub/remember_hub/notify/` (service, policy, webpush sink, server)
