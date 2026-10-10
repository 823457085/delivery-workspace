#!/bin/sh
# 在已确认的空闲路径中安装独立运行时，不替换系统 Node，不触碰现有 443 服务。
set -eu
test ! -e /opt/delivery-remote
install -d -m 755 /opt/delivery-remote
cd /opt/delivery-remote
curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
test -n "$archive"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$archive"
awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -
tar -xJf "$archive"
ln -s "${archive%.tar.xz}" node
python3 -m venv /opt/delivery-remote/certbot
/opt/delivery-remote/certbot/bin/pip install --disable-pip-version-check 'certbot>=5.4,<6'
/opt/delivery-remote/node/bin/node --version
/opt/delivery-remote/certbot/bin/certbot --version
