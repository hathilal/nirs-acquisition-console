# NIRS Acquisition Console

A research-oriented real-time acquisition console for near-infrared spectroscopy (NIRS) signals from an ESP32-connected photodetector.

## Initial goals

- Live signal monitoring in a web console
- BLE device connection and packet decoding
- Signal quality indicators and configurable filtering
- Real-time visualization of measured optical intensity
- Shared protocol and signal-processing modules for a future Android client

## Scientific limitation

A raw photodetector intensity stream is not, by itself, a measurement of HbO₂ or HbR concentration. Estimating concentration changes typically requires appropriate optical wavelengths, source-detector geometry, baseline/calibration handling, and a documented optical model. The application should label raw measurements accurately and only show derived physiological values when the hardware and processing pipeline support them.

## Proposed architecture

```text
ESP32 + photodetector
        │ BLE GATT
        ▼
Device transport / packet decoder
        ▼
Signal core (validation, filtering, quality metrics)
        ▼
React + TypeScript live console
        ▼
Future Android client using shared protocol and signal core
```

## Hardware details needed before implementing the device adapter

- Photodetector and analog front-end model
- Sampling rate and ADC resolution
- BLE GATT service/characteristic UUIDs and packet format
- Number of optical wavelengths and source-detector distances
- Whether firmware sends raw ADC counts, voltage, or calibrated optical intensity

## Status

Repository initialization. Hardware-specific acquisition and physiological derivation remain pending confirmation of the device protocol and optical configuration.
