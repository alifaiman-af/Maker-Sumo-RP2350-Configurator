# Maker Sumo RP2350 Configurator

Browser-based tuning tool for the Cytron Maker Sumo RP2350. Connects over USB,
no install, no build step.

| Device | Browser | How |
|---|---|---|
| Windows, macOS, Linux | Chrome or Edge | USB cable (Web Serial) |
| Android phone or tablet | Chrome | USB OTG cable (WebUSB via the bundled Web Serial polyfill) |
| iPhone / iPad | — | not supported: iOS has no Web Serial or WebUSB |

Works with the `RcSumo` and `AutoRcSumo` examples from the
[MakerSumoRP2350](https://github.com/alifaiman-af/MakerSumoRP2350) Arduino
library (firmware protocols 2 and 6).

**Open:** https://alifaiman-af.github.io/Maker-Sumo-RP2350-Configurator/

## What it does

| Page | RcSumo | AutoRcSumo |
|---|---|---|
| Motor trim (forward / backward, −25…25 %) | yes | yes |
| RC channel mapping (SERVO1/SERVO2) | yes | yes |
| Fight settings (search, attack, edge escape) | | yes |
| Defense routine (DIP 5) | | yes |
| Opening moves per DIP position (0–4, 6) | | yes |
| Live sensors (opponent beams, edges, pot, RC pulses, DIP, battery) | yes | yes |
| Backup to / restore from a JSON file | yes | yes |

## Use it

1. Flash `RcSumo` or `AutoRcSumo` to the robot.
2. Close the Arduino serial monitor.
3. Open the page, press **Connect**, choose "Maker Sumo RP2350".
4. With AutoRcSumo the motors stay off while connected; disconnect to run.

## Android notes

* Use a USB OTG cable (USB-C to USB-C works on most recent phones). The phone
  powers the board; keep the robot's battery on if you want the motors to run.
* If "Maker Sumo RP2350" does not appear in the device picker, close any other
  app that uses the USB port (serial terminals, Arduino apps) and reconnect.
* The polyfill is `docs/vendor/web-serial-polyfill.js` (Google, Apache-2.0);
  it is loaded only when the browser has no native Web Serial.

## Develop

Everything is in `docs/` (`index.html`, `styles.css`, `app.js`, `vendor/`). Serve it
locally with any static server, e.g. `python -m http.server -d docs 8000`,
and open http://localhost:8000. Pushes to `main` that touch `docs/` are
deployed by the GitHub Pages workflow.

## Protocol

Plain text lines at 115200 baud. The configurator sends one command at a time
and waits for the reply:

```
HELLO                 -> OK DEVICE=MAKER_SUMO_RP2350 FW=AutoRC VERSION=1.0.0 PROTOCOL=6 BOARD=RP2350 LIB=1.0.0
CONFIG ON             -> OK CONFIG                     (AutoRC only; locks motors)
GET CONFIG            -> CONFIG F=<trim> B=<trim>
SAVE F <-25..25>      -> OK SAVED F=<n>                (same for B)
GET RC / SAVE RC 0|1  -> RC MAP=<n> / OK SAVED RC=<n>
GET AUTO / SAVE AUTO  -> AUTO <9 values>  / OK SAVED AUTO
GET DEF  / SAVE DEF   -> DEF <5 values>   / OK SAVED DEF
GET STR n / SAVE STR n-> STR n <20 values> / OK SAVED STR n
GET SENSOR            -> SENSOR <10 values> (protocol 6) or <7 values> (protocol 2)
```

## License

MIT © Cytron Technologies
