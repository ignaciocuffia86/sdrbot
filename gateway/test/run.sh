#!/usr/bin/env bash
# Corre la batería del gateway contra servicios reales y locales:
#   - Dovecot (IMAP 11993 con TLS, 11143 con STARTTLS), con dos buzones de prueba
#   - Postgres 16 (base mailgw_test)
#   - SMTP: lo levanta cada prueba en proceso con smtp-server (TLS y STARTTLS)
# Todo con certificados de una CA propia que se genera acá y se le pasa a Node con
# NODE_EXTRA_CA_CERTS: el gateway valida certificados igual que en producción.
#
# Requiere: dovecot, openssl, Postgres 16 local (pg_ctlcluster) y correr como root.
set -euo pipefail
cd "$(dirname "$0")/.."
T="$PWD/test/.tmp"
command -v dovecot >/dev/null || { echo "Falta dovecot (apt-get install dovecot-imapd)"; exit 2; }
command -v openssl >/dev/null || { echo "Falta openssl"; exit 2; }

# Un Dovecot de una corrida anterior se detiene antes de borrar su directorio.
if [ -f "$T/dovecot.conf" ]; then dovecot -c "$T/dovecot.conf" stop 2>/dev/null || true; sleep 1; fi
rm -rf "$T" && mkdir -p "$T/run" "$T/mail"

# --- certificados: CA propia + certificado de servidor para localhost/127.0.0.1
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=mailgw-test-ca" \
  -keyout "$T/ca.key" -out "$T/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$T/server.key" -out "$T/server.csr" 2>/dev/null
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n" > "$T/san.ext"
openssl x509 -req -in "$T/server.csr" -CA "$T/ca.pem" -CAkey "$T/ca.key" -CAcreateserial \
  -days 2 -extfile "$T/san.ext" -out "$T/server.pem" 2>/dev/null

# --- Dovecot
id vmail >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin vmail
cat > "$T/users" <<USERS
ana@cliente.test:{PLAIN}clave-ana-1
beto@cliente.test:{PLAIN}clave-beto-2
USERS
chown -R vmail:vmail "$T/mail"
cat > "$T/dovecot.conf" <<CONF
base_dir = $T/run
log_path = $T/dovecot.log
protocols = imap
listen = 127.0.0.1
ssl = required
ssl_cert = <$T/server.pem
ssl_key = <$T/server.key
auth_mechanisms = plain login
first_valid_uid = 1
passdb {
  driver = passwd-file
  args = scheme=PLAIN username_format=%u $T/users
}
userdb {
  driver = static
  args = uid=vmail gid=vmail home=$T/mail/%d/%n
}
mail_location = maildir:~/Maildir
namespace inbox {
  inbox = yes
  separator = /
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
}
service imap-login {
  inet_listener imap {
    port = 11143
  }
  inet_listener imaps {
    port = 11993
    ssl = yes
  }
}
CONF
dovecot -c "$T/dovecot.conf"
trap 'dovecot -c "$T/dovecot.conf" stop 2>/dev/null || true' EXIT

# --- Postgres
pg_ctlcluster 16 main start 2>/dev/null || true
for i in $(seq 1 20); do su postgres -c "psql -qAtc 'select 1'" >/dev/null 2>&1 && break; sleep 0.5; done
# El dueño de la base es un usuario sin superusuario, con CREATEROLE: igual que postgres en
# Supabase. Con un superusuario las pruebas pasarían aunque los permisos del rol de la
# aplicación estuvieran mal, porque un superusuario puede tomar cualquier rol.
su postgres -c "psql -qc 'drop database if exists mailgw_test'" >/dev/null
su postgres -c "psql -qc 'drop role if exists mailgw_app'" >/dev/null
su postgres -c "psql -qc 'drop role if exists mailgw_portal'" >/dev/null
su postgres -c "psql -qc 'drop role if exists mailgw_owner'" >/dev/null
su postgres -c "psql -qc \"create role mailgw_owner login createrole nosuperuser password 'mailgw_owner'\"" >/dev/null
su postgres -c "psql -qc 'create database mailgw_test owner mailgw_owner'" >/dev/null

export DATABASE_URL="postgres://mailgw_owner:mailgw_owner@127.0.0.1:5432/mailgw_test"
export MAILGW_DB_SSL=off
# Dovecot y SMTP de prueba escuchan en 127.0.0.1 y puertos altos.
export MAILGW_ALLOW_PRIVATE_HOSTS=1
export MAILGW_ENC_KEYS="k2:$(openssl rand -base64 32),k1:$(openssl rand -base64 32)"
export NODE_EXTRA_CA_CERTS="$T/ca.pem"
export MAILGW_TEST_DIR="$T"

node bin/admin.mjs migrate
node --test --test-concurrency=1 test/*.test.mjs "$@"
