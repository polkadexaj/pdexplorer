#!/bin/bash

# Source variables from .env
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
else
  echo "Error: .env file missing. Cannot proceed."
  exit 1
fi

# Accept either DOMAIN (preferred, matches docker-compose convention and
# provision-ubuntu.sh) or the legacy DOMAIN_NAME from earlier .env files.
DOMAIN_VALUE="${DOMAIN:-${DOMAIN_NAME:-}}"
if [ -z "$DOMAIN_VALUE" ]; then
  echo "Error: neither DOMAIN nor DOMAIN_NAME is set in .env."
  exit 1
fi
domains=($DOMAIN_VALUE)
rsa_key_size=4096
data_path="./certbot"
email="$LETSENCRYPT_EMAIL" # Adding a valid address is strongly recommended
staging=0 # Set to 1 if you're testing your setup to avoid hitting request limits

if [ -d "$data_path" ]; then
  read -p "Existing data found for $domains. Continue and replace existing certificate? (y/N) " decision
  if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
    exit
  fi
fi

if [ ! -e "$data_path/conf/options-ssl-nginx.conf" ] || [ ! -e "$data_path/conf/ssl-dhparams.pem" ]; then
  echo "### Downloading recommended TLS parameters ..."
  mkdir -p "$data_path/conf"
  curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf > "$data_path/conf/options-ssl-nginx.conf"
  curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem > "$data_path/conf/ssl-dhparams.pem"
  echo
fi

DC=$(command -v docker-compose || echo "docker-compose")

echo "### Creating Self-Signed certificate for $domains ..."
path="/etc/letsencrypt/live/$domains"
mkdir -p "$data_path/conf/live/$domains"

sudo $DC run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 365\
    -keyout '$path/privkey.pem' \
    -out '$path/fullchain.pem' \
    -subj '/CN=$domains'" certbot
echo

echo "### Self-Signed Certificate Generated!"
echo "Note: Your browser will display a security warning because this is a self-signed certificate."
echo
