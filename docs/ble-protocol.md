# ESP32 BLE integration contract

The web console has a basic Web Bluetooth adapter in `apps/web/src/App.tsx`. It asks for the GATT service and notification characteristic UUIDs because the target firmware UUIDs have not yet been provided.

## Current prototype decoder

For each notification, the prototype attempts to decode:

1. UTF-8 JSON with a numeric `intensity`, `value`, or `adc` property.
2. Otherwise, the first two bytes as an unsigned 16-bit little-endian integer.
3. Otherwise, a single byte as an unsigned integer.

**This is a provisional demonstration decoder, not a confirmed device protocol.** A two-byte binary payload is ambiguous without a packet specification. Do not use its values for research analysis until firmware framing, byte order, scaling, sample counters, timestamps, and error handling have been verified.

## Recommended production packet

Prefer a documented, versioned binary packet containing:

- protocol version and flags
- monotonically increasing sample counter
- device timestamp (with documented units and wraparound)
- raw ADC/optical intensity value(s)
- optional channel/wavelength identifier
- checksum or CRC where appropriate

Specify whether notifications carry one sample or batches, how packet loss is detected, and how device clock and host clock are related.

## Browser constraints

Web Bluetooth requires a supported browser and a secure context (HTTPS or localhost). Browser support varies. For a production mobile application, implement a native Android BLE transport and share packet decoding and signal-processing logic in a platform-independent package.

## Details required before enabling derived physiological metrics

Document wavelengths, optical source-detector separation, detector/front-end response, ADC resolution, calibration/baseline method, and the optical model used to estimate concentration changes. Raw intensity must remain distinct from derived HbO₂/HbR estimates.
