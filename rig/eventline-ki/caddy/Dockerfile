# Caddy mit Cloudflare-DNS-Modul: das Zertifikat für ki.in.eventline-basel.com
# kommt per DNS-01, weil der Rig aus dem Internet nicht erreichbar ist (und es
# auch nicht sein soll). Nur der Cloudflare-Token (caddy.env) geht nach draussen.
# Version festgenagelt (geprüfter Stand 2026-10-02); Builder und Laufzeit-Image gleich halten.
FROM caddy:2.11.4-builder AS b
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.11.4
COPY --from=b /usr/bin/caddy /usr/bin/caddy
