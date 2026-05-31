#!/usr/bin/env bash
# =============================================================================
# Polkadex Explorer — fresh Ubuntu 24.04 LTS provision + deploy
# =============================================================================
#
# Run this on a CLEAN Ubuntu 24.04 LTS VPS. It hardens the OS, installs Docker,
# clones the explorer repo, issues a TLS cert, and starts the stack. Idempotent
# — safe to re-run.
#
# Usage:
#   # Add your SSH public key to authorized_keys MANUALLY first
#   # (the script disables SSH password auth and root login).
#   sudo bash provision-ubuntu.sh                # all phases except cloudflare
#   sudo bash provision-ubuntu.sh all+cf         # all phases including cloudflare
#
#   # Or just one phase at a time:
#   sudo bash provision-ubuntu.sh harden         # OS hardening only
#   sudo bash provision-ubuntu.sh docker         # Docker install only
#   sudo bash provision-ubuntu.sh app            # App deploy only
#   sudo bash provision-ubuntu.sh cloudflare     # Restrict 80/443 to Cloudflare ranges
#                                                # (run AFTER harden so UFW exists)
#
# Configuration (override via env or edit at top):
#   DOMAIN              = TLS domain to issue a cert for
#   LETSENCRYPT_EMAIL   = email Let's Encrypt notifies on cert events
#   REPO_URL            = git URL for the explorer source
#   DEPLOY_DIR          = where to clone the repo
#   SSH_PORT            = if you want SSH on a non-22 port
#   ALLOW_PASSWORD_SSH  = "no" (default) | "yes" (NOT recommended)
#
# Before running:
#   1. Make sure your SSH key is in /root/.ssh/authorized_keys OR in the
#      deploy user's ~/.ssh/authorized_keys. Otherwise you'll lock yourself out.
#   2. Set the DOMAIN to point at this server's public IP first (so certbot
#      can validate it via HTTP-01).
#
# What this script will NOT do:
#   * Auto-import data from the previous (compromised) host. That's deliberate.
#     If you skip the import, the new server simply re-indexes from the
#     Polkadex RPC; the gap-fill code backfills missing history automatically
#     (slower start, but provably clean state).
#     If you DO want to seed the new server from a backup, see step 3 of the
#     post-deploy notes below — you can safely drop the explorer.db file (the
#     SQLite index of public blockchain data) into /opt/pdexplorer/data/.
#     Don't copy anything else from the old host.
#   * Migrate any /etc, /opt, or ~/ configuration files from the old server.
#     Anything beyond the .db file has to be re-verified against an
#     authoritative source (this repo on git) before you trust it.
# =============================================================================

set -euo pipefail

# ---- Configuration ---------------------------------------------------------
DOMAIN="${DOMAIN:-explorer.polkadex.ee}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-vivek@polkadex.ee}"
REPO_URL="${REPO_URL:-https://github.com/polkadexaj/pdexscan.git}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pdexplorer}"
SSH_PORT="${SSH_PORT:-22}"
ALLOW_PASSWORD_SSH="${ALLOW_PASSWORD_SSH:-no}"

# ---- Helpers ---------------------------------------------------------------
log()  { printf '\n\033[1;34m[provision]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
    [ "$(id -u)" -eq 0 ] || die "Run as root or via sudo."
}

require_ubuntu() {
    [ -r /etc/os-release ] || die "/etc/os-release missing — is this Ubuntu?"
    # shellcheck disable=SC1091
    . /etc/os-release
    [ "$ID" = "ubuntu" ] || die "This script targets Ubuntu only (got: $ID)."
    case "$VERSION_ID" in
        22.04|24.04) ;;
        *) warn "Tested on Ubuntu 22.04/24.04. You're on $VERSION_ID — proceed with care." ;;
    esac
}

apt_quiet() {
    DEBIAN_FRONTEND=noninteractive apt-get -qq -o=Dpkg::Use-Pty=0 "$@"
}

# ---- Phase 1: OS hardening -------------------------------------------------
harden_system() {
    log "Phase 1/3: OS hardening"

    log "Updating package index + upgrading installed packages"
    apt_quiet update
    apt_quiet -y upgrade
    apt_quiet -y install ca-certificates curl gnupg lsb-release software-properties-common \
        ufw fail2ban unattended-upgrades apt-listchanges \
        chrony watchdog jq rsync

    log "Enabling unattended-upgrades for security patches"
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
EOF
    cat >/etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
    systemctl enable --now unattended-upgrades.service >/dev/null
    ok "unattended-upgrades enabled (security only, no auto-reboot)"

    log "Configuring SSH (keys only, no root password login)"
    install -d -m 0755 /etc/ssh/sshd_config.d
    cat >/etc/ssh/sshd_config.d/00-hardening.conf <<EOF
# Hardening drop-in — overrides the defaults in /etc/ssh/sshd_config.
Port $SSH_PORT
PermitRootLogin prohibit-password
PasswordAuthentication $ALLOW_PASSWORD_SSH
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
LoginGraceTime 30
AllowAgentForwarding no
AllowTcpForwarding no
EOF
    if ! sshd -t 2>/tmp/sshd-test.err; then
        cat /tmp/sshd-test.err >&2
        die "sshd config check failed — refusing to restart SSH"
    fi
    systemctl reload sshd
    ok "SSH locked down (port $SSH_PORT, key-only, no root password)"

    log "Configuring UFW firewall (allow $SSH_PORT, 80, 443; deny everything else)"
    ufw --force reset >/dev/null
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow "$SSH_PORT/tcp" comment 'SSH'
    ufw allow 80/tcp  comment 'HTTP — nginx + certbot HTTP-01'
    ufw allow 443/tcp comment 'HTTPS — nginx'
    ufw --force enable >/dev/null
    ok "UFW active: $(ufw status | head -1)"

    log "Configuring fail2ban (jail SSH + nginx-noscript-buffer-overflow)"
    cat >/etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 4
backend  = systemd

[sshd]
enabled = true
port    = $SSH_PORT

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
EOF
    systemctl enable --now fail2ban >/dev/null
    ok "fail2ban enabled"

    log "Enabling persistent journald (so post-mortem logs survive reboots)"
    install -d -m 2755 -g systemd-journal /var/log/journal
    install -d -m 0755 /etc/systemd/journald.conf.d
    cat >/etc/systemd/journald.conf.d/persistent.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=500M
RuntimeMaxUse=100M
ForwardToSyslog=no
EOF
    systemctl restart systemd-journald
    ok "Journals → /var/log/journal (500M cap)"

    log "Loading softdog kernel watchdog"
    if modprobe softdog 2>/dev/null; then
        echo softdog >/etc/modules-load.d/softdog.conf
        # Configure watchdog daemon to ping /dev/watchdog.
        sed -i 's|^#\?watchdog-device.*|watchdog-device = /dev/watchdog|' /etc/watchdog.conf
        sed -i 's|^#\?max-load-1.*|max-load-1 = 24|' /etc/watchdog.conf
        systemctl enable --now watchdog
        ok "softdog + watchdog daemon active"
    else
        warn "softdog module unavailable — skipping (ask your VPS provider to expose a hardware watchdog)"
    fi

    log "Hardening /etc/fstab (add nofail to non-root mounts)"
    # If /boot or swap is on a separate device, add nofail so a slow disk on
    # boot doesn't drop us into emergency mode.
    if grep -E '^\s*UUID=.*\s+/boot\s' /etc/fstab >/dev/null && ! grep -E '^\s*UUID=.*\s+/boot\s+.*nofail' /etc/fstab >/dev/null; then
        sed -ri 's|(^\s*UUID=[a-fA-F0-9-]+\s+/boot\s+\S+\s+)(\S+)|\1\2,nofail,x-systemd.device-timeout=10s|' /etc/fstab
        ok "/boot marked nofail"
    fi
    if grep -E '\s+swap\s+' /etc/fstab >/dev/null && ! grep -E '\s+swap\s+\S*nofail' /etc/fstab >/dev/null; then
        sed -ri 's|(^\s*UUID=[a-fA-F0-9-]+\s+none\s+swap\s+)(\S+)|\1\2,nofail,x-systemd.device-timeout=10s|' /etc/fstab
        ok "swap marked nofail"
    fi
    systemctl daemon-reload

    log "Configuring emergency.service to auto-resume after 60s"
    install -d -m 0755 /etc/systemd/system/emergency.service.d
    cat >/etc/systemd/system/emergency.service.d/auto-resume.conf <<'EOF'
[Service]
# If we land in emergency, give an operator a minute to react via console,
# then reboot. Combined with nofail in /etc/fstab + softdog, the second
# boot usually succeeds and the VM self-heals.
ExecStartPost=/bin/sh -c 'sleep 60; systemctl --no-block reboot'
EOF
    systemctl daemon-reload
    ok "emergency.target auto-resumes after 60s"

    log "Enabling time sync (chrony)"
    systemctl enable --now chrony >/dev/null
    ok "Time sync active"

    log "Hardening sysctl (network + kernel)"
    cat >/etc/sysctl.d/99-explorer-hardening.conf <<'EOF'
# Network stack hardening
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.log_martians = 1

# Kernel hardening
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
kernel.yama.ptrace_scope = 2
EOF
    sysctl --quiet --system >/dev/null || warn "sysctl reload had warnings"
    ok "sysctl hardening applied"

    log "Phase 1 complete."
}

# ---- Phase 2: Docker -------------------------------------------------------
install_docker() {
    log "Phase 2/3: Docker"

    if command -v docker >/dev/null 2>&1; then
        ok "Docker already installed: $(docker --version)"
    else
        log "Installing Docker CE + Compose plugin from the official apt repo"
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
            > /etc/apt/sources.list.d/docker.list
        apt_quiet update
        apt_quiet -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
        ok "Docker installed"
    fi

    log "Configuring Docker log rotation + safer defaults"
    install -d -m 0755 /etc/docker
    cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "100m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true,
  "userland-proxy": false,
  "icc": false
}
EOF
    systemctl enable --now docker >/dev/null
    systemctl restart docker
    ok "Docker daemon hardened (log rotation, no-new-privileges, ICC off)"

    log "Phase 2 complete."
}

# ---- Phase 3: App deploy ---------------------------------------------------
deploy_app() {
    log "Phase 3/3: Explorer deploy"

    [ -n "$DOMAIN" ] || die "DOMAIN is empty — refusing to deploy without a domain."
    [ -n "$LETSENCRYPT_EMAIL" ] || die "LETSENCRYPT_EMAIL is empty."

    log "Resolving $DOMAIN to confirm it points here"
    THIS_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.io || echo unknown)"
    DOMAIN_IP="$(dig +short "$DOMAIN" A | tail -1 || echo unknown)"
    if [ "$THIS_IP" != "unknown" ] && [ "$DOMAIN_IP" != "unknown" ] && [ "$THIS_IP" != "$DOMAIN_IP" ]; then
        warn "$DOMAIN currently resolves to $DOMAIN_IP, this server is $THIS_IP."
        warn "Certbot HTTP-01 will fail until DNS points here. Continuing anyway."
    fi

    log "Cloning fresh repo from $REPO_URL to $DEPLOY_DIR"
    if [ -d "$DEPLOY_DIR/.git" ]; then
        ok "$DEPLOY_DIR already exists — pulling latest"
        git -C "$DEPLOY_DIR" fetch --all --prune
        git -C "$DEPLOY_DIR" reset --hard origin/HEAD
    else
        install -d -m 0755 "$(dirname "$DEPLOY_DIR")"
        git clone --depth 1 "$REPO_URL" "$DEPLOY_DIR"
    fi
    cd "$DEPLOY_DIR"

    log "Preparing data directory (chown to uid 1000 for the rootless container)"
    # mkdir + chown rather than `install -o 1000 -g 1000` because on a fresh
    # cloud image there's usually no *named* user at uid 1000 yet, and some
    # `install` builds reject the numeric form with "invalid user: '1000'".
    # `chown 1000:1000` accepts a bare numeric id; the `+1000:+1000` fallback
    # forces the numeric interpretation on stricter chown variants.
    mkdir -p "$DEPLOY_DIR/data"
    chmod 0750 "$DEPLOY_DIR/data"
    chown 1000:1000 "$DEPLOY_DIR/data" 2>/dev/null \
        || chown '+1000:+1000' "$DEPLOY_DIR/data"
    install -d -m 0755 "$DEPLOY_DIR/certbot/conf"
    install -d -m 0755 "$DEPLOY_DIR/certbot/www"

    log "Writing .env (override DOMAIN / LETSENCRYPT_EMAIL via env or edit later)"
    if [ ! -f .env ]; then
        cat >.env <<EOF
# Generated by provision-ubuntu.sh. Edit and then:
#     docker compose up -d --build backend
# (rebuild is required for the new env to land in the running container).
# See .env.example for the full list of supported knobs.

# ---- TLS / certbot
DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL

# ---- Data path (host bind-mount → /app/data inside the backend container)
DATA_PATH=$DEPLOY_DIR/data

# ---- Chain RPC (comma-separated WS endpoints; first = primary)
POLKADEX_WS=wss://so.polkadex.ee

# ---- API
ALLOWED_ORIGINS=https://$DOMAIN
SITE_URL=https://$DOMAIN

# ---- Price feed (leave empty to disable). Get a free key at coinmarketcap.com.
CMC_API_KEY=

# ---- Indexer tuning (uncomment to raise per-tick batch sizes).
# Doubling these is safe with the current code — see README for guidance.
# BLOCKS_FORWARD_MAX=500
# BLOCKS_BACKFILL_CHUNK=200
# BLOCKS_GAP_FILL_CHUNK=100
# BLOCKS_FETCH_CONCURRENCY=8
# SYNC_BACKOFF_MS=60000
EOF
        chmod 0640 .env
        ok ".env created"
    else
        ok ".env already present (preserving)"
    fi

    log "Preparing TLS helper files (options-ssl-nginx.conf, ssl-dhparams.pem)"
    # nginx.conf `include`s these from /etc/letsencrypt/. If they're missing
    # nginx fails to start with "open() options-ssl-nginx.conf failed". They
    # are normally created by certbot the first time it runs — bootstrap them
    # here so nginx can come up before certbot has any cert at all.
    install -d certbot/conf
    if [ ! -s certbot/conf/options-ssl-nginx.conf ]; then
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
            -o certbot/conf/options-ssl-nginx.conf \
            || warn "Could not download options-ssl-nginx.conf; nginx may not start"
    fi
    if [ ! -s certbot/conf/ssl-dhparams.pem ]; then
        curl -fsSL https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
            -o certbot/conf/ssl-dhparams.pem \
            || warn "Could not download ssl-dhparams.pem; nginx may not start"
    fi

    log "Issuing Let's Encrypt cert for $DOMAIN (HTTP-01 challenge)"
    if [ ! -f "certbot/conf/live/$DOMAIN/fullchain.pem" ]; then
        if [ -x ./init-letsencrypt.sh ]; then
            ./init-letsencrypt.sh
            ok "Cert bootstrapped via init-letsencrypt.sh"
        else
            warn "init-letsencrypt.sh missing — issuing a self-signed placeholder so nginx can start."
            install -d "certbot/conf/live/$DOMAIN"
            openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
                -keyout "certbot/conf/live/$DOMAIN/privkey.pem" \
                -out "certbot/conf/live/$DOMAIN/fullchain.pem" \
                -subj "/CN=$DOMAIN" >/dev/null 2>&1
            warn "Replace with a real cert via certbot once the stack is up:"
            warn "  docker compose run --rm certbot certonly --webroot -w /var/www/certbot -d $DOMAIN -m $LETSENCRYPT_EMAIL --agree-tos --non-interactive"
            warn "  docker compose exec frontend nginx -s reload"
        fi
    else
        ok "Cert already present at certbot/conf/live/$DOMAIN/"
    fi

    log "Building + starting the explorer stack"
    docker compose down --remove-orphans || true
    docker compose pull --ignore-pull-failures || true
    docker compose up -d --build
    ok "Stack started"

    log "Health check"
    sleep 5
    if curl -fsS --max-time 10 "http://127.0.0.1/api/network-info" >/dev/null 2>&1; then
        ok "Backend reachable through nginx"
    else
        warn "Backend not yet responding through nginx — check 'docker compose logs backend frontend'"
    fi

    log "Cleaning up dangling images"
    docker image prune -f >/dev/null || true

    log "Phase 3 complete."
}

# ---- Phase 4 (optional): Cloudflare-only firewall --------------------------
# When the site is fronted by Cloudflare's proxy, only Cloudflare's edge nodes
# should be able to reach 80/443 on the origin. Direct hits to the VPS IP
# (bypassing Cloudflare's WAF / rate limits / DDoS protection) get dropped.
setup_cloudflare_only() {
    log "Phase 4: Cloudflare-only firewall"

    local cf_dir=/etc/cloudflare
    install -d -m 0755 "$cf_dir"

    log "Fetching Cloudflare IP ranges (https://www.cloudflare.com/ips-v4 and -v6)"
    curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v4 -o "$cf_dir/ips-v4" \
        || die "Could not fetch ips-v4 — aborting (host firewall would lock you out of port 80/443)."
    curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v6 -o "$cf_dir/ips-v6" \
        || die "Could not fetch ips-v6."
    ok "Got $(wc -l <"$cf_dir/ips-v4") IPv4 + $(wc -l <"$cf_dir/ips-v6") IPv6 ranges"

    log "Replacing generic UFW 80/443 rules with Cloudflare-only allow rules"
    # Strip any existing 80/443 rules (numbered, so iterate from the bottom up
    # to keep the rule numbers stable as we delete).
    ufw status numbered 2>/dev/null \
        | awk -F'[][]' '/(^\[ *[0-9]+\] +80|^\[ *[0-9]+\] +443)/ {print $2}' \
        | sort -rn \
        | while read -r n; do yes | ufw delete "$n" >/dev/null 2>&1 || true; done

    while IFS= read -r cidr; do
        [ -z "$cidr" ] && continue
        ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy' >/dev/null
        ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy' >/dev/null
    done < "$cf_dir/ips-v4"
    while IFS= read -r cidr; do
        [ -z "$cidr" ] && continue
        ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy v6' >/dev/null
        ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy v6' >/dev/null
    done < "$cf_dir/ips-v6"
    ufw reload >/dev/null
    ok "UFW 80/443 now restricted to Cloudflare ranges only"

    log "Installing weekly refresh systemd timer (Cloudflare publishes range changes occasionally)"
    cat >/usr/local/sbin/cloudflare-ufw-refresh <<'EOF'
#!/usr/bin/env bash
# Refresh UFW rules with Cloudflare's current IP ranges. Runs weekly via
# cloudflare-ufw-refresh.timer. Idempotent — no-op when ranges haven't changed.
set -euo pipefail
cf_dir=/etc/cloudflare
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v4 -o "$tmp/ips-v4"
curl -fsSL --max-time 15 https://www.cloudflare.com/ips-v6 -o "$tmp/ips-v6"
[ -s "$tmp/ips-v4" ] && [ -s "$tmp/ips-v6" ] || { echo "empty Cloudflare lists, refusing"; exit 1; }
if diff -q "$tmp/ips-v4" "$cf_dir/ips-v4" >/dev/null 2>&1 && \
   diff -q "$tmp/ips-v6" "$cf_dir/ips-v6" >/dev/null 2>&1; then
    exit 0   # no change
fi
# Drop old Cloudflare rules.
ufw status numbered 2>/dev/null \
    | awk -F'[][]' '/Cloudflare proxy/ {print $2}' \
    | sort -rn \
    | while read -r n; do yes | ufw delete "$n" >/dev/null 2>&1 || true; done
# Add new.
while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy' >/dev/null
    ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy' >/dev/null
done < "$tmp/ips-v4"
while IFS= read -r cidr; do
    [ -z "$cidr" ] && continue
    ufw allow proto tcp from "$cidr" to any port 80  comment 'Cloudflare proxy v6' >/dev/null
    ufw allow proto tcp from "$cidr" to any port 443 comment 'Cloudflare proxy v6' >/dev/null
done < "$tmp/ips-v6"
mv "$tmp/ips-v4" "$cf_dir/ips-v4"
mv "$tmp/ips-v6" "$cf_dir/ips-v6"
ufw reload >/dev/null
logger -t cloudflare-ufw-refresh "Updated UFW with new Cloudflare ranges"
EOF
    chmod +x /usr/local/sbin/cloudflare-ufw-refresh

    cat >/etc/systemd/system/cloudflare-ufw-refresh.service <<'EOF'
[Unit]
Description=Refresh UFW with current Cloudflare IP ranges
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cloudflare-ufw-refresh
EOF
    cat >/etc/systemd/system/cloudflare-ufw-refresh.timer <<'EOF'
[Unit]
Description=Weekly refresh of Cloudflare UFW rules

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now cloudflare-ufw-refresh.timer >/dev/null
    ok "Weekly refresh timer enabled (next run: $(systemctl show -p NextElapseUSecRealtime --value cloudflare-ufw-refresh.timer 2>/dev/null || echo unknown))"

    cat <<'EOF'

  Reminder — Cloudflare-related operational notes:

  * On Cloudflare's dashboard, the DNS record for this domain must be set to
    "Proxied" (orange cloud) for this firewall posture to make sense. If it
    is "DNS only" (grey cloud), the firewall will silently block all visitors.

  * Let's Encrypt HTTP-01 challenges will NOT work while CF proxy is enabled,
    because the challenge hits Cloudflare, not the origin. Three options:
      (a) Temporarily set the DNS record to "DNS only" while certbot runs.
      (b) Use DNS-01 challenge with the Cloudflare API plugin (recommended
          for production — survives renewals unattended).
      (c) Add a Page Rule that bypasses CF cache+proxy for
          /.well-known/acme-challenge/* (works but is fragile).

  * Cloudflare SSL mode should be "Full (Strict)" so CF validates the
    origin's TLS cert. Anything else either disables encryption between CF
    and origin, or accepts invalid certs.

EOF
}

# ---- Final summary ---------------------------------------------------------
summary() {
    cat <<EOF

============================================================================
  Provisioning summary
----------------------------------------------------------------------------
  Hostname        : $(hostname -f 2>/dev/null || hostname)
  Public IP       : $(curl -fsS https://api.ipify.org 2>/dev/null || echo unknown)
  SSH port        : $SSH_PORT  (key-only auth, root password login disabled)
  Firewall (UFW)  : $(ufw status | head -1 | awk '{print $2}')
  fail2ban        : $(systemctl is-active fail2ban)
  Watchdog        : $(systemctl is-active watchdog 2>/dev/null || echo n/a)
  Journal storage : $(grep -oP 'Storage=\K\S+' /etc/systemd/journald.conf.d/persistent.conf 2>/dev/null || echo volatile)
  Docker          : $(docker --version 2>/dev/null || echo not-installed)
  Domain          : $DOMAIN
  Deploy dir      : $DEPLOY_DIR
============================================================================

Next steps:
  1. SSH back in on port $SSH_PORT to confirm key-only auth works BEFORE
     closing this session.
  2. Set up an external uptime monitor on https://$DOMAIN/api/network-info
     (UptimeRobot / BetterStack free tier).
  3. If you bring data over from the old (compromised) box, copy ONLY
     ./data/explorer.db (and its -shm / -wal sidecars if present) — no
     other files, dotfiles, or scripts. The cleanest way is a snapshot
     taken via:  sqlite3 explorer.db ".backup explorer.bak.db"
     Verify ownership after copying:
       chown -R 1000:1000 $DEPLOY_DIR/data
  4. Watch the backend warm up:
       docker compose -f $DEPLOY_DIR/docker-compose.yml logs -f backend
  5. Confirm certificate is valid:
       curl -sI https://$DOMAIN | head -5

EOF
}

# ---- Entry point -----------------------------------------------------------
main() {
    require_root
    require_ubuntu
    case "${1:-all}" in
        harden)     harden_system ;;
        docker)     install_docker ;;
        app)        deploy_app ;;
        cloudflare) setup_cloudflare_only ;;
        all)        harden_system; install_docker; deploy_app ;;
        all+cf)     harden_system; install_docker; deploy_app; setup_cloudflare_only ;;
        *)          die "Usage: $0 [harden|docker|app|cloudflare|all|all+cf]" ;;
    esac
    summary
}

main "$@"
