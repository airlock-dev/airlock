#!/bin/sh
set -eu

config="${AIRLOCK_CONFIG:-/config/airlock.yaml}"

has_config_arg() {
  for arg in "$@"; do
    case "$arg" in
      --config|-c|--config=*) return 0 ;;
    esac
  done
  return 1
}

if [ "$#" -eq 0 ]; then
  set -- --config "$config"
elif [ "${1#-}" != "$1" ]; then
  if ! has_config_arg "$@"; then
    set -- --config "$config" "$@"
  fi
elif [ "$1" = "run" ] || [ "$1" = "configure-web" ] || [ "$1" = "configure-agent" ]; then
  subcommand="$1"
  shift
  if ! has_config_arg "$@"; then
    set -- "$subcommand" --config "$config" "$@"
  else
    set -- "$subcommand" "$@"
  fi
fi

exec node /app/dist/index.js "$@"
