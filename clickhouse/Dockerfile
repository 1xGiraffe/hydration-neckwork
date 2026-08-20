FROM clickhouse/clickhouse-server:26.3.9.8
# System-log retention. Without this the stock image logs at `trace` with no
# TTL on any system table — measured at 461 GiB (74% of the server's footprint,
# ~6 GiB/day) against 158 GiB of actual data. See config.d/logging.xml.
COPY config.d/ /etc/clickhouse-server/config.d/
COPY schema/ /docker-entrypoint-initdb.d/
