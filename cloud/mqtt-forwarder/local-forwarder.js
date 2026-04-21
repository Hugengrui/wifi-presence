const mqtt = require("mqtt");

const MQTT_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:15057";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "wifi/events";
const MQTT_USERNAME = process.env.MQTT_USERNAME || "";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "";
const HTTP_ENDPOINT = process.env.HTTP_ENDPOINT || "http://4.194.30.85:8080/ingest";
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME || undefined,
  password: MQTT_PASSWORD || undefined,
  reconnectPeriod: 3000,
  connectTimeout: 10000
});

async function forwardPayload(payload) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (INGEST_TOKEN) {
    headers.Authorization = `Bearer ${INGEST_TOKEN}`;
  }

  const response = await fetch(HTTP_ENDPOINT, {
    method: "POST",
    headers,
    body: payload
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  }
}

client.on("connect", () => {
  console.log(`[mqtt] connected to ${MQTT_URL}`);
  client.subscribe(MQTT_TOPIC, { qos: 1 }, (error) => {
    if (error) {
      console.error("[mqtt] subscribe failed:", error.message);
      return;
    }
    console.log(`[mqtt] subscribed to ${MQTT_TOPIC}`);
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
    JSON.parse(payload);
    await forwardPayload(payload);
    console.log(`[forward] ${topic} -> ${HTTP_ENDPOINT}`);
  } catch (error) {
    console.error("[forward] failed:", error.message);
  }
});
