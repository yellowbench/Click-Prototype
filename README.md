# My Role + AI Assistance
This was an AI Hackathon project that I worked on within 48 hours. I built and debugged two ESP32 bracelet prototypes and verified Bluetooth exchanges and syncing to a local website. I used OpenAI Codex to generate much of the firmware and website integration code. My work focused on circuit assembly, wiring troubleshooting, proximity calibration, and end-to-end testing.

This was my first real personal project where I got to learn about the Hackathon environment, prototyping with an ESP32 and learning about how useful it really is. I am posting this to begin my journey with electronics! 

![Circuits Fried:](https://img.shields.io/badge/ESP32s%20Fried-1-yellow)
- Hit an endless `"Brownout detector was triggered"` boot loop. Verified the USB cable, port, and code on a second identical board, which ran fine. Learned how to isolate a failing onboard 3.3V voltage regulator through systematic A/B hardware testing.

# Click local prototype

A downloadable copy of the Click ESP32 bracelet demo. Two boards exchange a tap over Bluetooth and sync the saved encounter into a local timeline. This copy starts with an empty encounter history. Sign-in and profile setup are demo screens.

I have made plans that can convert this prototype into a real product using an nRF52840.

## Start the website on Windows

**Visual directions are also in the docs folder**

1. Install Node.js 24 LTS from https://nodejs.org/ if needed. Use desktop Google Chrome with Bluetooth enabled.
2. Extract the entire ZIP into a writable folder.
3. Open the extracted Click-Local-Prototype folder and double-click Start Click.cmd. Keep its terminal window open.
4. Open http://localhost:8081/ in Chrome.

You can also open PowerShell in this folder and run:

```powershell
node scripts/preview-bracelet.mjs
```

The runtime uses Node's built-in modules. No npm installation is required. Open the page through the local server so that bracelet syncing works. Use Ctrl+C in the terminal to stop the server. If port 8081 is busy, close the other preview or run:

```powershell
$env:CLICK_PREVIEW_PORT = '8082'
node scripts/preview-bracelet.mjs
```

Then open http://localhost:8082/ instead.

## Try it without a bracelet

Choose Continue with Google, then Skip for now. Fill in the demo profile and at least one social handle to reach Your Clicks. The timeline stays empty until a real board is synced. The You tab can open pairing later.

## Try a real tap with two ESP32 boards

1. Use the two included firmware sketches with the hardware wiring in the build documentation. A uses an OLED and defaults to USER_101. B uses an LED and defaults to USER_202. A stored owner ID on a previously programmed board takes precedence. Each sketch's opening comment lists the libraries, wiring, and Arduino settings.
2. Open this local URL in two Chrome windows. Choose Continue with Google, then Pair bracelet in each window. Choose a different powered ESP32 in each. This syncs the clock and any confirmed records. Complete profile setup using test names and handles.
3. Click Disconnect in BOTH windows. Hold the boards face-to-face and press ONE push button. Wait for ENCOUNTER SAVED and the OLED/LED confirmation.
4. In each window, use Sync bracelet to reconnect. The corresponding user's timeline displays the other person and the tap time. Further reads use Sync now.

Each new confirmed tap is saved locally before the website acknowledges it, allowing that board's record slot to be reused. Repeating a sync keeps one timeline entry for that record. Set each board's clock by connecting before the tap if you want a calendar time. The RSSI filter is tuned for the original demo hardware, so spacing may vary on other ESP32 boards.

## Files and local storage

- Frontend.html contains the Click design, embedded browser libraries, and brand artwork. *This artwork and prototype website was made by my teammate and not by me. I only implemented the bluetooth pair feature onto the "Pair your Click" menu and the "Sync Bracelet" options*
- scripts contains the local server, Bluetooth client, controls, timeline integration, and SQLite store. *Made by Codex*
- firmware contains the two standalone Arduino sketches. *Made by Codex, modified by me*
- Start Click.cmd starts the website on Windows.

The server binds to this computer at 127.0.0.1. Demo names and new encounters are saved in .click-preview/encounters.sqlite in the extracted folder.

The embedded font and JavaScript license notices are retained with the page.
