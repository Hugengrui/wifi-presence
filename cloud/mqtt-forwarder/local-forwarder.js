const mqtt = require("mqtt");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const MQTT_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const MQTT_TOPIC_STATE = process.env.MQTT_TOPIC_STATE || "wifi-presence/station/+/+/state";
const MQTT_TOPIC_ATTRS = process.env.MQTT_TOPIC_ATTRS || "wifi-presence/station/+/+/attrs";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const HTTP_ENDPOINT = process.env.HTTP_ENDPOINT || "http://4.194.30.85:8080/ingest";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const ATTRS_WAIT_MS = Number(process.env.ATTRS_WAIT_MS || 800);

const deviceCache = new Map();
const pendingAttrs = new Map();

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 3000,
  connectTimeout: 10000
});

function macFromTopic(topic) {
  const parts = topic.split("/");
  return (parts[3] || "").replace(/-/g, ":").toUpperCase();
}

function toStatus(payload) {
  if (payload === "connected") return "online";
  if (payload === "not_connected") return "offline";
  return "";
}

async function forwardPayload(payload) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json"
  };
  if (INGEST_TOKEN) {
    headers.Authorization = `Bearer ${INGEST_TOKEN}`;
  }
  const endpoint = new URL(HTTP_ENDPOINT);
  const client = endpoint.protocol === "https:" ? https : http;

  await new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
        path: `${endpoint.pathname}${endpoint.search}`,
        method: "POST",
        headers,
        timeout: 10000
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk.toString("utf8");
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(new Error(`HTTP ${res.statusCode} ${responseBody}`));
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function forwardState(topic, payload) {
  const mac = macFromTopic(topic);
  const status = toStatus(payload);
  if (!mac || !status) {
    return;
  }

  if (!deviceCache.has(mac) && ATTRS_WAIT_MS > 0) {
    await sleep(ATTRS_WAIT_MS);
  }

  const cached = deviceCache.get(mac) || pendingAttrs.get(mac) || {};
  const event = {
    device_name: cached.device_name || mac,
    mac,
    status
  };
  if (cached.ip) {
    event.ip = cached.ip;
  }
  if (cached.connected_at) {
    event.connected_at = cached.connected_at;
  }
  if (cached.disconnected_at) {
    event.disconnected_at = cached.disconnected_at;
  }
  if (typeof cached.connected_for === "number") {
    event.connected_for = cached.connected_for;
  }
  if (typeof cached.disconnected_for === "number") {
    event.disconnected_for = cached.disconnected_for;
  }
  if (cached.ap_name) {
    event.ap_name = cached.ap_name;
  }
  if (cached.ssid) {
    event.ssid = cached.ssid;
  }
  if (cached.bssid) {
    event.bssid = cached.bssid;
  }

  await forwardPayload(event);
  console.log(`[forward] ${mac} ${status} -> ${HTTP_ENDPOINT}`);
}

client.on("connect", () => {
  console.log(`[mqtt] connected to ${MQTT_URL}`);
  client.subscribe([MQTT_TOPIC_STATE, MQTT_TOPIC_ATTRS], { qos: 1 }, (error) => {
    if (error) {
      console.error("[mqtt] subscribe failed:", error.message);
      return;
    }
    console.log(`[mqtt] subscribed to ${MQTT_TOPIC_STATE}`);
    console.log(`[mqtt] subscribed to ${MQTT_TOPIC_ATTRS}`);
  });
});

client.on("reconnect", () => {
  console.log("[mqtt] reconnecting...");
});

client.on("error", (error) => {
  console.error("[mqtt] error:", error.message);
});

client.on("message", async (topic, payloadBuffer) => {
  const payload = payloadBuffer.toString("utf8");

  try {
    if (topic.endsWith("/attrs")) {
      const attrs = JSON.parse(payload);
      const mac = String(attrs.mac_address || macFromTopic(topic)).toUpperCase();
      if (!mac) {
        return;
      }
      const cached = {
        device_name: attrs.name || mac,
        ip: attrs.ip || "",
        connected_at: attrs.connected_at || "",
        disconnected_at: attrs.disconnected_at || "",
        connected_for: typeof attrs.connected_for === "number" ? attrs.connected_for : undefined,
        disconnected_for: typeof attrs.disconnected_for === "number" ? attrs.disconnected_for : undefined,
        ap_name: attrs.ap_name || "",
        ssid: attrs.ssid || "",
        bssid: attrs.bssid || ""
      };
      deviceCache.set(mac, cached);
      pendingAttrs.set(mac, cached);
      return;
    }

    if (topic.endsWith("/state")) {
      await forwardState(topic, payload.trim());
    }
  } catch (error) {
    console.error("[forward] failed:", error.message);
  }
});
