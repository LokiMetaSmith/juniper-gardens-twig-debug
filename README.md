# Links to Remember:
* [Moddable SDK](https://github.com/Moddable-OpenSource/moddable)
* [improv wifi standard we're trying to implement](https://www.improv-wifi.com)
* [improv-wifi-mod that handles the improv handshake](https://github.com/juniper-garden/improv-wifi-mod)
* [static size check in the ble library that we need to comment out](https://github.com/Moddable-OpenSource/moddable/blob/7276ac7ba2d3d5e28301faf9e0a918ee415e2c57/modules/network/ble/btutils.js#L441)
* [primary repo for the esp](https://github.com/juniper-garden/twig_esp32_mod)
* [Chrome Bluetooth Inspector](chrome://bluetooth-internals)
* [gitter channel for moddable that's super responsive](https://gitter.im/embedded-javascript/moddable)

# Things we have tried
* Using the improv-wifi-mod of Juniper Gardens
 - _note: we noticed that the uuid had to be reversed for the ESP server side to find the BLE device_
 -  _We also stopped commenting out the length check, as using that bleservices json file y'all had was sufficient_
* Using the reference implementation of the improv-wifi from improv-wifi.com
  - `https://improv-wifi.com`
  - _note: this works successfully when flashing over usb, but not over ble_
* Using HomeAssistant's ESPHome in Docker
  - `docker run -p 8123:8123 -v ~/homeassistant:/config`
* Building the ESPHome firmware locally
 `git clone git@github.com:esphome/esphome.git`
* Using platform.io

* I found a cdn with semver! Maybe we can use this to get an earlier version
  https://unpkg.com/esp-web-tools@9.0.4/dist/install-button.js

* improv-wifi.com, inspect element, set debug level to verbose
* Manually implemented the spec and wrote it to the device via a low-level tool

## Things we need to do
- [x] Write the checksum on the packet
- [x] Deal with ssid+password > 20 bytes (multi-packet BLE reassembly)
- [x] Send RPC result with redirect URL
- [x] Support IDENTIFY command and capabilities
