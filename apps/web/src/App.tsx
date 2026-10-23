
import { supabase } from "./lib/supabase";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Bluetooth,
  CircleHelp,
  Download,
  Radio,
  ShieldCheck,
  Signal,
  Square,
  Waves,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Check,
  History as HistoryIcon,
  Clock3,
  FolderOpen,
  Trash2,
  Save,
  Send,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Sample = {
  t: number;
  elapsed: string;
  intensity: number;
};

type SavedSession = {
  id: string;
  name: string;
  savedAt: string;
  deviceName: string;
  mode: "demo" | "ble";
  sampleCount: number;
  samples: Sample[];
  processingMode: "baseline" | "normalize";
  filterType: "moving-average" | "high-pass";
  filterWindow: number;
};

type BleCharacteristic = EventTarget & {
  value?: DataView;
  startNotifications: () => Promise<BleCharacteristic>;
};

type BleServer = {
  getPrimaryService: (
    uuid: string,
  ) => Promise<{
    getCharacteristic: (uuid: string) => Promise<BleCharacteristic>;
  }>;
};

type BleDevice = EventTarget & {
  name?: string;
  gatt?: {
    connect: () => Promise<BleServer>;
    disconnect: () => void;
  };
};

type BluetoothNavigator = Navigator & {
  bluetooth?: {
    requestDevice: (options: {
      filters: { services: string[] }[];
    }) => Promise<BleDevice>;
  };
};

const WINDOW_SIZE = 180;

const formatElapsed = (seconds: number) => {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

function decodeIntensity(view: DataView): number | null {
  const bytes = new Uint8Array(
    view.buffer,
    view.byteOffset,
    view.byteLength,
  );

  try {
    const text = new TextDecoder().decode(bytes).trim();

    if (text.startsWith("{")) {
      const packet = JSON.parse(text) as {
        intensity?: number;
        value?: number;
        adc?: number;
      };

      const value = packet.intensity ?? packet.value ?? packet.adc;

      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
  } catch {
    // Binary packets are handled below.
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
      intensity: Math.round(
        2140 +
          Math.sin(i / 6) * 95 +
          Math.sin(i / 2.4) * 22 +
          Math.cos(i / 13) * 38,
      ),
    })),
  );

  const [sessionSamples, setSessionSamples] = useState<Sample[]>(() =>
    Array.from({ length: 90 }, (_, i) => ({
      t: i,
      elapsed: formatElapsed(i),
      intensity: Math.round(
        2140 +
          Math.sin(i / 6) * 95 +
          Math.sin(i / 2.4) * 22 +
          Math.cos(i / 13) * 38,
      ),
    })),
  );

  const [isReviewingSavedSession, setIsReviewingSavedSession] =
    useState(false);

  const [emailRecipient, setEmailRecipient] = useState(() => {
    try {
      return window.localStorage.getItem("nirs-email-recipient") ?? "";
    } catch {
      return "";
    }
  });

  const [autoEmailOnFinalize, setAutoEmailOnFinalize] = useState(() => {
    try {
      return window.localStorage.getItem("nirs-auto-email") === "true";
    } catch {
      return false;
    }
  });

  const [emailSending, setEmailSending] = useState(false);
  const [emailStatus, setEmailStatus] = useState("");
  const captureFinalizedRef = useRef(false);

  // Sessions are loaded from Supabase, not localStorage.
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");

  const [mode, setMode] = useState<"demo" | "ble">("demo");
  const [isRunning, setIsRunning] = useState(true);
  const [deviceName, setDeviceName] = useState(
    "Simulated optical sensor",
  );
  const [lastPacket, setLastPacket] = useState("Demo signal");
  const [sampleCount, setSampleCount] = useState(90);
  const [notice, setNotice] = useState(
    "Demo data is active. Connect your ESP32 after confirming its BLE UUIDs and packet format.",
  );

  const deviceRef = useRef<BleDevice | null>(null);
  const characteristicRef = useRef<BleCharacteristic | null>(null);
  const counterRef = useRef(90);

  const [activeStep, setActiveStep] = useState(0);
  const [processingMode, setProcessingMode] =
    useState<"baseline" | "normalize">("baseline");
  const [filterType, setFilterType] =
    useState<"moving-average" | "high-pass">("moving-average");
  const [filterWindow, setFilterWindow] = useState(5);

  // Load sessions belonging to the authenticated Supabase user.
  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      setSessionsLoading(true);
      setSessionError("");

      const { data, error } = await supabase
        .from("nirs_sessions")
        .select("id, session_name, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (cancelled) return;

      if (error) {
        console.error("Failed to load sessions:", error.message);
        setSessionError(error.message);
        setNotice(`Could not load cloud sessions: ${error.message}`);
        setSessionsLoading(false);
        return;
      }

      const sessions: SavedSession[] = (data ?? []).map((row) => {
        const metadata = (row.metadata ?? {}) as Partial<SavedSession>;

        const validSamples = Array.isArray(metadata.samples)
          ? metadata.samples
          : [];

        return {
          id: row.id,
          name: row.session_name || metadata.name || "NIRS session",
          savedAt: metadata.savedAt || row.created_at,
          deviceName: metadata.deviceName || "Unknown device",
          mode: metadata.mode === "ble" ? "ble" : "demo",
          sampleCount: metadata.sampleCount ?? validSamples.length,
          samples: validSamples,
          processingMode:
            metadata.processingMode === "normalize"
              ? "normalize"
              : "baseline",
          filterType:
            metadata.filterType === "high-pass"
              ? "high-pass"
              : "moving-average",
          filterWindow: metadata.filterWindow ?? 5,
        };
      });

      setSavedSessions(sessions);
      setSessionsLoading(false);
    }

    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isRunning || mode !== "demo" || isReviewingSavedSession) {
      return;
    }

    const timer = window.setInterval(() => {
      const n = counterRef.current++;

      const value = Math.round(
        2140 +
          Math.sin(n / 6) * 95 +
          Math.sin(n / 2.4) * 22 +
          Math.cos(n / 13) * 38 +
          (Math.random() - 0.5) * 12,
      );

      const sample = {
        t: n,
        elapsed: formatElapsed(n),
        intensity: value,
      };

      setSamples((prev) => [...prev, sample].slice(-WINDOW_SIZE));
      setSessionSamples((prev) => [...prev, sample]);
      setSampleCount((count) => count + 1);
      setLastPacket(new Date().toLocaleTimeString());
    }, 250);

    return () => window.clearInterval(timer);
  }, [isRunning, mode, isReviewingSavedSession]);

  const latest = samples[samples.length - 1]?.intensity ?? 0;
  const previous = samples[samples.length - 2]?.intensity ?? latest;
  const delta = latest - previous;

  const min = useMemo(
    () =>
      samples.length
        ? Math.min(...samples.map((s) => s.intensity))
        : 0,
    [samples],
  );

  const max = useMemo(
    () =>
      samples.length
        ? Math.max(...samples.map((s) => s.intensity))
        : 0,
    [samples],
  );

  const processingStats = useMemo(() => {
    const values = sessionSamples.map((sample) => sample.intensity);

    const mean =
      values.reduce((sum, value) => sum + value, 0) /
      Math.max(values.length, 1);

    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(values.length, 1);

    const sd = Math.sqrt(variance) || 1;
    const baseline = values[0] ?? 0;

    return { mean, sd, baseline };
  }, [sessionSamples]);

  const workflowData = useMemo(() => {
    const processed = sessionSamples.map((sample) => ({
      ...sample,
      processed:
        processingMode === "baseline"
          ? sample.intensity - processingStats.baseline
          : (sample.intensity - processingStats.mean) /
            processingStats.sd,
    }));

    return processed.map((sample, index) => {
      const start = Math.max(0, index - filterWindow + 1);
      const segment = processed.slice(start, index + 1);

      const average =
        segment.reduce((sum, point) => sum + point.processed, 0) /
        segment.length;

      return {
        ...sample,
        filtered:
          filterType === "moving-average"
            ? average
            : sample.processed - average,
      };
    });
  }, [
    sessionSamples,
    processingMode,
    processingStats,
    filterType,
    filterWindow,
  ]);

  const connectBle = useCallback(async () => {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth;

    if (!bluetooth) {
      setNotice(
        "Web Bluetooth is unavailable in this browser. Use a supported desktop Chromium browser over HTTPS or localhost.",
      );
      return;
    }

    const serviceUuid = window.prompt(
      "Enter the ESP32 BLE GATT service UUID (required):",
    );

    if (!serviceUuid?.trim()) return;

    const characteristicUuid = window.prompt(
      "Enter the notify characteristic UUID carrying optical samples:",
    );

    if (!characteristicUuid?.trim()) return;

    try {
      setNotice("Waiting for Bluetooth device selection…");

      const device = await bluetooth.requestDevice({
        filters: [{ services: [serviceUuid.trim()] }],
      });

      if (!device.gatt) {
        throw new Error("Selected device does not expose a GATT server.");
      }

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(serviceUuid.trim());

      const characteristic = await service.getCharacteristic(
        characteristicUuid.trim(),
      );

      deviceRef.current = device;
      characteristicRef.current = characteristic;
      captureFinalizedRef.current = false;

      const onValue = (event: Event) => {
        if (captureFinalizedRef.current) return;

        const target = event.target as BleCharacteristic;
        if (!target.value) return;

        const intensity = decodeIntensity(target.value);

        if (intensity === null) {
          setNotice(
            "Received an unrecognized packet. Confirm firmware packet framing before interpreting this stream.",
          );
          return;
        }

        const n = counterRef.current++;

        const sample = {
          t: n,
          elapsed: formatElapsed(n),
          intensity,
        };

        setSamples((prev) => [...prev, sample].slice(-WINDOW_SIZE));
        setSessionSamples((prev) => [...prev, sample]);
        setSampleCount((count) => count + 1);
        setLastPacket(new Date().toLocaleTimeString());
      };

      characteristic.addEventListener(
        "characteristicvaluechanged",
        onValue,
      );

      await characteristic.startNotifications();

      setMode("ble");
      setIsReviewingSavedSession(false);
      setIsRunning(true);
      setDeviceName(device.name || "ESP32 BLE device");

      setNotice(
        "Connected. Values are displayed as raw decoded intensity/counts; no HbO₂/HbR conversion is applied.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Bluetooth connection failed.",
      );
    }
  }, []);

  const disconnect = () => {
    try {
      deviceRef.current?.gatt?.disconnect();
    } catch {
      // Ignore disconnect cleanup errors.
    }

    deviceRef.current = null;
    characteristicRef.current = null;

    setMode("demo");
    setIsReviewingSavedSession(false);
    setIsRunning(true);
    setDeviceName("Simulated optical sensor");

    setNotice(
      "Disconnected. Demo signal is active; reconnect when the device protocol is confirmed.",
    );
  };

  const exportCsv = () => {
    const csv = [
      "elapsed_seconds,elapsed,intensity_raw,processed,filtered",
      ...workflowData.map(
        (s) =>
          `${s.t},${s.elapsed},${s.intensity},${s.processed.toFixed(6)},${s.filtered.toFixed(6)}`,
      ),
    ].join("\n");

    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "nirs-samples.csv";
    anchor.click();

    URL.revokeObjectURL(url);
  };

  const sendSessionEmail = useCallback(async () => {
    const recipient = emailRecipient.trim();

    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      setEmailStatus("Enter a valid recipient email address first.");
      return false;
    }

    if (!workflowData.length) {
      setEmailStatus("There are no processed samples to send.");
      return false;
    }

    const csv = [
      "elapsed_seconds,elapsed,intensity_raw,processed,filtered",
      ...workflowData.map(
        (s) =>
          `${s.t},${s.elapsed},${s.intensity},${s.processed.toFixed(6)},${s.filtered.toFixed(6)}`,
      ),
    ].join("\n");

    if (new Blob([csv]).size > 4 * 1024 * 1024) {
      setEmailStatus(
        "This CSV is too large for email delivery. Download the CSV and send it using your normal secure file-sharing method.",
      );
      return false;
    }

    setEmailSending(true);
    setEmailStatus("Sending processed CSV report…");

    try {
      const response = await fetch(
        "/.netlify/functions/send-session-email",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient,
            csv,
            deviceName,
            mode,
            sampleCount: workflowData.length,
            processingMode,
            filterType,
            filterWindow,
            rawMean: processingStats.mean,
            rawStandardDeviation: processingStats.sd,
            sessionFinishedAt: new Date().toISOString(),
          }),
        },
      );

      const result = (await response.json()) as {
        error?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(result.error || "Email delivery failed.");
      }

      setEmailStatus(result.message || `Report sent to ${recipient}.`);
      setNotice(`Processed session report sent to ${recipient}.`);

      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Email delivery failed.";

      setEmailStatus(message);
      setNotice(`Email was not sent: ${message}`);

      return false;
    } finally {
      setEmailSending(false);
    }
  }, [
    emailRecipient,
    workflowData,
    deviceName,
    mode,
    processingMode,
    filterType,
    filterWindow,
    processingStats,
  ]);

  const finishSession = async () => {
    captureFinalizedRef.current = true;
    setIsRunning(false);

    if (autoEmailOnFinalize) {
      if (!emailRecipient.trim()) {
        setEmailStatus(
          "Automatic email is enabled, but no recipient is configured. Enter a recipient and finish the session again.",
        );

        setNotice(
          "Session finalized. Add a recipient email address before automatic delivery can run.",
        );

        return;
      }

      await sendSessionEmail();
    } else {
      setEmailStatus(
        "Session finalized. Automatic email is off; use Send report now if you want to email this dataset.",
      );

      setNotice(
        "Session finalized. The live demo is paused; use Send report now to email the processed CSV.",
      );
    }
  };

  const saveEmailSettings = (
    recipient: string,
    autoSend: boolean,
  ) => {
    setEmailRecipient(recipient);
    setAutoEmailOnFinalize(autoSend);

    try {
      window.localStorage.setItem("nirs-email-recipient", recipient);
      window.localStorage.setItem(
        "nirs-auto-email",
        String(autoSend),
      );
    } catch {
      setEmailStatus(
        "Settings could not be saved in this browser. Keep the recipient available to re-enter it.",
      );
    }
  };

  // Save a session to Supabase.
  const saveSession = async () => {
    if (!sessionSamples.length) {
      setNotice("There are no samples to save yet.");
      return;
    }

    const savedAt = new Date().toISOString();

    const session: SavedSession = {
      id: "",
      name: `NIRS session · ${new Date(savedAt).toLocaleString()}`,
      savedAt,
      deviceName,
      mode,
      sampleCount: sessionSamples.length,
      samples: sessionSamples,
      processingMode,
      filterType,
      filterWindow,
    };

    setNotice("Saving session to your Supabase account…");

    const { data, error } = await supabase
      .from("nirs_sessions")
      .insert({
        session_name: session.name,
        status: "completed",
        started_at: savedAt,
        ended_at: savedAt,
        metadata: session,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Failed to save session:", error.message);
      setNotice(`Could not save session: ${error.message}`);
      return;
    }

    const cloudSession: SavedSession = {
      ...session,
      id: data.id,
    };

    setSavedSessions((previous) =>
      [cloudSession, ...previous].slice(0, 50),
    );

    setSessionError("");
    setNotice("Session saved to your Supabase account.");
  };

  const loadSession = (session: SavedSession) => {
    setSessionSamples(session.samples);
    setIsReviewingSavedSession(true);
    setSamples(session.samples.slice(-WINDOW_SIZE));
    setSampleCount(session.sampleCount);

    counterRef.current =
      (session.samples[session.samples.length - 1]?.t ??
        session.samples.length - 1) + 1;

    setProcessingMode(session.processingMode);
    setFilterType(session.filterType);
    setFilterWindow(session.filterWindow);
    setDeviceName(session.deviceName);
    setMode("demo");
    setIsRunning(false);
    setActiveStep(0);

    setNotice(
      `Loaded saved session with ${session.samples.length.toLocaleString()} samples. The live demo stream is paused so you can inspect the recorded data.`,
    );
  };

  // Delete a session from Supabase.
  const deleteSession = async (id: string) => {
    const confirmed = window.confirm(
      "Delete this saved session permanently from your Supabase account?",
    );

    if (!confirmed) return;

    const previousSessions = savedSessions;

    // Optimistically update the interface.
    setSavedSessions((previous) =>
      previous.filter((session) => session.id !== id),
    );

    const { error } = await supabase
      .from("nirs_sessions")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Failed to delete session:", error.message);
      setSavedSessions(previousSessions);
      setNotice(`Could not delete session: ${error.message}`);
      return;
    }

    setNotice("Session deleted from your Supabase account.");
  };

  const steps = [
    {
      title: "Acquire Data",
      subtitle: "Connect and record raw optical intensity",
    },
    {
      title: "Signal Processing",
      subtitle: "Inspect and prepare the acquired signal",
    },
    {
      title: "Filter Data",
      subtitle: "Reduce noise and compare signal traces",
    },
    {
      title: "Analyze & Export",
      subtitle: "Review results and download your dataset",
    },
    {
      title: "Session History",
      subtitle: "Browse and restore previous sampling sessions",
    },
  ];

  const chart = (
    series: "raw" | "processed" | "filtered" | "compare",
  ) => {
    const data = workflowData.slice(-WINDOW_SIZE);

    return (
      <div className="chart-card workflow-chart">
        <div className="chart-header">
          <div>
            <h2>
              {series === "raw"
                ? "Raw optical intensity"
                : series === "processed"
                  ? "Processed signal"
                  : series === "filtered"
                    ? "Filtered signal"
                    : "Signal comparison"}
            </h2>
            <p>
              {series === "raw"
                ? "Original decoded measurement · raw units"
                : series === "processed"
                  ? processingMode === "baseline"
                    ? "Baseline-corrected intensity · raw units relative to first sample"
                    : "Z-score normalized signal · standard deviations"
                  : series === "filtered"
                    ? filterType === "moving-average"
                      ? "Moving-average smoothing"
                      : "High-pass residual after moving-average trend removal"
                    : "Compare the original signal with the selected processing output"}
            </p>
          </div>
          <span className="tag neutral">{data.length} POINTS</span>
        </div>

        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 12, right: 18, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                stroke="#e9edf4"
                strokeDasharray="3 5"
                vertical={false}
              />
              <XAxis
                dataKey="elapsed"
                tick={{ fill: "#8791a5", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={45}
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fill: "#8791a5", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={58}
              />
              <Tooltip
                contentStyle={{
                  border: "1px solid #e3e8f1",
                  borderRadius: 10,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#667085" }}
              />
              <Line
                type="monotone"
                dataKey="intensity"
                name="Raw"
                stroke="#9ba5b8"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                hide={series === "processed" || series === "filtered"}
              />
              <Line
                type="monotone"
                dataKey="processed"
                name="Processed"
                stroke="#6758e8"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                hide={series === "raw" || series === "filtered"}
              />
              <Line
                type="monotone"
                dataKey="filtered"
                name="Filtered"
                stroke="#16a781"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                hide={series !== "filtered" && series !== "compare"}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-footer">
          <span>
            <i className="footer-dot" /> Session data displayed locally
          </span>
          <span>Rolling display: last {data.length} samples</span>
        </div>
      </div>
    );
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Waves size={22} />
          </div>
          <div>
            <strong>
              NIRS<span>LAB</span>
            </strong>
            <small>ACQUISITION SUITE</small>
          </div>
        </div>

        <div className="side-label">WORKFLOW</div>

        {steps.map((step, index) => (
          <button
            key={step.title}
            className={`nav-item workflow-nav ${activeStep === index ? "active" : ""}`}
            onClick={() => setActiveStep(index)}
          >
            <span className="step-number">
              {activeStep > index ? <Check size={14} /> : index + 1}
            </span>
            <span className="nav-text">{step.title}</span>
            {activeStep === index && <span className="nav-dot" />}
          </button>
        ))}

        <button
          className="nav-item export-nav"
          onClick={() => setActiveStep(4)}
        >
          <HistoryIcon size={17} /> Session history
        </button>

        <button className="nav-item export-nav" onClick={exportCsv}>
          <Download size={17} /> Export session
        </button>

        <div className="side-bottom">
          <div className="protocol-card">
            <ShieldCheck size={17} />
            <div>
              <strong>Signal integrity</strong>
              <p>{mode === "ble" ? "BLE raw data" : "Demo / raw data"}</p>
            </div>
            <span className="tiny-status" />
          </div>
          <div className="sidebar-foot">
            NIRS CONSOLE <span>v0.2.0</span>
          </div>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="crumb">
            Workspace <span>/</span> <b>{steps[activeStep].title}</b>
          </div>
          <div className="top-right">
            <span
              className={
                mode === "ble"
                  ? "connection-pill connected"
                  : "connection-pill"
              }
            >
              <span className="status-dot" />
              {isReviewingSavedSession
                ? "SAVED SESSION"
                : mode === "ble"
                  ? "DEVICE CONNECTED"
                  : "DEMO MODE"}
            </span>
            <div className="avatar">NL</div>
          </div>
        </header>

        <div className="content">
          <div className="workflow-progress" aria-label="Workflow progress">
            {steps.map((step, index) => (
              <button
                key={step.title}
                className={`progress-step ${activeStep === index ? "current" : ""} ${activeStep > index ? "complete" : ""}`}
                onClick={() => setActiveStep(index)}
              >
                <span className="progress-number">
                  {activeStep > index ? <Check size={14} /> : index + 1}
                </span>
                <span className="progress-copy">
                  <strong>{step.title}</strong>
                  <small>STEP 0{index + 1}</small>
                </span>
              </button>
            ))}
          </div>

          <div className="page-heading">
            <div>
              <div className="eyebrow">
                NIRS ACQUISITION WORKFLOW · STEP 0{activeStep + 1}
              </div>
              <h1>{steps[activeStep].title}</h1>
              <p>{steps[activeStep].subtitle}</p>
            </div>

            <div className="heading-actions">
              {activeStep > 0 && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setActiveStep((step) => Math.max(0, step - 1))
                  }
                >
                  <ChevronLeft size={16} /> Back
                </button>
              )}

              {activeStep === 0 &&
                (mode === "ble" ? (
                  <button className="button danger" onClick={disconnect}>
                    <Square size={14} /> Disconnect
                  </button>
                ) : (
                  <button className="button primary" onClick={connectBle}>
                    <Bluetooth size={16} /> Connect sensor
                  </button>
                ))}

              {activeStep === 3 && (
                <>
                  <button
                    className="button secondary"
                    onClick={() => void saveSession()}
                  >
                    <Save size={16} /> Save session
                  </button>
                  <button
                    className="button secondary"
                    onClick={exportCsv}
                  >
                    <Download size={16} /> Export CSV
                  </button>
                </>
              )}

              {activeStep < 4 && (
                <button
                  className="button primary"
                  onClick={() =>
                    setActiveStep((step) => Math.min(4, step + 1))
                  }
                >
                  Next step <ChevronRight size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="notice">
            <CircleHelp size={17} />
            <span>
              {activeStep === 0
                ? notice
                : activeStep === 1
                  ? "Processing is applied to the samples currently held in the session. Choose baseline correction or z-score normalization."
                  : activeStep === 2
                    ? "Choose a smoothing or high-pass residual filter. The window is measured in samples."
                    : activeStep === 3
                      ? "Export includes the current session with raw, processed, and filtered columns. Save your session to Supabase for later access."
                      : sessionsLoading
                        ? "Loading your saved sessions from Supabase…"
                        : sessionError
                          ? `Could not load sessions: ${sessionError}`
                          : "Your saved recordings are stored in your Supabase account and can be accessed from another signed-in device."}
            </span>
          </div>

          <div className="section-title">
            <span>
              {activeStep === 0
                ? "ACQUISITION SESSION"
                : activeStep === 1
                  ? "PROCESSING SETTINGS"
                  : activeStep === 2
                    ? "FILTER SETTINGS"
                    : activeStep === 3
                      ? "ANALYSIS SUMMARY"
                      : "SAVED RECORDINGS"}
            </span>
            <div className="section-line" />
            <span className="session-id">
              {activeStep === 4 ? "SESSION · CLOUD" : "SESSION · ACTIVE"}
            </span>
          </div>

          <div className="metric-grid">
            <div className="metric-card">
              <div className="metric-label">
                LATEST RAW INTENSITY
                <span className="metric-icon purple">
                  <Activity size={17} />
                </span>
              </div>
              <div className="metric-value">
                {latest.toLocaleString()}
                <small> raw units</small>
              </div>
              <div
                className={
                  delta >= 0
                    ? "metric-foot positive"
                    : "metric-foot negative"
                }
              >
                {delta >= 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(0)}{" "}
                <span>since last sample</span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-label">
                SAMPLES RECEIVED
                <span className="metric-icon blue">
                  <Signal size={17} />
                </span>
              </div>
              <div className="metric-value">
                {sampleCount.toLocaleString()}
              </div>
              <div className="metric-foot muted">Session counter</div>
            </div>

            <div className="metric-card">
              <div className="metric-label">
                RAW RANGE
                <span className="metric-icon teal">
                  <Waves size={17} />
                </span>
              </div>
              <div className="metric-value">
                {(max - min).toLocaleString()}
                <small> units</small>
              </div>
              <div className="metric-foot muted">
                Min {min.toLocaleString()} · Max {max.toLocaleString()}
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-label">
                STREAM STATUS
                <span className="metric-icon green">
                  <Radio size={17} />
                </span>
              </div>
              <div className="metric-value status-value">
                <span className="live-pulse" />
                {isReviewingSavedSession
                  ? "Reviewing"
                  : isRunning
                    ? "Streaming"
                    : "Paused"}
              </div>
              <div className="metric-foot muted">
                {isReviewingSavedSession
                  ? "Saved recording · not live"
                  : mode === "ble"
                    ? "BLE notifications"
                    : "Synthetic demo signal"}
              </div>
            </div>
          </div>

          {activeStep === 0 && (
            <>
              {chart("raw")}

              <div className="bottom-grid">
                <div className="info-card">
                  <div className="card-title-row">
                    <h2>Device connection</h2>
                    <span
                      className={mode === "ble" ? "tag good" : "tag neutral"}
                    >
                      {mode === "ble" ? "CONNECTED" : "DEMO MODE"}
                    </span>
                  </div>

                  <div className="device-row">
                    <div className="device-icon">
                      <Bluetooth size={20} />
                    </div>
                    <div className="device-meta">
                      <strong>{deviceName}</strong>
                      <span>
                        {mode === "ble"
                          ? "BLE GATT notifications active"
                          : "ESP32 · BLE transport expected"}
                      </span>
                    </div>
                    <span
                      className={
                        mode === "ble" ? "device-state on" : "device-state"
                      }
                    />
                  </div>

                  <div className="detail-row">
                    <span>Transport</span>
                    <b>
                      {mode === "ble" ? "Bluetooth LE" : "Simulated signal"}
                    </b>
                  </div>
                  <div className="detail-row">
                    <span>Samples in rolling window</span>
                    <b>{samples.length}</b>
                  </div>
                  <div className="detail-row">
                    <span>Last packet</span>
                    <b>{lastPacket}</b>
                  </div>

                  <div className="device-note">
                    Confirm firmware GATT UUIDs, packet framing, byte order,
                    and sampling rate before research use.
                  </div>
                </div>

                <div className="info-card">
                  <div className="card-title-row">
                    <h2>Before proceeding</h2>
                    <span className="tag neutral">CHECKLIST</span>
                  </div>

                  <div className="check-row">
                    <Check size={16} />
                    <span>Raw intensity stream is available</span>
                  </div>
                  <div className="check-row">
                    <Check size={16} />
                    <span>Sample counter is active</span>
                  </div>
                  <div className="check-row">
                    <CircleHelp size={16} />
                    <span>
                      Confirm device calibration and protocol before
                      collecting research data
                    </span>
                  </div>

                  <button
                    className="button secondary full-button"
                    onClick={() => {
                      setIsReviewingSavedSession(false);
                      setIsRunning((running) => !running);
                    }}
                    disabled={mode === "ble"}
                  >
                    {isRunning ? (
                      <Square size={14} />
                    ) : (
                      <Activity size={14} />
                    )}
                    {isRunning ? "Pause demo stream" : "Resume demo stream"}
                  </button>
                </div>
              </div>
            </>
          )}

          {activeStep === 1 && (
            <>
              <div className="control-card">
                <div className="control-heading">
                  <div className="control-symbol">
                    <Activity size={19} />
                  </div>
                  <div>
                    <h2>Prepare the signal</h2>
                    <p>
                      Choose how raw optical intensity is transformed for
                      downstream filtering.
                    </p>
                  </div>
                </div>

                <div className="form-grid">
                  <label className="field-label">
                    Processing method
                    <select
                      value={processingMode}
                      onChange={(event) =>
                        setProcessingMode(
                          event.target.value as "baseline" | "normalize",
                        )
                      }
                    >
                      <option value="baseline">
                        Baseline correction (subtract first sample)
                      </option>
                      <option value="normalize">Z-score normalization</option>
                    </select>
                  </label>

                  <div className="setting-summary">
                    <span>Input samples</span>
                    <strong>{sessionSamples.length}</strong>
                    <span>Input mean</span>
                    <strong>{processingStats.mean.toFixed(2)}</strong>
                    <span>Input standard deviation</span>
                    <strong>{processingStats.sd.toFixed(2)}</strong>
                  </div>
                </div>
              </div>

              {chart("processed")}

              <div className="info-card">
                <div className="card-title-row">
                  <h2>Processing notes</h2>
                  <span className="tag good">PREVIEW</span>
                </div>
                <p className="plain-note">
                  {processingMode === "baseline"
                    ? "Baseline correction subtracts the first sample from every sample. It shifts the signal around the initial value but does not remove drift or noise."
                    : "Z-score normalization subtracts the window mean and divides by the window standard deviation. The resulting values are dimensionless and should not be interpreted as hemoglobin concentration."}
                </p>
              </div>
            </>
          )}

          {activeStep === 2 && (
            <>
              <div className="control-card">
                <div className="control-heading">
                  <div className="control-symbol">
                    <SlidersHorizontal size={19} />
                  </div>
                  <div>
                    <h2>Configure digital filter</h2>
                    <p>
                      Filter the processed signal and compare the output
                      before exporting.
                    </p>
                  </div>
                </div>

                <div className="form-grid">
                  <label className="field-label">
                    Filter type
                    <select
                      value={filterType}
                      onChange={(event) =>
                        setFilterType(
                          event.target.value as
                            | "moving-average"
                            | "high-pass",
                        )
                      }
                    >
                      <option value="moving-average">
                        Moving-average low-pass smoothing
                      </option>
                      <option value="high-pass">
                        High-pass residual (signal minus moving average)
                      </option>
                    </select>
                  </label>

                  <label className="field-label">
                    Window length: {filterWindow} samples
                    <input
                      type="range"
                      min="2"
                      max="25"
                      value={filterWindow}
                      onChange={(event) =>
                        setFilterWindow(Number(event.target.value))
                      }
                    />
                    <small>
                      Window is in samples, not seconds. Sampling rate is
                      not currently calibrated.
                    </small>
                  </label>
                </div>
              </div>

              {chart("compare")}

              <div className="info-card">
                <div className="card-title-row">
                  <h2>Filter interpretation</h2>
                  <span className="tag neutral">
                    {filterWindow}-SAMPLE WINDOW
                  </span>
                </div>
                <p className="plain-note">
                  {filterType === "moving-average"
                    ? "Moving-average smoothing attenuates rapid sample-to-sample variation but can also blunt peaks and introduce lag."
                    : "The high-pass residual is calculated by subtracting the moving-average trend from the processed signal. It emphasizes faster variations and may also retain noise."}{" "}
                  Validate filter settings against the actual sampling rate
                  and expected physiology before using the signal for
                  research conclusions.
                </p>
              </div>
            </>
          )}

          {activeStep === 3 && (
            <>
              {chart("filtered")}

              <div className="bottom-grid">
                <div className="info-card">
                  <div className="card-title-row">
                    <h2>Analysis summary</h2>
                    <span className="tag good">READY</span>
                  </div>

                  <div className="detail-row">
                    <span>Processing</span>
                    <b>
                      {processingMode === "baseline"
                        ? "Baseline correction"
                        : "Z-score normalization"}
                    </b>
                  </div>
                  <div className="detail-row">
                    <span>Filter</span>
                    <b>
                      {filterType === "moving-average"
                        ? "Moving-average"
                        : "High-pass residual"}
                    </b>
                  </div>
                  <div className="detail-row">
                    <span>Filter window</span>
                    <b>{filterWindow} samples</b>
                  </div>
                  <div className="detail-row">
                    <span>Values in export</span>
                    <b>Raw + processed + filtered</b>
                  </div>

                  <div className="device-note">
                    This export contains intensity-derived values. It does
                    not contain calibrated HbO₂/HbR concentrations.
                  </div>

                  <button
                    className="button primary full-button"
                    onClick={exportCsv}
                  >
                    <Download size={16} /> Download analysis CSV
                  </button>

                  <button
                    className="button secondary full-button"
                    onClick={() => void saveSession()}
                  >
                    <Save size={16} /> Save session to Supabase
                  </button>
                </div>

                <div className="info-card email-report-card">
                  <div className="card-title-row">
                    <h2>Email delivery</h2>
                    <span className="tag neutral">REPORT</span>
                  </div>

                  <p className="plain-note">
                    Send the processed CSV as an email attachment. Email
                    delivery requires the server-side Netlify function and
                    its secret settings.
                  </p>

                  <label className="field-label email-recipient-field">
                    Recipient email
                    <input
                      type="email"
                      value={emailRecipient}
                      onChange={(event) =>
                        saveEmailSettings(
                          event.target.value,
                          autoEmailOnFinalize,
                        )
                      }
                      placeholder="researcher@example.com"
                      autoComplete="email"
                    />
                  </label>

                  <label className="email-auto-option">
                    <input
                      type="checkbox"
                      checked={autoEmailOnFinalize}
                      onChange={(event) =>
                        saveEmailSettings(
                          emailRecipient,
                          event.target.checked,
                        )
                      }
                    />
                    <span>
                      <strong>
                        Automatically email when I finish a session
                      </strong>
                      <small>
                        After processing, click Finish session to send the
                        current processed CSV.
                      </small>
                    </span>
                  </label>

                  <button
                    className="button primary full-button"
                    onClick={() => void finishSession()}
                    disabled={emailSending}
                  >
                    <Check size={15} />
                    Finish session
                    {autoEmailOnFinalize ? " & send report" : ""}
                  </button>

                  <button
                    className="button secondary full-button"
                    onClick={() => void sendSessionEmail()}
                    disabled={emailSending}
                  >
                    <Send size={15} />
                    {emailSending ? "Sending report…" : "Send report now"}
                  </button>

                  {emailStatus && (
                    <div className="email-status" role="status">
                      {emailStatus}
                    </div>
                  )}

                  <div className="device-note">
                    Only send participant data to an approved recipient.
                    Confirm consent and your institution's data-handling
                    policy first.
                  </div>
                </div>

                <div className="info-card">
                  <div className="card-title-row">
                    <h2>Quality checks</h2>
                    <span className="tag neutral">BASIC</span>
                  </div>
                  <div className="detail-row">
                    <span>Samples in display window</span>
                    <b>{samples.length}</b>
                  </div>
                  <div className="detail-row">
                    <span>Raw minimum</span>
                    <b>{min.toFixed(2)}</b>
                  </div>
                  <div className="detail-row">
                    <span>Raw maximum</span>
                    <b>{max.toFixed(2)}</b>
                  </div>
                  <div className="detail-row">
                    <span>Raw mean</span>
                    <b>{processingStats.mean.toFixed(2)}</b>
                  </div>
                  <div className="detail-row">
                    <span>Raw standard deviation</span>
                    <b>{processingStats.sd.toFixed(2)}</b>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeStep === 4 && (
            <div className="history-workspace">
              <div className="history-intro">
                <div className="history-intro-icon">
                  <HistoryIcon size={22} />
                </div>

                <div>
                  <h2>Your sampling library</h2>
                  <p>
                    Saved recordings are stored in your Supabase account and
                    can be accessed from other signed-in devices.
                  </p>
                </div>

                <div className="history-total">
                  <strong>
                    {sessionsLoading ? "…" : savedSessions.length}
                  </strong>
                  <span>SAVED SESSIONS</span>
                </div>
              </div>

              <div className="history-toolbar">
                <div>
                  <strong>Previous recordings</strong>
                  <span>
                    {sessionsLoading
                      ? "Loading recordings from Supabase…"
                      : sessionError
                        ? "There was a problem loading your recordings."
                        : savedSessions.length
                          ? "Select a session to restore its signal and processing settings."
                          : "No cloud sessions yet. Open Analyze & Export and choose Save session."}
                  </span>
                </div>

                <button
                  className="button secondary"
                  onClick={() => setActiveStep(3)}
                >
                  <Save size={15} /> Save current session
                </button>
              </div>

              {sessionError && (
                <div className="info-card" role="alert">
                  <p className="plain-note">
                    Could not load sessions from Supabase: {sessionError}
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => window.location.reload()}
                  >
                    Retry
                  </button>
                </div>
              )}

              {sessionsLoading ? (
                <div className="history-empty">
                  <div className="empty-icon">
                    <FolderOpen size={26} />
                  </div>
                  <h3>Loading your session history</h3>
                  <p>Retrieving saved recordings from your Supabase account.</p>
                </div>
              ) : !sessionError && savedSessions.length === 0 ? (
                <div className="history-empty">
                  <div className="empty-icon">
                    <FolderOpen size={26} />
                  </div>
                  <h3>Your session history will appear here</h3>
                  <p>
                    Run a demo or connect a sensor, then save a session from
                    Analyze & Export. Sessions will be associated with your
                    signed-in Supabase account.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setActiveStep(0)}
                  >
                    Go to acquisition <ChevronRight size={15} />
                  </button>
                </div>
              ) : (
                !sessionError && (
                  <div className="history-list">
                    {savedSessions.map((session) => {
                      const vals = session.samples.map(
                        (sample) => sample.intensity,
                      );

                      const mean =
                        vals.reduce((sum, value) => sum + value, 0) /
                        Math.max(vals.length, 1);

                      const low =
                        vals.length > 0
                          ? Math.min(...vals)
                          : 0;

                      const high =
                        vals.length > 0
                          ? Math.max(...vals)
                          : 0;

                      return (
                        <article
                          className="history-card"
                          key={session.id}
                        >
                          <div className="history-card-top">
                            <div className="history-card-icon">
                              <Activity size={18} />
                            </div>

                            <div className="history-card-title">
                              <h3>{session.name}</h3>
                              <span>
                                <Clock3 size={12} />{" "}
                                {new Date(
                                  session.savedAt,
                                ).toLocaleString()}
                              </span>
                            </div>

                            <span
                              className={
                                session.mode === "ble"
                                  ? "tag good"
                                  : "tag neutral"
                              }
                            >
                              {session.mode === "ble"
                                ? "BLE CAPTURE"
                                : "DEMO / LOADED"}
                            </span>
                          </div>

                          <div className="history-metrics">
                            <div>
                              <span>Samples saved</span>
                              <strong>
                                {session.samples.length.toLocaleString()}
                              </strong>
                            </div>
                            <div>
                              <span>Raw mean</span>
                              <strong>{mean.toFixed(2)}</strong>
                            </div>
                            <div>
                              <span>Raw range</span>
                              <strong>
                                {low.toFixed(0)} – {high.toFixed(0)}
                              </strong>
                            </div>
                            <div>
                              <span>Filter</span>
                              <strong>
                                {session.filterType === "moving-average"
                                  ? "Moving average"
                                  : "High-pass residual"}
                              </strong>
                            </div>
                          </div>

                          <div className="history-card-bottom">
                            <span>
                              {session.deviceName} ·{" "}
                              {session.processingMode === "baseline"
                                ? "Baseline correction"
                                : "Z-score normalization"}{" "}
                              · {session.filterWindow}-sample window
                            </span>

                            <div>
                              <button
                                className="button secondary"
                                onClick={() => {
                                  loadSession(session);
                                  setActiveStep(3);
                                }}
                              >
                                <FolderOpen size={14} /> Load session
                              </button>

                              <button
                                className="button danger"
                                onClick={() =>
                                  void deleteSession(session.id)
                                }
                              >
                                <Trash2 size={14} /> Delete
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )
              )}

              <div className="history-privacy">
                <ShieldCheck size={16} />
                <span>
                  Privacy note: sessions are stored in your Supabase
                  project. Row Level Security should restrict access to the
                  authenticated owner. Avoid storing identifiable
                  participant data unless your research data-handling
                  procedures permit it.
                </span>
              </div>
            </div>
          )}

          <div className="workflow-bottom">
            <span>
              Step {activeStep + 1} of 5 · Saved recordings sync through
              Supabase
            </span>

            <div>
              {activeStep > 0 && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setActiveStep((step) => Math.max(0, step - 1))
                  }
                >
                  <ChevronLeft size={15} /> Previous
                </button>
              )}

              {activeStep < 4 ? (
                <button
                  className="button primary"
                  onClick={() =>
                    setActiveStep((step) => Math.min(4, step + 1))
                  }
                >
                  Continue to {steps[activeStep + 1].title}
                  <ChevronRight size={15} />
                </button>
              ) : (
                <button
                  className="button secondary"
                  onClick={() => setActiveStep(0)}
                >
                  Back to acquisition
                </button>
              )}
            </div>
          </div>

          <footer className="page-footer">
            <span>Research prototype · Not a medical device</span>
            <span>
              Saved sessions use Supabase; live signal processing runs in
              this browser.
            </span>
          </footer>
        </div>
      </section>
    </main>
  );
}
