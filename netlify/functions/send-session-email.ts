type SessionEmailPayload = {
  recipient?: string;
  csv?: string;
  deviceName?: string;
  mode?: string;
  sampleCount?: number;
  processingMode?: string;
  filterType?: string;
  filterWindow?: number;
  rawMean?: number;
  rawStandardDeviation?: number;
  sessionFinishedAt?: string;
};

const json = (statusCode: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);

export default async (request: Request) => {
  if (request.method !== "POST") return json(405, { error: "Use POST to send a session report." });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NIRS_EMAIL_FROM;
  const allowedRecipients = (process.env.NIRS_ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!apiKey || !from) {
    return json(503, { error: "Email delivery is not configured yet. The site administrator must configure the Resend API key and sender address in Netlify environment variables." });
  }
  if (allowedRecipients.length === 0) {
    return json(503, { error: "No approved recipients are configured. The site administrator must add NIRS_ALLOWED_RECIPIENTS in Netlify environment variables." });
  }

  let payload: SessionEmailPayload;
  try {
    payload = await request.json() as SessionEmailPayload;
  } catch {
    return json(400, { error: "Request body must be valid JSON." });
  }

  const recipient = String(payload.recipient ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return json(400, { error: "Enter a valid recipient email address." });
  }
  if (!allowedRecipients.includes(recipient)) {
    return json(403, { error: "This address is not on the approved recipient list. Ask the site administrator to add it in Netlify environment variables." });
  }
  if (typeof payload.csv !== "string" || payload.csv.length === 0) {
    return json(400, { error: "No CSV data was provided." });
  }
  if (Buffer.byteLength(payload.csv, "utf8") > 4 * 1024 * 1024) {
    return json(413, { error: "The CSV is larger than the email delivery limit. Download it and use an approved secure transfer method." });
  }

  const finishedAt = escapeHtml(payload.sessionFinishedAt ?? new Date().toISOString());
  const sampleCount = Number.isFinite(payload.sampleCount) ? payload.sampleCount : 0;
  const subject = `NIRS session report — ${sampleCount.toLocaleString()} samples`;
  const html = `
    <h2>NIRS acquisition session report</h2>
    <p>The processed CSV from a NIRS acquisition session is attached.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse">
      <tr><td><b>Device</b></td><td>${escapeHtml(payload.deviceName || "Unknown device")}</td></tr>
      <tr><td><b>Acquisition mode</b></td><td>${escapeHtml(payload.mode || "Unknown")}</td></tr>
      <tr><td><b>Samples</b></td><td>${sampleCount.toLocaleString()}</td></tr>
      <tr><td><b>Processing</b></td><td>${escapeHtml(payload.processingMode || "Unknown")}</td></tr>
      <tr><td><b>Filter</b></td><td>${escapeHtml(payload.filterType || "Unknown")} (${escapeHtml(payload.filterWindow ?? "n/a")} samples)</td></tr>
      <tr><td><b>Raw mean</b></td><td>${escapeHtml(payload.rawMean ?? "n/a")}</td></tr>
      <tr><td><b>Raw standard deviation</b></td><td>${escapeHtml(payload.rawStandardDeviation ?? "n/a")}</td></tr>
      <tr><td><b>Finalized at</b></td><td>${finishedAt}</td></tr>
    </table>
    <p style="color:#666;font-size:12px">Research prototype: this report contains intensity-derived values, not calibrated HbO₂/HbR concentrations.</p>
  `;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        html,
        attachments: [{
          filename: "nirs-session-processed.csv",
          content: Buffer.from(payload.csv, "utf8").toString("base64"),
        }],
      }),
    });
    const result = await response.json() as { id?: string; message?: string; name?: string };
    if (!response.ok) {
      return json(502, { error: result.message || "The email provider rejected the message. Check the sender domain and Resend settings." });
    }
    return json(200, { message: `Session report sent to ${recipient}.`, emailId: result.id });
  } catch {
    return json(502, { error: "Could not contact the email provider. Please retry or download the CSV instead." });
  }
};
