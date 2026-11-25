# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM docker:29.9.3-cli@sha256:5a7af0dcb0e46c803efe9b45371dd21cb500e5b4453250394ac6f06d49b6e6f1

# curl is needed by the raw-live reorg check (chain_getBlockHash).
# Pinned to the upstream version (`~`), not the Alpine package revision: the base's
# digest fixes the Alpine branch and its signing keys, and the branch keeps only the
# newest revision of each package, so an exact `=…-rN` pin stops building the day a
# security revision lands. A build that fails here means the branch moved a package
# to a new upstream version: review it and bump the pin.
RUN apk add --no-cache 'bash~5.3.9' 'coreutils~9.11' 'gawk~5.3.2' 'grep~3.12' 'curl~8.23.0'

WORKDIR /etc/hydration-neckwork

COPY docker-compose.yml /etc/hydration-neckwork/docker-compose.yml
COPY scripts/ingestion-supervisor.sh /usr/local/bin/ingestion-supervisor.sh

ENTRYPOINT ["bash"]
CMD ["/usr/local/bin/ingestion-supervisor.sh"]
