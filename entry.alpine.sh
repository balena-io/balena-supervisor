#!/bin/sh

set -e

[ -d /dev/net ] ||
    mkdir -p /dev/net
[ -c /dev/net/tun ] ||
    mknod /dev/net/tun c 10 200

mkdir -p /var/log/supervisor && touch /var/log/supervisor/supervisord.log
mkdir -p /var/run/resin
mount -t tmpfs -o size=1m tmpfs /var/run/resin

if [ -z "$GOSUPER_SOCKET" ]; then
	export GOSUPER_SOCKET=/var/run/resin/gosuper.sock
fi
if [ -z "$DOCKER_SOCKET" ]; then
	export DOCKER_SOCKET=/run/docker.sock
fi
if [ -z "$HOST_PROC" ]; then
	export HOST_PROC=/mnt/root/proc
fi

export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/mnt/root/run/dbus/system_bus_socket"

/usr/bin/supervisord -c /etc/supervisor/supervisord.conf

supervisorctl -c /etc/supervisor/supervisord.conf start resin-supervisor
supervisorctl -c /etc/supervisor/supervisord.conf start go-supervisor

tail -f /var/log/supervisor/supervisord.log
