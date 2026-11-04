"""Cliente del gateway IMAP/SMTP del SDR BOT para los scripts del box de Grok Bot.

Sólo biblioteca estándar: se copia al box con el repo y no necesita pip.

Uso como módulo:

    from mailgw import MailGateway, MailGatewayError
    gw = MailGateway()  # lee MAILGW_URL y MAILGW_TOKEN del entorno (secretos de la cuenta)
    r = gw.sync("ana@cliente.com", cursor=cursor_guardado, limit=25)
    for m in r["messages"]:
        ...
    guardar(r["cursor"])

Uso como comando (salida JSON en stdout; código 0 si salió bien, 3 si el gateway devolvió
un error con código, 4 si no se pudo hablar con el gateway):

    python3 mailgw.py mailboxes
    python3 mailgw.py sync --json '{"mailbox": "ana@cliente.com", "limit": 10}'
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

OPS = ("mailboxes", "check", "folders", "sync", "search", "read", "send", "reply",
       "draft", "flags", "move", "create_folder")


class MailGatewayError(Exception):
    def __init__(self, code, message, status=None, extra=None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


class MailGateway:
    def __init__(self, url=None, token=None, timeout=75):
        self.url = (url or os.environ.get("MAILGW_URL", "")).rstrip("/")
        self.token = token or os.environ.get("MAILGW_TOKEN", "")
        self.timeout = timeout
        if not self.url or not self.token:
            raise MailGatewayError("misconfigured", "Faltan MAILGW_URL y MAILGW_TOKEN.")

    def call(self, op, **args):
        if op not in OPS:
            raise MailGatewayError("invalid_request", f"Operación desconocida: {op}")
        body = json.dumps({k: v for k, v in args.items() if v is not None}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.url}/v1/{op}", data=body, method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                     "User-Agent": "sdrbot-mailgw-python/0.1"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except Exception:
                raise MailGatewayError("http_error", f"HTTP {e.code}", e.code) from None
            err = payload.get("error", {})
            extra = {k: v for k, v in err.items() if k not in ("code", "message")}
            raise MailGatewayError(err.get("code", "http_error"), err.get("message", ""), e.code, extra) from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise MailGatewayError("gateway_unreachable", str(e)) from None
        return payload["data"]

    def mailboxes(self):
        return self.call("mailboxes")

    def check(self, mailbox):
        return self.call("check", mailbox=mailbox)

    def folders(self, mailbox):
        return self.call("folders", mailbox=mailbox)

    def sync(self, mailbox, folder="INBOX", cursor=None, limit=25):
        return self.call("sync", mailbox=mailbox, folder=folder, cursor=cursor, limit=limit)

    def search(self, mailbox, folder="INBOX", **criteria):
        return self.call("search", mailbox=mailbox, folder=folder, **criteria)

    def read(self, mailbox, uid, folder="INBOX", mark_seen=False):
        return self.call("read", mailbox=mailbox, folder=folder, uid=uid, mark_seen=mark_seen)

    def send(self, mailbox, to, subject, idempotency_key, text=None, html=None, **extra):
        return self.call("send", mailbox=mailbox, to=to, subject=subject, text=text, html=html,
                         idempotency_key=idempotency_key, **extra)

    def reply(self, mailbox, uid, idempotency_key, text=None, html=None, folder="INBOX", **extra):
        return self.call("reply", mailbox=mailbox, folder=folder, uid=uid, text=text, html=html,
                         idempotency_key=idempotency_key, **extra)

    def draft(self, mailbox, **fields):
        return self.call("draft", mailbox=mailbox, **fields)

    def flags(self, mailbox, uids, add=None, remove=None, folder="INBOX"):
        return self.call("flags", mailbox=mailbox, folder=folder, uids=uids, add=add, remove=remove)

    def move(self, mailbox, uids, destination, folder="INBOX"):
        return self.call("move", mailbox=mailbox, folder=folder, uids=uids, destination=destination)

    def create_folder(self, mailbox, path):
        return self.call("create_folder", mailbox=mailbox, path=path)


def main(argv=None):
    p = argparse.ArgumentParser(description="Cliente del gateway IMAP/SMTP del SDR BOT")
    p.add_argument("op", choices=OPS)
    p.add_argument("--json", default="{}", help="argumentos de la operación, en JSON")
    a = p.parse_args(argv)
    try:
        args = json.loads(a.json)
        data = MailGateway().call(a.op, **args)
    except MailGatewayError as e:
        print(json.dumps({"error": {"code": e.code, "message": e.message, **e.extra}}, ensure_ascii=False))
        return 4 if e.code in ("gateway_unreachable", "misconfigured", "http_error") else 3
    except json.JSONDecodeError as e:
        print(json.dumps({"error": {"code": "invalid_request", "message": f"--json inválido: {e}"}}))
        return 3
    print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
