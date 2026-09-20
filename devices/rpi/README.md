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

Note: picamera2's "RGB888" arrays are BGR channel order — simplejpeg is called with
`colorspace="BGR"` on purpose. If colors ever look swapped, that flag is the knob.
