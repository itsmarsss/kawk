# Raspberry Pi camera device

Video-only device client (no mic on the rig) speaking the AGENTS.md §5 wire protocol.
Tested on: Pi 4 Model B + Camera Module 3 (imx708), Raspberry Pi OS (Python 3.13).

## Setup (once, on the Pi)

```bash
sudo apt install -y --no-install-recommends python3-picamera2 python3-websockets
```

## Run

```bash
# on the hub machine:            make hub
# on the Pi (hub's LAN IP):      python3 rpi_device.py --hub ws://192.168.x.x:8765
```

The Pi announces class `pi`, gets pushed the `[devices.pi]` config from remember.toml
(640×480 @ 15 fps, q70 by default), captures via Picamera2 into a newest-wins slot,
and streams JPEG frames. Cards from the hub print to stdout until a display is wired.
Reconnects with backoff automatically; exits only if the camera itself dies.

**Verified 2026-09-20** on the hackathon rig: ~14 fps sustained into the hub over
hotspot WiFi, ~34 KB/frame, capture+encode 28 ms/frame (36 fps ceiling). Ops notes:
- Use the Pi's **raw IP** for ssh/hub URLs — mDNS (`kawk.local`) is unreliable on
  the hotspot.
- The Pi's `/etc/resolv.conf` came up with NO nameserver (stale campus config);
  we appended `1.1.1.1` / `8.8.8.8`. NetworkManager may rewrite it on reconnect —
  only matters for apt, not for streaming (hub is dialed by IP).
- Run/manage the client via two SEPARATE ssh calls; a combined
  `pkill -f rpi_device && nohup ... rpi_device.py` kills its own ssh session
  (the launch text matches the pkill pattern).

Note: picamera2's "RGB888" arrays are BGR channel order — simplejpeg is called with
`colorspace="BGR"` on purpose. If colors ever look swapped, that flag is the knob.

## Boot persistence + WiFi stability (installed on the rig 2026-09-20)

The Pi lost power twice during setup, so the client now runs as a systemd service
(`remember-rpi.service`, checked in here) — starts on boot, restarts on crash, logs to
`/var/log/remember-rpi.log`. Two more fixes that matter on this rig:
- **WiFi power save OFF** (`/etc/NetworkManager/conf.d/wifi-powersave.conf`,
  `wifi.powersave = 2`): with it on, ping jitter was 8–786 ms (avg ~400); off, ~36 ms.
- **DNS pinned via NetworkManager** (`nmcli con mod <con> ipv4.dns "1.1.1.1 8.8.8.8"
  ipv4.ignore-auto-dns yes`) — the hotspot's DHCP hands out no working DNS and the
  resolv.conf came up empty after reboots.
If the hub machine's IP changes, edit `ExecStart` in the unit and
`sudo systemctl daemon-reload && sudo systemctl restart remember-rpi`.
