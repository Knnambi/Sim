#!/bin/sh
# Starts this node's someipy daemon (one per ECU) bound to the container's IP, then runs the app.
#   run_with_daemon.sh comfort_ecu.py [args...]
#   run_with_daemon.sh someip_provider.py --kuksa databroker:55555
set -e
IP="${SOMEIP_IP:-$(hostname -i | awk '{print $1}')}"
cat > /tmp/someipyd.json <<JSON
{"interface": "$IP", "log_level": "WARNING", "socket_path": "/tmp/someipyd.sock"}
JSON
python someipyd_patched.py --config /tmp/someipyd.json &
# Wait for the daemon socket before starting the application.
for _ in $(seq 1 50); do [ -S /tmp/someipyd.sock ] && break; sleep 0.1; done
APP="$1"; shift
exec python -u "$APP" --ip "$IP" "$@"
