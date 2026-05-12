const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");
const mqtt = require("mqtt");

const PORT = Number(process.env.PORT || 8080);
const MQTT_URL = process.env.MQTT_URL === undefined ? "mqtt://127.0.0.1:1883" : process.env.MQTT_URL.trim();
const MQTT_TOPIC = process.env.MQTT_TOPIC || "wifi/events";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const PUBLIC_DIR = path.join(__dirname, "public");
const MODE_PATH = path.join(LOG_DIR, "mode.json");
const EVENT_LOG_PATH = path.join(LOG_DIR, "events.jsonl");
const MAX_RECENT_EVENTS = 200;

fs.mkdirSync(LOG_DIR, { recursive: true });

function loadMode() {
  try {
    const raw = fs.readFileSync(MODE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.mode === "notify" ? "notify" : "log";
  } catch {
    return "notify";
  }
}

let forwardMode = loadMode();
let recentEvents = loadRecentEvents(EVENT_LOG_PATH, MAX_RECENT_EVENTS);
const sseClients = new Set();

function saveMode(mode) {
  forwardMode = mode === "notify" ? "notify" : "log";
  fs.writeFileSync(MODE_PATH, JSON.stringify({ mode: forwardMode }, null, 2));
}

function loadRecentEvents(filePath, limit) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendEvent(event) {
  const serialized = JSON.stringify(event);
  fs.appendFileSync(EVENT_LOG_PATH, `${serialized}\n`);
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents = recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

function processEvent(payload, source, topicOverride = "") {
  const normalized = normalizePayload(payload);
  if (!normalized) {
    return { ok: false, error: "invalid_payload" };
  }

  normalized.topic = topicOverride || MQTT_TOPIC;
  normalized.mode = forwardMode;
  normalized.source = source;
  appendEvent(normalized);
  broadcastSSE("event", normalized);
  console.log(`[event:${source}] ${normalized.message}`);
  return { ok: true, event: normalized };
}

function buildMessage(payload) {
  const deviceName = payload.device_name || "Unknown device";
  const mac = payload.mac || "unknown-mac";
  const ipPart = payload.ip ? ` - ${payload.ip}` : "";
  if (payload.status === "online") {
    return `设备上线：${deviceName} (${mac})${ipPart}`;
  }
  return `设备下线：${deviceName} (${mac})`;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.status !== "online" && payload.status !== "offline") return null;

  return {
    topic: MQTT_TOPIC,
    device_name: String(payload.device_name || "Unknown device"),
    mac: String(payload.mac || ""),
    ip: payload.ip ? String(payload.ip) : "",
    status: payload.status,
    message: buildMessage(payload),
    received_at: new Date().toISOString(),
    connected_at: payload.connected_at ? String(payload.connected_at) : "",
    disconnected_at: payload.disconnected_at ? String(payload.disconnected_at) : "",
    connected_for: typeof payload.connected_for === "number" ? payload.connected_for : null,
    disconnected_for: typeof payload.disconnected_for === "number" ? payload.disconnected_for : null,
    ap_name: payload.ap_name ? String(payload.ap_name) : "",
    ssid: payload.ssid ? String(payload.ssid) : "",
    bssid: payload.bssid ? String(payload.bssid) : ""
  };
}

function broadcastSSE(type, payload) {
  const body = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(body);
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = {};
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function readAccessToken(req, reqUrl) {
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const headerToken = req.headers["x-access-token"] || "";
  const queryToken = reqUrl.searchParams.get("token") || "";
  const cookieToken = parseCookies(req).access_token || "";
  return bearer || String(headerToken) || queryToken || cookieToken;
}

function sendLoginPage(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MQTT Forwarder Access</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(180deg, #faf7ef 0%, #f7f6f2 100%);
        color: #1f2937;
        font-family: "Helvetica Neue", "Noto Sans SC", sans-serif;
      }
      .card {
        width: min(420px, calc(100vw - 32px));
        background: #fffaf1;
        border: 1px solid #e5dccd;
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 10px 30px rgba(31, 41, 55, 0.08);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }
      p {
        color: #6b7280;
        line-height: 1.6;
        margin: 0 0 16px;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #d6cdbd;
        border-radius: 12px;
        padding: 12px 14px;
        font-size: 14px;
        margin-bottom: 12px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 12px;
        padding: 12px 14px;
        font-size: 14px;
        background: #155e75;
        color: white;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <form class="card" method="GET" action="/">
      <h1>访问受限</h1>
      <p>请输入访问 token。验证成功后，浏览器会记住本次访问。</p>
      <input name="token" type="password" placeholder="Access token" autocomplete="current-password" />
      <button type="submit">进入</button>
    </form>
  </body>
</html>`;

  res.writeHead(401, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function ensureAccess(req, res, reqUrl) {
  if (!ACCESS_TOKEN) return true;

  const token = readAccessToken(req, reqUrl);
  if (token === ACCESS_TOKEN) {
    if (reqUrl.searchParams.get("token") === ACCESS_TOKEN) {
      res.setHeader("Set-Cookie", `access_token=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      if (reqUrl.pathname === "/") {
        res.writeHead(302, { Location: "/" });
        res.end();
        return false;
      }
    }
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/") {
    sendLoginPage(res);
    return false;
  }

  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch (error) {
    sendJson(res, 404, { error: "not_found", detail: error.message });
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (reqUrl.pathname !== "/ingest" && !ensureAccess(req, res, reqUrl)) {
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/") {
    return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/status") {
    return sendJson(res, 200, {
      mode: forwardMode,
      mqtt: {
        url: MQTT_URL,
        topic: MQTT_TOPIC
      },
      recent_events: recentEvents
    });
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/mode") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (body.mode !== "notify" && body.mode !== "log") {
          return sendJson(res, 400, { error: "invalid_mode" });
        }
        saveMode(body.mode);
        broadcastSSE("mode", { mode: forwardMode });
        return sendJson(res, 200, { mode: forwardMode });
      } catch (error) {
        return sendJson(res, 400, { error: "invalid_json", detail: error.message });
      }
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/ingest") {
    if (INGEST_TOKEN) {
      const authHeader = req.headers.authorization || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (bearer !== INGEST_TOKEN) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        const result = processEvent(body, "http", "wifi/events");
        if (!result.ok) {
          return sendJson(res, 400, { error: result.error });
        }
        return sendJson(res, 200, { ok: true, event: result.event });
      } catch (error) {
        return sendJson(res, 400, { error: "invalid_json", detail: error.message });
      }
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`event: mode\ndata: ${JSON.stringify({ mode: forwardMode })}\n\n`);
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/logs") {
    return sendJson(res, 200, recentEvents);
  }

  sendJson(res, 404, { error: "not_found" });
});

if (MQTT_URL) {
  const mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USERNAME || undefined,
    password: MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
    connectTimeout: 10000
  });

  mqttClient.on("connect", () => {
    console.log(`[mqtt] connected to ${MQTT_URL}`);
    mqttClient.subscribe(MQTT_TOPIC, { qos: 1 }, (error) => {
      if (error) {
        console.error("[mqtt] subscribe failed:", error.message);
        return;
      }
      console.log(`[mqtt] subscribed to ${MQTT_TOPIC}`);
    });
  });

  mqttClient.on("reconnect", () => {
    console.log("[mqtt] reconnecting...");
  });

  mqttClient.on("error", (error) => {
    console.error("[mqtt] error:", error.message);
  });

  mqttClient.on("message", (topic, payloadBuffer) => {
    try {
      const payload = JSON.parse(payloadBuffer.toString("utf8"));
      const result = processEvent(payload, "mqtt", topic);
      if (!result.ok) {
        console.warn("[mqtt] ignored payload with invalid shape");
      }
    } catch (error) {
      console.error("[mqtt] invalid JSON payload:", error.message);
    }
  });
}

server.listen(PORT, () => {
  console.log(`[http] listening on :${PORT}`);
  console.log(`[mode] current mode: ${forwardMode}`);
  console.log(`[access] web access token ${ACCESS_TOKEN ? "enabled" : "disabled"}`);
  if (MQTT_URL) {
    console.log(`[mqtt] bridge mode enabled: ${MQTT_URL}`);
  } else {
    console.log("[mqtt] disabled; using HTTP ingest only");
  }
});
