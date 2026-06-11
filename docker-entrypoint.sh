#!/bin/sh
set -eu

mkdir -p /data/uploads

if [ "$(id -u)" = "0" ]; then
  chown -R bun:bun /data
  exec su bun -s /bin/sh -c 'exec "$0" "$@"' "$@"
fi

exec "$@"
