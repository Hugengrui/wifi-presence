#!/usr/bin/env bash
set -euo pipefail

sudo rm -rf /opt/mqtt-forwarder
sudo mkdir -p /opt/mqtt-forwarder
sudo tar -xzf /tmp/mqtt-forwarder.tar.gz -C /opt

if [ ! -f /etc/mqtt-forwarder.env ]; then
  sudo cp /opt/mqtt-forwarder/.env.example /etc/mqtt-forwarder.env
fi

sudo sed -i \
  -e 's#^PORT=.*#PORT=8080#' \
  -e 's#^MQTT_URL=.*#MQTT_URL=mqtt://127.0.0.1:1883#' \
  -e 's#^LOG_DIR=.*#LOG_DIR=/opt/mqtt-forwarder/logs#' \
  /etc/mqtt-forwarder.env

cd /opt/mqtt-forwarder
sudo npm install --omit=dev

sudo mkdir -p /opt/mqtt-forwarder/logs
sudo chown -R www-data:www-data /opt/mqtt-forwarder
sudo chown root:root /etc/mqtt-forwarder.env
sudo chmod 640 /etc/mqtt-forwarder.env

sudo cp /opt/mqtt-forwarder/mqtt-forwarder.service /etc/systemd/system/mqtt-forwarder.service
sudo systemctl daemon-reload
sudo systemctl enable --now mqtt-forwarder
sudo systemctl --no-pager --full status mqtt-forwarder | sed -n '1,30p'
