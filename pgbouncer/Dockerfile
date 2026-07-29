# Sidecar image: PgBouncer with our config baked in.
# Base image speaks the PostgreSQL wire protocol; Cloud Run reaches it
# only over localhost from the API container in the same service.
FROM edoburu/pgbouncer:latest

COPY pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
COPY userlist.txt /etc/pgbouncer/userlist.txt

EXPOSE 6432
