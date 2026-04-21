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
    received_at: new Date().toISOString()
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

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (error) {
    sendJson(res, 404, { error: "not_found", detail: error.message });
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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
  if (MQTT_URL) {
    console.log(`[mqtt] bridge mode enabled: ${MQTT_URL}`);
  } else {
    console.log("[mqtt] disabled; using HTTP ingest only");
  }
});
