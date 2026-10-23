import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bluetooth, CircleHelp, Download, Radio, ShieldCheck, Signal, Square, Waves, ChevronLeft, ChevronRight, SlidersHorizontal, Check } from "lucide-react";
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
  const [activeStep, setActiveStep] = useState(0);
  const [processingMode, setProcessingMode] = useState<"baseline" | "normalize">("baseline");
  const [filterType, setFilterType] = useState<"moving-average" | "high-pass">("moving-average");
  const [filterWindow, setFilterWindow] = useState(5);

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
  const processingStats = useMemo(() => {
    const values = samples.map((sample) => sample.intensity);
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1);
    const sd = Math.sqrt(variance) || 1;
    const baseline = values[0] ?? 0;
    return { mean, sd, baseline };
  }, [samples]);
  const workflowData = useMemo(() => {
    const processed = samples.map((sample) => ({
      ...sample,
      processed: processingMode === "baseline"
        ? sample.intensity - processingStats.baseline
        : (sample.intensity - processingStats.mean) / processingStats.sd,
    }));
    return processed.map((sample, index) => {
      const start = Math.max(0, index - filterWindow + 1);
      const segment = processed.slice(start, index + 1);
      const average = segment.reduce((sum, point) => sum + point.processed, 0) / segment.length;
      return {
        ...sample,
        filtered: filterType === "moving-average" ? average : sample.processed - average,
      };
    });
  }, [samples, processingMode, processingStats, filterType, filterWindow]);

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
    const csv = ["elapsed_seconds,elapsed,intensity_raw,processed,filtered", ...workflowData.map((s) => `${s.t},${s.elapsed},${s.intensity},${s.processed.toFixed(6)},${s.filtered.toFixed(6)}`)].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nirs-samples.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const steps = [
    { title: "Acquire Data", subtitle: "Connect and record raw optical intensity" },
    { title: "Signal Processing", subtitle: "Inspect and prepare the acquired signal" },
    { title: "Filter Data", subtitle: "Reduce noise and compare signal traces" },
    { title: "Analyze & Export", subtitle: "Review results and download your dataset" },
  ];

  const chart = (series: "raw" | "processed" | "filtered" | "compare") => {
    const data = workflowData.slice(-WINDOW_SIZE);
    return (
      <div className="chart-card workflow-chart">
        <div className="chart-header"><div><h2>{series === "raw" ? "Raw optical intensity" : series === "processed" ? "Processed signal" : series === "filtered" ? "Filtered signal" : "Signal comparison"}</h2><p>{series === "raw" ? "Original decoded measurement · raw units" : series === "processed" ? (processingMode === "baseline" ? "Baseline-corrected intensity · raw units relative to first sample" : "Z-score normalized signal · standard deviations") : series === "filtered" ? (filterType === "moving-average" ? "Moving-average smoothing" : "High-pass residual after moving-average trend removal") : "Compare the original signal with the selected processing output"}</p></div><span className="tag neutral">{data.length} POINTS</span></div>
        <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}><CartesianGrid stroke="#e9edf4" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="elapsed" tick={{ fill: "#8791a5", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={45} /><YAxis domain={["auto", "auto"]} tick={{ fill: "#8791a5", fontSize: 11 }} tickLine={false} axisLine={false} width={58} /><Tooltip contentStyle={{ border: "1px solid #e3e8f1", borderRadius: 10, fontSize: 12 }} labelStyle={{ color: "#667085" }} /><Line type="monotone" dataKey="intensity" name="Raw" stroke="#9ba5b8" strokeWidth={1.6} dot={false} isAnimationActive={false} hide={series === "processed" || series === "filtered"} /><Line type="monotone" dataKey="processed" name="Processed" stroke="#6758e8" strokeWidth={2} dot={false} isAnimationActive={false} hide={series === "raw" || series === "filtered"} /><Line type="monotone" dataKey="filtered" name="Filtered" stroke="#16a781" strokeWidth={2} dot={false} isAnimationActive={false} hide={series !== "filtered" && series !== "compare"} /></LineChart></ResponsiveContainer></div>
        <div className="chart-footer"><span><i className="footer-dot" /> Data stays in this browser session</span><span>Rolling display: last {data.length} samples</span></div>
      </div>
    );
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Waves size={22} /></div><div><strong>NIRS<span>LAB</span></strong><small>ACQUISITION SUITE</small></div></div>
        <div className="side-label">WORKFLOW</div>
        {steps.map((step, index) => (
          <button key={step.title} className={`nav-item workflow-nav ${activeStep === index ? "active" : ""}`} onClick={() => setActiveStep(index)}>
            <span className="step-number">{activeStep > index ? <Check size={14} /> : index + 1}</span><span className="nav-text">{step.title}</span>{activeStep === index && <span className="nav-dot" />}
          </button>
        ))}
        <button className="nav-item export-nav" onClick={exportCsv}><Download size={17} /> Export session</button>
        <div className="side-bottom"><div className="protocol-card"><ShieldCheck size={17} /><div><strong>Signal integrity</strong><p>{mode === "ble" ? "BLE raw data" : "Demo / raw data"}</p></div><span className="tiny-status" /></div><div className="sidebar-foot">NIRS CONSOLE <span>v0.2.0</span></div></div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div className="crumb">Workspace <span>/</span> <b>{steps[activeStep].title}</b></div><div className="top-right"><span className={mode === "ble" ? "connection-pill connected" : "connection-pill"}><span className="status-dot" />{mode === "ble" ? "DEVICE CONNECTED" : "DEMO MODE"}</span><div className="avatar">NL</div></div></header>
        <div className="content">
          <div className="workflow-progress" aria-label="Workflow progress">
            {steps.map((step, index) => <button key={step.title} className={`progress-step ${activeStep === index ? "current" : ""} ${activeStep > index ? "complete" : ""}`} onClick={() => setActiveStep(index)}><span className="progress-number">{activeStep > index ? <Check size={14} /> : index + 1}</span><span className="progress-copy"><strong>{step.title}</strong><small>STEP 0{index + 1}</small></span></button>)}
          </div>

          <div className="page-heading"><div><div className="eyebrow">NIRS ACQUISITION WORKFLOW · STEP 0{activeStep + 1}</div><h1>{steps[activeStep].title}</h1><p>{steps[activeStep].subtitle}</p></div><div className="heading-actions">{activeStep > 0 && <button className="button secondary" onClick={() => setActiveStep((step) => Math.max(0, step - 1))}><ChevronLeft size={16} /> Back</button>}{activeStep === 0 && (mode === "ble" ? <button className="button danger" onClick={disconnect}><Square size={14} /> Disconnect</button> : <button className="button primary" onClick={connectBle}><Bluetooth size={16} /> Connect sensor</button>)}{activeStep === 3 && <button className="button secondary" onClick={exportCsv}><Download size={16} /> Export CSV</button>}{activeStep < 3 && <button className="button primary" onClick={() => setActiveStep((step) => Math.min(3, step + 1))}>Next step <ChevronRight size={16} /></button>}</div></div>

          <div className="notice"><CircleHelp size={17} /><span>{activeStep === 0 ? notice : activeStep === 1 ? "Processing is applied to the samples currently held in the rolling session window. Choose baseline correction or z-score normalization to prepare the signal." : activeStep === 2 ? "Choose a simple smoothing or high-pass residual filter. The window is measured in samples; set a suitable sampling rate before interpreting it in seconds." : "Export includes raw, processed, and filtered columns. These are optical intensity-derived values, not direct HbO₂/HbR estimates."}</span></div>

          <div className="section-title"><span>{activeStep === 0 ? "ACQUISITION SESSION" : activeStep === 1 ? "PROCESSING SETTINGS" : activeStep === 2 ? "FILTER SETTINGS" : "ANALYSIS SUMMARY"}</span><div className="section-line" /><span className="session-id">SESSION · LOCAL</span></div>
          <div className="metric-grid">
            <div className="metric-card"><div className="metric-label">LATEST RAW INTENSITY <span className="metric-icon purple"><Activity size={17} /></span></div><div className="metric-value">{latest.toLocaleString()}<small> raw units</small></div><div className={delta >= 0 ? "metric-foot positive" : "metric-foot negative"}>{delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(0)} <span>since last sample</span></div></div>
            <div className="metric-card"><div className="metric-label">SAMPLES RECEIVED <span className="metric-icon blue"><Signal size={17} /></span></div><div className="metric-value">{sampleCount.toLocaleString()}</div><div className="metric-foot muted">Session counter</div></div>
            <div className="metric-card"><div className="metric-label">RAW RANGE <span className="metric-icon teal"><Waves size={17} /></span></div><div className="metric-value">{(max - min).toLocaleString()}<small> units</small></div><div className="metric-foot muted">Min {min.toLocaleString()} · Max {max.toLocaleString()}</div></div>
            <div className="metric-card"><div className="metric-label">STREAM STATUS <span className="metric-icon green"><Radio size={17} /></span></div><div className="metric-value status-value"><span className="live-pulse" />{isRunning ? "Streaming" : "Paused"}</div><div className="metric-foot muted">{mode === "ble" ? "BLE notifications" : "Synthetic demo signal"}</div></div>
          </div>

          {activeStep === 0 && <>
            {chart("raw")}
            <div className="bottom-grid">
              <div className="info-card"><div className="card-title-row"><h2>Device connection</h2><span className={mode === "ble" ? "tag good" : "tag neutral"}>{mode === "ble" ? "CONNECTED" : "DEMO MODE"}</span></div><div className="device-row"><div className="device-icon"><Bluetooth size={20} /></div><div className="device-meta"><strong>{deviceName}</strong><span>{mode === "ble" ? "BLE GATT notifications active" : "ESP32 · BLE transport expected"}</span></div><span className={mode === "ble" ? "device-state on" : "device-state"} /></div><div className="detail-row"><span>Transport</span><b>{mode === "ble" ? "Bluetooth LE" : "Simulated signal"}</b></div><div className="detail-row"><span>Samples in rolling window</span><b>{samples.length}</b></div><div className="detail-row"><span>Last packet</span><b>{lastPacket}</b></div><div className="device-note">Confirm firmware GATT UUIDs, packet framing, byte order, and sampling rate before research use.</div></div>
              <div className="info-card"><div className="card-title-row"><h2>Before proceeding</h2><span className="tag neutral">CHECKLIST</span></div><div className="check-row"><Check size={16} /><span>Raw intensity stream is available</span></div><div className="check-row"><Check size={16} /><span>Sample counter is active</span></div><div className="check-row"><CircleHelp size={16} /><span>Confirm device calibration and protocol before collecting research data</span></div><button className="button secondary full-button" onClick={() => setIsRunning((running) => !running)} disabled={mode === "ble"}>{isRunning ? <Square size={14} /> : <Activity size={14} />}{isRunning ? "Pause demo stream" : "Resume demo stream"}</button></div>
            </div>
          </>}

          {activeStep === 1 && <>
            <div className="control-card"><div className="control-heading"><div className="control-symbol"><Activity size={19} /></div><div><h2>Prepare the signal</h2><p>Choose how raw optical intensity is transformed for downstream filtering.</p></div></div><div className="form-grid"><label className="field-label">Processing method<select value={processingMode} onChange={(event) => setProcessingMode(event.target.value as "baseline" | "normalize")}><option value="baseline">Baseline correction (subtract first sample)</option><option value="normalize">Z-score normalization</option></select></label><div className="setting-summary"><span>Input samples</span><strong>{samples.length}</strong><span>Input mean</span><strong>{processingStats.mean.toFixed(2)}</strong><span>Input standard deviation</span><strong>{processingStats.sd.toFixed(2)}</strong></div></div></div>
            {chart("processed")}
            <div className="info-card"><div className="card-title-row"><h2>Processing notes</h2><span className="tag good">PREVIEW</span></div><p className="plain-note">{processingMode === "baseline" ? "Baseline correction subtracts the first sample from every sample. It shifts the signal around the initial value but does not remove drift or noise." : "Z-score normalization subtracts the window mean and divides by the window standard deviation. The resulting values are dimensionless and should not be interpreted as hemoglobin concentration."}</p></div>
          </>}

          {activeStep === 2 && <>
            <div className="control-card"><div className="control-heading"><div className="control-symbol"><SlidersHorizontal size={19} /></div><div><h2>Configure digital filter</h2><p>Filter the processed signal and compare the output before exporting.</p></div></div><div className="form-grid"><label className="field-label">Filter type<select value={filterType} onChange={(event) => setFilterType(event.target.value as "moving-average" | "high-pass")}><option value="moving-average">Moving-average low-pass smoothing</option><option value="high-pass">High-pass residual (signal minus moving average)</option></select></label><label className="field-label">Window length: {filterWindow} samples<input type="range" min="2" max="25" value={filterWindow} onChange={(event) => setFilterWindow(Number(event.target.value))} /><small>Window is in samples, not seconds. Sampling rate is not currently calibrated.</small></label></div></div>
            {chart("compare")}
            <div className="info-card"><div className="card-title-row"><h2>Filter interpretation</h2><span className="tag neutral">{filterWindow}-SAMPLE WINDOW</span></div><p className="plain-note">{filterType === "moving-average" ? "Moving-average smoothing attenuates rapid sample-to-sample variation but can also blunt peaks and introduce lag." : "The high-pass residual is calculated by subtracting the moving-average trend from the processed signal. It emphasizes faster variations and may also retain noise."} Validate filter settings against the actual sampling rate and expected physiology before using the signal for research conclusions.</p></div>
          </>}

          {activeStep === 3 && <>
            {chart("filtered")}
            <div className="bottom-grid">
              <div className="info-card"><div className="card-title-row"><h2>Analysis summary</h2><span className="tag good">READY</span></div><div className="detail-row"><span>Processing</span><b>{processingMode === "baseline" ? "Baseline correction" : "Z-score normalization"}</b></div><div className="detail-row"><span>Filter</span><b>{filterType === "moving-average" ? "Moving-average" : "High-pass residual"}</b></div><div className="detail-row"><span>Filter window</span><b>{filterWindow} samples</b></div><div className="detail-row"><span>Values in export</span><b>Raw + processed + filtered</b></div><div className="device-note">This export contains intensity-derived values. It does not contain calibrated HbO₂/HbR concentrations.</div><button className="button primary full-button" onClick={exportCsv}><Download size={16} /> Download analysis CSV</button></div>
              <div className="info-card"><div className="card-title-row"><h2>Quality checks</h2><span className="tag neutral">BASIC</span></div><div className="detail-row"><span>Samples in display window</span><b>{samples.length}</b></div><div className="detail-row"><span>Raw minimum</span><b>{min.toFixed(2)}</b></div><div className="detail-row"><span>Raw maximum</span><b>{max.toFixed(2)}</b></div><div className="detail-row"><span>Raw mean</span><b>{processingStats.mean.toFixed(2)}</b></div><div className="detail-row"><span>Raw standard deviation</span><b>{processingStats.sd.toFixed(2)}</b></div></div>
            </div>
          </>}

          <div className="workflow-bottom"><span>Step {activeStep + 1} of 4 · Data remains in this browser session</span><div>{activeStep > 0 && <button className="button secondary" onClick={() => setActiveStep((step) => Math.max(0, step - 1))}><ChevronLeft size={15} /> Previous</button>}{activeStep < 3 ? <button className="button primary" onClick={() => setActiveStep((step) => Math.min(3, step + 1))}>Continue to {steps[activeStep + 1].title}<ChevronRight size={15} /></button> : <button className="button secondary" onClick={() => setActiveStep(0)}>Start new workflow</button>}</div></div>
          <footer className="page-footer"><span>Research prototype · Not a medical device</span><span>Data is processed locally in this browser session.</span></footer>
        </div>
      </section>
    </main>
  );
}
