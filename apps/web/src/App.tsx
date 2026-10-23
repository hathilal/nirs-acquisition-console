import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bluetooth, CircleHelp, Download, Radio, ShieldCheck, Signal, Square, Waves } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Sample = { t: number; elapsed: string; intensity: number };
type BleCharacteristic = EventTarget & {
  value?: DataView;
  startNotifications: () => Promise<BleCharacteristic>;
};
type BleServer = { getPrimaryService: (uuid: string) => Promise<{ getCharacteristic: (uuid: string) => Promise<BleCharacteristic> }> };
type BleDevice = EventTarget & { name?: string; gatt?: { connect: () => Promise<BleServer>; disconnect: () => void } };
type BluetoothNavigator = Navigator & { bluetooth?: { requestDevice: (options: { filters: { services: string[] }[] }) => Promise<BleDevice> } };

const WINDOW_SIZE = 180;
const formatElapsed = (seconds: number) => {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

function decodeIntensity(view: DataView): number | null {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  try {
    const text = new TextDecoder().decode(bytes).trim();
    if (text.startsWith("{")) {
      const packet = JSON.parse(text) as { intensity?: number; value?: number; adc?: number };
      const value = packet.intensity ?? packet.value ?? packet.adc;
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  } catch {
    // Binary packets are handled below; packet framing must be confirmed for the target firmware.
  }
  if (view.byteLength >= 2) return view.getUint16(0, true);
  if (view.byteLength === 1) return view.getUint8(0);
  return null;
}

export default function App() {
  const [samples, setSamples] = useState<Sample[]>(() =>
    Array.from({ length: 90 }, (_, i) => ({
      t: i,
      elapsed: formatElapsed(i),
      intensity: Math.round(2140 + Math.sin(i / 6) * 95 + Math.sin(i / 2.4) * 22 + Math.cos(i / 13) * 38),
    })),
  );
  const [mode, setMode] = useState<"demo" | "ble">("demo");
  const [isRunning, setIsRunning] = useState(true);
  const [deviceName, setDeviceName] = useState("Simulated optical sensor");
  const [lastPacket, setLastPacket] = useState("Demo signal");
  const [sampleCount, setSampleCount] = useState(90);
  const [notice, setNotice] = useState("Demo data is active. Connect your ESP32 after confirming its BLE UUIDs and packet format.");
  const deviceRef = useRef<BleDevice | null>(null);
  const characteristicRef = useRef<BleCharacteristic | null>(null);
  const counterRef = useRef(90);

  useEffect(() => {
    if (!isRunning || mode !== "demo") return;
    const timer = window.setInterval(() => {
      const n = counterRef.current++;
      const value = Math.round(2140 + Math.sin(n / 6) * 95 + Math.sin(n / 2.4) * 22 + Math.cos(n / 13) * 38 + (Math.random() - 0.5) * 12);
      setSamples((prev) => [...prev, { t: n, elapsed: formatElapsed(n), intensity: value }].slice(-WINDOW_SIZE));
      setSampleCount((count) => count + 1);
      setLastPacket(new Date().toLocaleTimeString());
    }, 250);
    return () => window.clearInterval(timer);
  }, [isRunning, mode]);

  const latest = samples[samples.length - 1]?.intensity ?? 0;
  const previous = samples[samples.length - 2]?.intensity ?? latest;
  const delta = latest - previous;
  const min = useMemo(() => samples.length ? Math.min(...samples.map((s) => s.intensity)) : 0, [samples]);
  const max = useMemo(() => samples.length ? Math.max(...samples.map((s) => s.intensity)) : 0, [samples]);

  const connectBle = useCallback(async () => {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth;
    if (!bluetooth) {
      setNotice("Web Bluetooth is unavailable in this browser. Use a supported desktop Chromium browser over HTTPS or localhost.");
      return;
    }
    const serviceUuid = window.prompt("Enter the ESP32 BLE GATT service UUID (required):");
    if (!serviceUuid?.trim()) return;
    const characteristicUuid = window.prompt("Enter the notify characteristic UUID carrying optical samples:");
    if (!characteristicUuid?.trim()) return;
    try {
      setNotice("Waiting for Bluetooth device selection…");
      const device = await bluetooth.requestDevice({ filters: [{ services: [serviceUuid.trim()] }] });
      if (!device.gatt) throw new Error("Selected device does not expose a GATT server.");
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(serviceUuid.trim());
      const characteristic = await service.getCharacteristic(characteristicUuid.trim());
      deviceRef.current = device;
      characteristicRef.current = characteristic;
      const onValue = (event: Event) => {
        const target = event.target as BleCharacteristic;
        if (!target.value) return;
        const intensity = decodeIntensity(target.value);
        if (intensity === null) {
          setNotice("Received an unrecognized packet. Confirm firmware packet framing before interpreting this stream.");
          return;
        }
        const n = counterRef.current++;
        setSamples((prev) => [...prev, { t: n, elapsed: formatElapsed(n), intensity }].slice(-WINDOW_SIZE));
        setSampleCount((count) => count + 1);
        setLastPacket(new Date().toLocaleTimeString());
      };
      characteristic.addEventListener("characteristicvaluechanged", onValue);
      await characteristic.startNotifications();
      setMode("ble");
      setIsRunning(true);
      setDeviceName(device.name || "ESP32 BLE device");
      setNotice("Connected. Values are displayed as raw decoded intensity/counts; no HbO₂/HbR conversion is applied.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Bluetooth connection failed.");
    }
  }, []);

  const disconnect = () => {
    try { deviceRef.current?.gatt?.disconnect(); } catch { /* ignore disconnect cleanup errors */ }
    deviceRef.current = null;
    characteristicRef.current = null;
    setMode("demo");
    setIsRunning(true);
    setDeviceName("Simulated optical sensor");
    setNotice("Disconnected. Demo signal is active; reconnect when the device protocol is confirmed.");
  };

  const exportCsv = () => {
    const csv = ["elapsed_seconds,elapsed,intensity_raw", ...samples.map((s) => `${s.t},${s.elapsed},${s.intensity}`)].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nirs-samples.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Waves size={22} /></div><div><strong>NIRS<span>LAB</span></strong><small>ACQUISITION SUITE</small></div></div>
        <div className="side-label">WORKSPACE</div>
        <button className="nav-item active"><Activity size={17} /> Live acquisition <span className="nav-dot" /></button>
        <button className="nav-item" onClick={exportCsv}><Download size={17} /> Export session</button>
        <div className="side-bottom"><div className="protocol-card"><ShieldCheck size={17} /><div><strong>Signal integrity</strong><p>Raw data mode</p></div><span className="tiny-status" /></div><div className="sidebar-foot">NIRS CONSOLE <span>v0.1.0</span></div></div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div className="crumb">Workspace <span>/</span> <b>Live acquisition</b></div><div className="top-right"><span className={mode === "ble" ? "connection-pill connected" : "connection-pill"}><span className="status-dot" />{mode === "ble" ? "DEVICE CONNECTED" : "DEMO MODE"}</span><div className="avatar">NL</div></div></header>
        <div className="content">
          <div className="page-heading"><div><div className="eyebrow">REAL-TIME MONITORING</div><h1>Live acquisition</h1><p>Monitor optical intensity, inspect signal quality, and capture session data.</p></div><div className="heading-actions"><button className="button secondary" onClick={exportCsv}><Download size={16} /> Export CSV</button>{mode === "ble" ? <button className="button danger" onClick={disconnect}><Square size={14} /> Disconnect</button> : <button className="button primary" onClick={connectBle}><Bluetooth size={16} /> Connect sensor</button>}</div></div>

          <div className="notice"><CircleHelp size={17} /><span>{notice}</span></div>

          <div className="section-title"><span>SESSION OVERVIEW</span><div className="section-line" /><span className="session-id">SESSION · LOCAL</span></div>
          <div className="metric-grid">
            <div className="metric-card"><div className="metric-label">LATEST INTENSITY <span className="metric-icon purple"><Activity size={17} /></span></div><div className="metric-value">{latest.toLocaleString()}<small> raw units</small></div><div className={delta >= 0 ? "metric-foot positive" : "metric-foot negative"}>{delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(0)} <span>since last sample</span></div></div>
            <div className="metric-card"><div className="metric-label">SAMPLES RECEIVED <span className="metric-icon blue"><Signal size={17} /></span></div><div className="metric-value">{sampleCount.toLocaleString()}</div><div className="metric-foot muted">Live session counter</div></div>
            <div className="metric-card"><div className="metric-label">OBSERVED RANGE <span className="metric-icon teal"><Waves size={17} /></span></div><div className="metric-value">{(max - min).toLocaleString()}<small> units</small></div><div className="metric-foot muted">Min {min.toLocaleString()} · Max {max.toLocaleString()}</div></div>
            <div className="metric-card"><div className="metric-label">STREAM STATUS <span className="metric-icon green"><Radio size={17} /></span></div><div className="metric-value status-value"><span className="live-pulse" />{isRunning ? "Streaming" : "Paused"}</div><div className="metric-foot muted">{mode === "ble" ? "BLE notifications" : "Synthetic demo signal"}</div></div>
          </div>

          <div className="chart-card">
            <div className="chart-header"><div><h2>Optical intensity</h2><p>Raw decoded measurement · rolling window</p></div><div className="chart-tools"><span className="legend"><i /> Intensity</span><button className="icon-button" title={isRunning ? "Pause demo stream" : "Resume demo stream"} onClick={() => setIsRunning((v) => !v)}>{isRunning ? <Square size={14} /> : <Activity size={15} />}</button></div></div>
            <div className="chart-stats"><span><b>{latest.toLocaleString()}</b> <small>current</small></span><span><b>{(samples.reduce((sum, s) => sum + s.intensity, 0) / Math.max(1, samples.length)).toFixed(1)}</b> <small>window mean</small></span><span><b>{lastPacket}</b> <small>last packet</small></span></div>
            <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={samples} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}><CartesianGrid stroke="#e9edf4" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="elapsed" tick={{ fill: "#8791a5", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={45} /><YAxis domain={["auto", "auto"]} tick={{ fill: "#8791a5", fontSize: 11 }} tickLine={false} axisLine={false} width={54} /><Tooltip contentStyle={{ border: "1px solid #e3e8f1", borderRadius: 10, fontSize: 12 }} labelStyle={{ color: "#667085" }} formatter={(value) => [Number(value).toLocaleString(), "Raw intensity"]} /><Line type="monotone" dataKey="intensity" stroke="#6758e8" strokeWidth={2} dot={false} isAnimationActive={false} activeDot={{ r: 4, fill: "#6758e8", stroke: "#fff", strokeWidth: 2 }} /></LineChart></ResponsiveContainer></div>
            <div className="chart-footer"><span><i className="footer-dot" /> {mode === "ble" ? "BLE stream" : "Simulated data"} · {samples.length} points shown</span><span>Display window: last {samples.length} samples</span></div>
          </div>

          <div className="bottom-grid">
            <div className="info-card"><div className="card-title-row"><h2>Device connection</h2><span className={mode === "ble" ? "tag good" : "tag neutral"}>{mode === "ble" ? "CONNECTED" : "NOT CONNECTED"}</span></div><div className="device-row"><div className="device-icon"><Bluetooth size={20} /></div><div className="device-meta"><strong>{deviceName}</strong><span>{mode === "ble" ? "BLE GATT notifications active" : "ESP32 · BLE transport expected"}</span></div><span className={mode === "ble" ? "device-state on" : "device-state"} /></div><div className="detail-row"><span>Transport</span><b>{mode === "ble" ? "Bluetooth LE" : "Waiting for device"}</b></div><div className="detail-row"><span>Packet decoder</span><b>JSON / 16-bit unsigned fallback</b></div><div className="detail-row"><span>Last packet</span><b>{lastPacket}</b></div><div className="device-note">Confirm your firmware's GATT UUIDs, byte order, framing, and sampling rate before research use.</div></div>
            <div className="info-card"><div className="card-title-row"><h2>Signal processing</h2><span className="tag neutral">BASELINE</span></div><div className="processing-row"><div className="process-symbol"><Waves size={18} /></div><div><strong>Raw intensity stream</strong><p>Displaying decoded input values without physiological conversion.</p></div><span className="process-state">ACTIVE</span></div><div className="processing-row disabled"><div className="process-symbol"><Activity size={18} /></div><div><strong>Noise filtering</strong><p>Pending sampling rate and noise characterization.</p></div><span className="process-state">PENDING</span></div><div className="processing-row disabled"><div className="process-symbol"><Signal size={18} /></div><div><strong>HbO₂ / HbR estimation</strong><p>Requires suitable wavelengths and an optical model.</p></div><span className="process-state">LOCKED</span></div></div>
          </div>
          <footer className="page-footer"><span>Research prototype · Not a medical device</span><span>Data is not uploaded to a server by this demo.</span></footer>
        </div>
      </section>
    </main>
  );
}
