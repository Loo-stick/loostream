#!/usr/bin/env python3
"""
Sidecar JA3 pour LooStream.

vidzy.cc (et seulement lui, pour l'instant) a déployé ~mi-octobre 2026 un
fingerprinting TLS : toute requête dont l'empreinte TLS n'est pas celle d'un
vrai navigateur reçoit un LEURRE (master HLS de 177 o qui boucle sur lui-même).
axios/Node, curl, httpx et donc MediaFlow tombent tous sur le leurre ; seule une
pile BoringSSL imitant Chrome (curl_cffi impersonate="chrome131") obtient le
vrai flux (master -> index-v1-a1.m3u8 -> segments .ts).

Ce service minimal fait UNE chose : relayer un GET vers *.vidzy.cc avec
l'empreinte Chrome, et renvoyer la réponse telle quelle (statut + content-type +
corps streamé). Le proxy Node (/proxy/manifest, /proxy/segment) continue de faire
tout le reste (réécriture du manifeste, SSRF/allowlist, clé d'accès) ; il délègue
juste le FETCH des URLs vidzy.cc à ce sidecar.

Durci :
  - auth par token partagé (JA3_TOKEN) -> pas un proxy ouvert ;
  - allowlist d'hôtes STRICTE (*.vidzy.cc) -> pas de SSRF / proxy ouvert ;
  - pas de port publié (réseau Docker interne uniquement, cf. docker-compose).
"""
import os
import sys
import socket
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from curl_cffi import requests as cffi_requests

TOKEN = os.environ.get("JA3_TOKEN", "")
PORT = int(os.environ.get("JA3_PORT", "8899"))
IMPERSONATE = os.environ.get("JA3_IMPERSONATE", "chrome131")
# Hôtes autorisés (suffixes). STRICT : on ne relaie que ça, jamais un hôte arbitraire.
ALLOWED_SUFFIXES = tuple(
    s.strip() for s in os.environ.get("JA3_ALLOWED_HOSTS", ".vidzy.cc,vidzy.cc").split(",") if s.strip()
)
CHUNK = 64 * 1024
# En-têtes de requête qu'on daigne transmettre à l'origine (le reste est ignoré).
FORWARD_REQ_HEADERS = {"referer", "origin", "user-agent", "range", "accept", "accept-language"}


def host_allowed(host: str) -> bool:
    h = (host or "").lower().split(":")[0]
    if not h:
        return False
    return any(h == suf or h.endswith(suf) if suf.startswith(".") else h == suf for suf in ALLOWED_SUFFIXES)


def host_is_public(host: str) -> bool:
    """Résout l'hôte et refuse toute IP privée/loopback (défense SSRF en plus de l'allowlist)."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
            return False
    return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # silencieux : le proxy Node loggue déjà

    def _deny(self, code: int, msg: str):
        body = msg.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self._deny(200, "ok")
        if parsed.path != "/f":
            return self._deny(404, "not found")

        q = parse_qs(parsed.query)
        if TOKEN and q.get("k", [""])[0] != TOKEN:
            return self._deny(403, "forbidden")

        target = unquote(q.get("url", [""])[0])
        if not target:
            return self._deny(400, "missing url")
        try:
            tp = urlparse(target)
        except ValueError:
            return self._deny(400, "bad url")
        if tp.scheme not in ("http", "https"):
            return self._deny(400, "bad scheme")
        if not host_allowed(tp.hostname or ""):
            return self._deny(403, "host not allowed")
        if not host_is_public(tp.hostname or ""):
            return self._deny(403, "non-public host")

        # En-têtes à transmettre : ceux passés en h_<nom> par le proxy Node.
        headers = {}
        for key, vals in q.items():
            if key.startswith("h_") and vals:
                name = key[2:]
                if name.lower() in FORWARD_REQ_HEADERS:
                    headers[name] = vals[0]

        try:
            r = cffi_requests.get(
                target,
                headers=headers,
                impersonate=IMPERSONATE,
                stream=True,
                timeout=20,
                allow_redirects=True,
            )
        except Exception as e:  # noqa: BLE001 — on renvoie une 502 propre au proxy
            return self._deny(502, f"fetch error: {e}")

        try:
            self.send_response(r.status_code)
            ct = r.headers.get("content-type")
            if ct:
                self.send_header("Content-Type", ct)
            cl = r.headers.get("content-length")
            if cl:
                self.send_header("Content-Length", cl)
            cr = r.headers.get("content-range")
            if cr:
                self.send_header("Content-Range", cr)
            ar = r.headers.get("accept-ranges")
            if ar:
                self.send_header("Accept-Ranges", ar)
            if not cl:
                # taille inconnue -> fermer la connexion en fin de corps
                self.send_header("Connection", "close")
            self.end_headers()
            for chunk in r.iter_content(chunk_size=CHUNK):
                if chunk:
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # le client (player) a coupé -> normal en HLS
        finally:
            try:
                r.close()
            except Exception:  # noqa: BLE001
                pass


def main():
    if not TOKEN:
        print("[ja3] ATTENTION: JA3_TOKEN vide -> auth désactivée", file=sys.stderr)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[ja3] écoute sur :{PORT} impersonate={IMPERSONATE} hosts={ALLOWED_SUFFIXES}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
