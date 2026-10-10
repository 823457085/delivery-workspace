#!/bin/sh
set -eu
install -d -m 750 -o root -g delivery-gateway /etc/delivery-remote/tls
install -m 640 -o root -g delivery-gateway /etc/letsencrypt/live/delivery-remote-ip/fullchain.pem /etc/delivery-remote/tls/fullchain.pem
install -m 640 -o root -g delivery-gateway /etc/letsencrypt/live/delivery-remote-ip/privkey.pem /etc/delivery-remote/tls/privkey.pem
if systemctl is-active --quiet delivery-remote.service; then systemctl reload delivery-remote.service; fi
