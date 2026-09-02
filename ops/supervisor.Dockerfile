FROM docker:27-cli

# curl is needed by the raw-live reorg check (chain_getBlockHash)
RUN apk add --no-cache bash coreutils gawk grep curl

WORKDIR /etc/hydration-neckwork

COPY docker-compose.yml /etc/hydration-neckwork/docker-compose.yml
COPY scripts/ingestion-supervisor.sh /usr/local/bin/ingestion-supervisor.sh

ENTRYPOINT ["bash"]
CMD ["/usr/local/bin/ingestion-supervisor.sh"]
