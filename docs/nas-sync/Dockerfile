# EVENTLINE NAS-Sync — laeuft als kleiner Dauer-Container auf dem UGREEN
# (Docker-App in UGOS). Siehe README.md fuer die Einrichtung.
FROM node:22-alpine
WORKDIR /app
COPY sync.mjs .
CMD ["node", "sync.mjs"]
