#!/usr/bin/env bash
# Installs or upgrades the bundle on a regional host. Run as root from the unpacked bundle:
#   tar xzf slither.tar.gz && cd slither && sudo ./install.sh
#
# First run: creates the `slither` user, /opt/slither and example settings in /etc/slither,
# then stops so you can edit them. Later runs replace the binary and website and restart
# every enabled arena (which resets their in-memory worlds).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo ./install.sh)." >&2
  exit 1
fi

id slither >/dev/null 2>&1 || useradd --system --home /opt/slither --shell /usr/sbin/nologin slither

install -d -o root -g root -m 0755 /opt/slither /opt/slither/web
install -o root -g root -m 0755 "$here/slither-lite" /opt/slither/slither-lite.new
mv /opt/slither/slither-lite.new /opt/slither/slither-lite
rm -rf /opt/slither/web/dist.new
cp -R "$here/web/dist" /opt/slither/web/dist.new
rm -rf /opt/slither/web/dist
mv /opt/slither/web/dist.new /opt/slither/web/dist
chmod -R a+rX /opt/slither

install -o root -g root -m 0644 "$here/slither@.service" /etc/systemd/system/slither@.service
systemctl daemon-reload

install -d -o root -g root -m 0755 /etc/slither
first_run=false
if [[ ! -f /etc/slither/region.env ]]; then
  install -o root -g root -m 0644 "$here/region.env.example" /etc/slither/region.env
  first_run=true
fi
if [[ ! -f /etc/slither/paper.env ]]; then
  install -o root -g root -m 0644 "$here/paper.env.example" /etc/slither/paper.env
  first_run=true
fi

if $first_run; then
  cat <<'MSG'
Installed. Now edit /etc/slither/region.env (SLITHER_REGION, SLITHER_ALLOWED_ORIGINS)
and /etc/slither/paper.env if needed, then start the Paper arena:
  systemctl enable --now slither@paper
  curl -s 127.0.0.1:3001/config
MSG
  exit 0
fi

mapfile -t arenas < <(systemctl list-units --type=service --state=active --no-legend 'slither@*' | awk '{print $1}')
if ((${#arenas[@]} == 0)); then
  echo "Updated files. No arena is running; start one with: systemctl enable --now slither@paper"
  exit 0
fi
echo "Restarting ${arenas[*]} (their in-memory worlds reset)."
systemctl restart "${arenas[@]}"
