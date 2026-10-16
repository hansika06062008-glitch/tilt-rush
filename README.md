# 🏁 Tilt Rush: Anything but a Game Controller

**Play it live:** https://tilt-rush.onrender.com
open it on a laptop, then scan the QR code with your phone.

Your phone becomes a **real-time motion steering wheel** for a browser racing game on your laptop. Tilt to steer, shake to jump, hold BOOST to fly past trucks. Up to 4 phones can race on the same screen.

Built for the VinnovateIT App Development Round 1 task.

## Features

**Core requirements**
- **Gyroscope + accelerometer** are fused with a complementary filter for steering. Shaking the phone (an accelerometer spike) makes the car jump.
- **Pairing** works by scanning a QR code on the laptop or typing a 4-letter room code.
- **WebSocket streaming** sends input at 60 Hz with a drop-don't-queue policy, so lag can't build up.
- **Browser racing game:** dodge trucks, jump cones, barriers and oil, collect coins. Speed keeps rising.
- **Calibration** sets your "straight" position with one tap. You can recalibrate any time.
- **Connection status** shows on both devices, and **automatic reconnection** puts you back in the same seat with the same score.

**Bonus features (all included)**
- **Local multiplayer** for up to 4 phones, each with its own car colour, score and lives.
- **On-screen phone buttons:** big JUMP and BOOST buttons, plus touch steering if a phone has no sensors.
- **Vibration feedback** for countdown, jumps, coins, near misses, crashes and the win.
- **Live latency display** on the phone, and per player on the laptop.

**Extras**
- Sensitivity presets (Chill, Normal, Spicy), a live sensor readout, and a screen wake lock so the phone doesn't sleep mid-race.
- The race pauses automatically if a player's phone drops, then resumes with a countdown when it's back.
- The controller is an installable app (PWA), which can also be packaged as an APK (see below).

## Tech stack

| Part | Tech |
|---|---|
| Phone app | HTML/CSS/JS web app (PWA), DeviceMotion API, Vibration API, Wake Lock API, Fullscreen and orientation lock |
| Game | HTML5 Canvas, vanilla JS, 60 fps game loop |
| Server | Node.js, Express, Socket.IO (WebSockets), `qrcode` for QR codes, `selfsigned` for local https |

## How pairing works

1. The laptop opens the game, which asks the server for a room. The server returns a 4-letter code and a secret host token.
2. The laptop shows a QR code for `https://<server>/play?room=CODE`. When you're running locally, the server finds its Wi-Fi IP so phones can reach it.
3. The phone scans it, enters a name, and joins. The server gives the phone a player ID and a private token.
4. If either side reconnects (refresh, Wi-Fi blip), it sends its token back and gets the same room or seat. Nobody can steal a seat without the token.

## Latency approach

1. **Small messages.** Each input is a 5-number array `[seq, steer×100, jumpCount, boost, rtt]` instead of JSON with keys.
2. **60 Hz streaming** from the phone, sent as a *volatile* message: if the phone's Wi-Fi is busy, a packet is dropped rather than queued. A fresh one follows 16 ms later, so you always control the car with your newest tilt, never a stale one.
3. **Bounded relay queue.** The server forwards input to the game screen but drops packets if more than 8 are waiting, so delay can't pile up.
4. **WebSocket only** (no long-polling fallback), with compression turned off to avoid CPU delay.
5. **Ordering.** Every packet has a sequence number, and the game ignores anything older than what it already has.
6. **Jumps never get lost.** The phone sends a jump *counter*, not a one-off "jump now" event, so even if a packet is dropped the next one still triggers the jump.
7. **Measurement.** The game acknowledges about 10 packets a second. The phone measures the round trip, shows half of it as one-way latency, and reports it to the game screen.
8. **Safety.** If a phone stops sending (screen locked, app switched), its wheel straightens within half a second.

## Sensor fusion

- **Accelerometer:** the direction of gravity in the screen's plane gives the steering angle. It's stable but noisy.
- **Gyroscope:** the rotation rate around the screen axis gives smooth, instant changes, but drifts if used alone.
- **Complementary filter:** `angle = angle + gyro × dt`, then nudged 6% toward the accelerometer angle each sample. You get the gyro's speed without its drift.
- Phones and browsers differ in gyroscope sign, so the app learns the correct sign automatically in the first seconds of play.
- Calibration takes a circular average of 0.5 s of readings, so it's safe across the ±180° boundary. A 2.5° dead zone keeps the car straight when your hands wobble.
- **Shake to jump:** linear acceleration above 13 m/s², with a 650 ms cooldown.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run lan     # https mode, for testing with real phones on your Wi-Fi
```

Then open **https://localhost:3443** on the laptop. The browser will warn about the certificate; click **Advanced**, then **Proceed**.

Phones only share motion sensors with **https** pages. That's why `npm run lan` creates a self-signed certificate. `npm start` runs plain http on port 3000, which is used when deploying (the host adds https).

## Test it

**Automated test** (server running in another terminal):

```bash
npm test                                            # against npm start
node test/latency-test.js https://localhost:3443    # against npm run lan
```

It checks room creation, wrong-code rejection, 4 phones pairing, a 5th phone being turned away, 60 Hz streaming, packet order, latency, vibration delivery, phone reconnection to the same seat, game screen reconnection to the same room, and QR generation.

**With real phones**
1. Connect the laptop and phone to the **same Wi-Fi**. A phone hotspot works well; some college Wi-Fi blocks device-to-device traffic.
2. Run `npm run lan` and open https://localhost:3443 on the laptop.
3. Scan the QR code with the phone camera. Tap **Advanced → Proceed** on the warning, enter a name, and tap **Let's ride!**
4. Allow motion access if asked (iPhone), hold the phone sideways like a wheel, and tap **Set straight position**.
5. Tap **Start race** on the laptop or the phone. Tilt to steer, shake or tap JUMP, and hold BOOST.
6. Turn the phone's Wi-Fi off and on: the race pauses, the phone shows "Reconnecting…", then everything resumes.
7. Tap **Sensors** on the phone to see live gyroscope and accelerometer readings.

No phone handy? Click **Add keyboard player** in the lobby: arrows steer, Space jumps, Shift boosts.

## Deploy (public link, works anywhere)

1. Push this repo to GitHub.
2. On [render.com](https://render.com), click **New → Blueprint** and pick this repo (it uses `render.yaml`). Or create a **Web Service** with build command `npm install` and start command `npm start`.
3. You get an https link like `https://tilt-rush.onrender.com`. Open it on the laptop and scan the QR code with the phone. No certificate warnings.

On Render's free plan the app sleeps after 15 minutes idle, so the first load can take about a minute.

## APK

The controller is a PWA, so it can be packaged as an Android APK:
1. Deploy (above), then go to [pwabuilder.com](https://www.pwabuilder.com) and enter `https://<your-app>.onrender.com/play`.
2. Choose **Package for stores → Android → Generate**, and download the zip. It contains the `.apk`.
3. Or skip the APK: open the link in Chrome on Android and choose **Add to Home screen**. It runs fullscreen like an app.

## Latency results

| Conditions | Phones | Samples | One-way p50 | One-way p95 |
|---|---|---|---|---|
| Laptop only (localhost), http, Node 22 | 4 | 994 | 0.6 ms | 2.0 ms |
| Laptop only (localhost), https, Node 22 | 4 | 1214 | 0.5 ms | 1.9 ms |
| *Real phone on Wi-Fi: read it off the phone's ms badge* | | | | |

## Failure handling

| Situation | What happens |
|---|---|
| Phone Wi-Fi drops | Phone shows "Reconnecting…" and buzzes. The race pauses for everyone and resumes with a countdown when it rejoins, in the same seat with the same score. |
| Phone gone for good | Laptop can tap "Continue without them". The seat frees up after 90 seconds. |
| Laptop tab refreshed | Same room code is reclaimed with the host token. Phones show "Game screen offline" until it's back. |
| Phone screen locked | Input stops and the car straightens within 0.5 s. |
| Motion access denied, or no sensors | Switches to touch steering (drag the wheel). |
| Opened over plain http | Clear message that https is needed, plus touch steering as a fallback. |
| Phone held flat | Hint: "Lift your phone up, like a steering wheel!" |
| Wrong code, or room full | Clear error on the join screen. |
| Packets dropped or out of order | Ignored using sequence numbers. Jumps use a counter, so none are lost. |

## Project structure

```
server.js              Rooms, pairing, input relay, QR codes, https for Wi-Fi testing
public/index.html      Game screen (laptop)
public/game.js         Racing game, multiplayer, pause/resume, HUD
public/play.html       Phone controller app
public/controller.js   Sensor fusion, calibration, 60 Hz streaming, buttons, vibration
public/*.css           Styles
public/manifest.webmanifest, sw.js, icons/   Installable app (PWA)
test/latency-test.js   Automated latency and reliability test
render.yaml            One-click deploy on Render
```
