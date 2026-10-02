#!/usr/bin/env bash
# Phone access to hive over Tailscale + SSH (+ tmux, so sessions survive dropped connections).
# For Ubuntu/Debian (a home server or VPS) and Fedora. Run as your normal user; it uses sudo.
#
#   bash scripts/setup-remote.sh                       # Tailscale, OpenSSH, tmux, hive-tui helper
#   bash scripts/setup-remote.sh --project ~/code/app  # which project `hive-tui` opens
#   bash scripts/setup-remote.sh --ssh-only-tailscale  # also: SSH reachable only over Tailscale
#   bash scripts/setup-remote.sh --discord             # also: systemd service for the Discord bridge
#   bash scripts/setup-remote.sh --daemon              # also: keep the project's hive running (docs/CLOUD.md)
#   bash scripts/setup-remote.sh --web                 # also: hive web as a service + tailscale serve (docs/MOBILE.md)
#   bash scripts/setup-remote.sh --dry-run             # print what it would do
#
# Nothing here opens a port on your router. hive itself still listens on nothing.
set -euo pipefail

PROJECT="${HOME}/code"
ME="${USER:-$(id -un)}"
LOCK=0
DISCORD=0
DAEMON=0
WEB=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      if [ $# -lt 2 ] || [ -z "$2" ]; then echo "usage: --project DIR (the project hive-tui opens)" >&2; exit 2; fi
      PROJECT="$2"; shift 2 ;;
    --ssh-only-tailscale) LOCK=1; shift ;;
    --discord) DISCORD=1; shift ;;
    --daemon) DAEMON=1; shift ;;
    --web) WEB=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# absolute, so the systemd unit's WorkingDirectory= and the helper work from anywhere
if [ -d "$PROJECT" ]; then PROJECT="$(cd "$PROJECT" && pwd)"; else case "$PROJECT" in /*) ;; *) PROJECT="$PWD/$PROJECT" ;; esac; fi

run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else echo "+ $*"; "$@"; fi; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

. /etc/os-release 2>/dev/null || true
case "${ID:-} ${ID_LIKE:-}" in
  *fedora*|*rhel*) PM=dnf; SSH_PKG=openssh-server; SSH_UNIT=sshd ;;
  *debian*|*ubuntu*) PM=apt; SSH_PKG=openssh-server; SSH_UNIT=ssh ;;
  *) echo "Only Ubuntu/Debian and Fedora are scripted; see docs/REMOTE.md for the manual steps." >&2; exit 1 ;;
esac

say "1/5 packages: OpenSSH server, tmux, curl"
PKGS=("$SSH_PKG" tmux)
# Fedora minimal ships curl-minimal, which conflicts with installing curl: only add it when missing.
have curl || PKGS+=(curl)
if [ "$PM" = apt ]; then
  run sudo apt-get update -q
  run sudo apt-get install -y "${PKGS[@]}"
else
  run sudo dnf install -y "${PKGS[@]}"
fi
run sudo systemctl enable --now "$SSH_UNIT"

say "2/5 Tailscale"
if have tailscale; then
  echo "tailscale already installed: $(tailscale version | head -1)"
else
  # Tailscale's official installer (adds their package repo for your distro)
  if [ "$DRY" = 1 ]; then echo "+ curl -fsSL https://tailscale.com/install.sh | sh"; else curl -fsSL https://tailscale.com/install.sh | sh; fi
fi
run sudo systemctl enable --now tailscaled
if [ "$DRY" = 1 ] || ! tailscale status >/dev/null 2>&1; then
  echo "Log this machine into your tailnet (a browser link appears; use the same account as the phone app):"
  run sudo tailscale up
fi

say "3/5 SSH keys"
if [ "$DRY" != 1 ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
fi
if [ -s "$HOME/.ssh/authorized_keys" ]; then
  echo "authorized_keys has $(grep -c . "$HOME/.ssh/authorized_keys") key(s)."
else
  echo "No keys yet. In Termius: Keychain → Generate key → Export to host, or paste its public key into ~/.ssh/authorized_keys."
  echo "Until then you can log in with your password over Tailscale."
fi

if [ "$LOCK" = 1 ]; then
  say "4/5 SSH only over Tailscale"
  if [ ! -s "$HOME/.ssh/authorized_keys" ]; then
    echo "Skipped: add a key to ~/.ssh/authorized_keys first, so you can't lock yourself out." >&2
  elif have ufw; then
    # Existing "allow OpenSSH" / "allow 22" rules would match before the deny and keep SSH open everywhere.
    for r in OpenSSH ssh 22/tcp 22; do run sudo ufw delete allow "$r" || true; done
    # The Tailscale allow goes first (insert fails on an empty rule list, then a plain allow is first anyway).
    run sudo ufw insert 1 allow in on tailscale0 to any port 22 proto tcp || run sudo ufw allow in on tailscale0 to any port 22 proto tcp
    run sudo ufw deny 22/tcp
    run sudo ufw --force enable
  elif have firewall-cmd; then
    run sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
    # ssh can be open as a service or as a plain port, in the default zone or in public
    for z in $(firewall-cmd --get-default-zone 2>/dev/null || true) public; do
      run sudo firewall-cmd --permanent --zone="$z" --remove-service=ssh || true
      run sudo firewall-cmd --permanent --zone="$z" --remove-port=22/tcp || true
    done
    run sudo firewall-cmd --reload
  else
    echo "No ufw/firewalld found; restrict port 22 to the tailscale0 interface in your firewall." >&2
  fi
  # keys only, no passwords
  if [ -s "$HOME/.ssh/authorized_keys" ]; then
    run sudo mkdir -p /etc/ssh/sshd_config.d
    if [ "$DRY" = 1 ]; then echo "+ write /etc/ssh/sshd_config.d/10-hive.conf (PasswordAuthentication no)"; else
      printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-hive.conf >/dev/null
    fi
    run sudo systemctl reload "$SSH_UNIT"
  fi
else
  say "4/5 firewall: unchanged (add --ssh-only-tailscale to allow SSH only over Tailscale)"
fi

say "5/5 hive-tui helper and tmux settings"
[ "$DRY" = 1 ] || mkdir -p "$HOME/.local/bin"
HELPER="$HOME/.local/bin/hive-tui"
if [ "$DRY" = 1 ]; then echo "+ write $HELPER"; else
  cat >"$HELPER" <<EOF
#!/usr/bin/env bash
# Attach to the running hive session, or start one (agents keep running when you disconnect).
cd "\${1:-$PROJECT}" || exit 1
exec tmux new-session -A -s hive "hive tui"
EOF
  chmod +x "$HELPER"
fi
if [ "$DRY" = 1 ]; then echo "+ append mouse/scrollback settings to ~/.tmux.conf"; elif ! grep -q "# hive" "$HOME/.tmux.conf" 2>/dev/null; then
  printf '\n# hive: touch scrolling, more history, no Esc delay (Esc cancels a turn)\nset -g mouse on\nset -g history-limit 20000\nset -sg escape-time 10\n' >>"$HOME/.tmux.conf"
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to PATH (e.g. in ~/.bashrc): export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac

if [ "$DAEMON" = 1 ]; then
  say "hive daemon service for $PROJECT"
  # one unit per project; the desktop app and phones attach to it over SSH (hive ui --remote / hive attach)
  SLUG="$(basename "$PROJECT" | tr -c 'A-Za-z0-9_.-' '_' | sed 's/_*$//')"
  DUNIT="/etc/systemd/system/hive-daemon-${SLUG}.service"
  HIVE_CMD="$(command -v hive || echo "$(command -v node) $HOME/hive/dist/cli/index.js")"
  if [ "$DRY" = 1 ]; then echo "+ write $DUNIT"; else
    sudo tee "$DUNIT" >/dev/null <<EOF
[Unit]
Description=hive for $PROJECT
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$PROJECT
EnvironmentFile=-$HOME/hive.env
ExecStart=$HIVE_CMD daemon --cwd $PROJECT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  fi
  run sudo systemctl daemon-reload
  run sudo systemctl enable --now "hive-daemon-${SLUG}"
  echo "Connect from the desktop: hive ui --remote $ME@<this machine> --remote-cwd $PROJECT"
fi

if [ "$WEB" = 1 ]; then
  say "hive web service for $PROJECT (phone browser / Android app)"
  # listens on 127.0.0.1:7777 only; tailscale serve publishes it over HTTPS to your tailnet (nobody else)
  SLUG="$(basename "$PROJECT" | tr -c 'A-Za-z0-9_.-' '_' | sed 's/_*$//')"
  WUNIT="/etc/systemd/system/hive-web-${SLUG}.service"
  HIVE_CMD="$(command -v hive || echo "$(command -v node) $HOME/hive/dist/cli/index.js")"
  if [ "$DRY" = 1 ]; then echo "+ write $WUNIT"; else
    sudo tee "$WUNIT" >/dev/null <<EOF
[Unit]
Description=hive web for $PROJECT
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$PROJECT
EnvironmentFile=-$HOME/hive.env
ExecStart=$HIVE_CMD web --cwd $PROJECT --port 7777
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  fi
  run sudo systemctl daemon-reload
  run sudo systemctl enable --now "hive-web-${SLUG}"
  run sudo tailscale serve --bg 7777
  echo "The address with its key: sudo journalctl -u hive-web-${SLUG} | grep 'on your phone'"
  echo "Open it in Chrome on the phone, or paste it into the hive Android app. docs/MOBILE.md"
fi

if [ "$DISCORD" = 1 ]; then
  say "Discord bridge service"
  ENVF="$HOME/hive.env"
  if [ ! -f "$ENVF" ]; then
    if [ "$DRY" = 1 ]; then echo "+ write $ENVF (template)"; else
      printf '# chmod 600. See docs/BRIDGES.md for creating the bot.\nHIVE_DISCORD_TOKEN=\nHIVE_DISCORD_ALLOW=\n' >"$ENVF"
      chmod 600 "$ENVF"
    fi
  fi
  HIVE_BIN="$(command -v hive || echo "$HOME/hive/dist/cli/index.js")"
  UNIT=/etc/systemd/system/hive-bridge.service
  if [ "$DRY" = 1 ]; then echo "+ write $UNIT"; else
    sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=hive (jobs + Discord bridge)
After=network-online.target
Wants=network-online.target

[Service]
User=$ME
WorkingDirectory=$PROJECT
EnvironmentFile=$ENVF
ExecStart=$(command -v node) $HIVE_BIN serve --bridge discord --cwd $PROJECT
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  fi
  run sudo systemctl daemon-reload
  echo "Fill in $ENVF (bot token + your Discord user id), then: sudo systemctl enable --now hive-bridge"
  echo "Note: run either the bridge service or hive-tui on a project, not both at once on the same project."
fi

say "Done"
NAME="$(tailscale status --self --peers=false 2>/dev/null | awk 'NR==1{print $2}' || true)"
IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
echo "On your phone: Tailscale app (same account) → Termius → new host ${NAME:-<this machine>} (${IP:-100.x.y.z}), user $ME."
echo "Then run: hive-tui        (detach: Ctrl+B then D · reattach: hive-tui)"
