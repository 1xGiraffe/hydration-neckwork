# Base images are pinned by version AND digest (AGENTS.md, Dependencies and supply chain):
# a floating tag pulls whatever was pushed last on every rebuild. Bump both deliberately.
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c

# curl is needed by the raw-live reorg check (chain_getBlockHash).
# Pinned to the upstream version (`~`), not the Alpine package revision: the base's
# digest fixes the Alpine branch and its signing keys, and the branch keeps only the
# newest revision of each package, so an exact `=…-rN` pin stops building the day a
# security revision lands. A build that fails here means the branch moved a package
# to a new upstream version: review it and bump the pin.
RUN apk add --no-cache 'bash~5.2.37' 'coreutils~9.5' 'gawk~5.3.1' 'grep~3.11' 'curl~8.14.1'

WORKDIR /etc/hydration-neckwork

COPY docker-compose.yml /etc/hydration-neckwork/docker-compose.yml
COPY scripts/ingestion-supervisor.sh /usr/local/bin/ingestion-supervisor.sh

ENTRYPOINT ["bash"]
CMD ["/usr/local/bin/ingestion-supervisor.sh"]
