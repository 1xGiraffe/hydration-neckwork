FROM clickhouse/clickhouse-server:26.3.9.8
# System-log retention. Without this the stock image logs at `trace` with no
# TTL on any system table — measured at 461 GiB (74% of the server's footprint,
# ~6 GiB/day) against 158 GiB of actual data. See config.d/logging.xml.
COPY config.d/ /etc/clickhouse-server/config.d/
# Retention is a config.d concern; whether a log is WRITTEN at all is a settings
# profile, which only takes effect from users.d. See users.d/profile-logging.xml.
COPY users.d/ /etc/clickhouse-server/users.d/
# The schema is deliberately NOT baked in. `schema-bootstrap` is its single
# applier, and every service that touches price_data gates on that job; a copy
# under docker-entrypoint-initdb.d would race it on a fresh volume, and would
# also force a ClickHouse image rebuild on every schema edit.
