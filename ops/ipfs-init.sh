#!/bin/sh
# Applied by the kubo image's entrypoint (/container-init.d) on EVERY start, after
# `ipfs init` and before the daemon: the whole forum IPFS node configuration, set
# idempotently, so the repo's config never drifts from this file (see the `ipfs`
# service in docker-compose.yml and AGENTS.md, Dependencies and supply chain).
#
# What this node is: the store of the governance forum's images. It serves only
# what it pins (the api serves /ipfs/<cid> for CIDs in forum_media alone), and it
# is never a public gateway, a relay for others, or a fetcher of other people's
# content on request.
set -eu

# RPC (full admin power) and gateway listen inside the container only; the ports are
# reachable on the compose networks the service joins (ipfs-internal: api, sync,
# backup) and never published on the host.
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080

# The gateway serves blocks already in the local repo only: an unknown CID is a
# miss, never a network fetch on a stranger's behalf.
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.PublicGateways '{}'
ipfs config --json Gateway.NoDNSLink true
ipfs config --json Gateway.ExposeRoutingAPI false

# Bounded resources (the container also has a memory limit).
ipfs config --json Swarm.ConnMgr '{"Type":"basic","LowWater":20,"HighWater":60,"GracePeriod":"30s"}'
ipfs config --json Swarm.ResourceMgr '{"Enabled":true,"MaxMemory":"512MB"}'
# The repo shares its disk with ClickHouse, so its ceiling is small and real: the
# daemon runs with --enable-gc (docker-compose.yml), which removes every block no pin
# holds once the repo passes StorageGCWatermark of StorageMax, and at least every
# GCPeriod; the sync also runs repo/gc after refusing or unpinning a CID. Forum images
# are a few MB a year, so 2 GB is generous.
ipfs config Datastore.StorageMax 2GB
ipfs config --json Datastore.StorageGCWatermark 80
ipfs config Datastore.GCPeriod 1h

# Never dial or announce private, LAN or docker addresses (the server profile's
# filters): this host's LAN and its docker bridges are no peer's business, and a
# public node must not probe them. mDNS (LAN discovery) is off for the same reason.
NONPUBLIC='["/ip4/10.0.0.0/ipcidr/8","/ip4/100.64.0.0/ipcidr/10","/ip4/169.254.0.0/ipcidr/16","/ip4/172.16.0.0/ipcidr/12","/ip4/192.0.0.0/ipcidr/24","/ip4/192.0.2.0/ipcidr/24","/ip4/192.168.0.0/ipcidr/16","/ip4/198.18.0.0/ipcidr/15","/ip4/198.51.100.0/ipcidr/24","/ip4/203.0.113.0/ipcidr/24","/ip4/240.0.0.0/ipcidr/4","/ip6/100::/ipcidr/64","/ip6/2001:2::/ipcidr/48","/ip6/2001:db8::/ipcidr/32","/ip6/fc00::/ipcidr/7","/ip6/fe80::/ipcidr/10"]'
ipfs config --json Swarm.AddrFilters "$NONPUBLIC"
# Loopback is never announced either (it is not filtered: nothing dials it).
ipfs config --json Addresses.NoAnnounce "$(printf '%s' "$NONPUBLIC" | sed 's#\]$#,"/ip4/127.0.0.0/ipcidr/8","/ip6/::1/ipcidr/128"]#')"
ipfs config --json Discovery.MDNS.Enabled false

# Never serve others: no relay service, no AutoNAT service for other peers.
ipfs config --json Swarm.RelayService '{"Enabled":false}'
ipfs config AutoNAT.ServiceMode disabled
# No UPnP/NAT-PMP probing of the host's router.
ipfs config --json Swarm.DisableNatPortMap true

if [ "${IPFS_ANNOUNCE:-true}" = "false" ]; then
  # Local-only: no DHT, no bootstrap peers, no providing. CIDs stay valid
  # identifiers; availability on the wider network is then the optional remote
  # pin's job.
  ipfs config Routing.Type none
  ipfs config --json Bootstrap '[]'
  ipfs config --json Provide.Enabled false
  ipfs config --json Swarm.RelayClient '{"Enabled":false}'
  echo "[ipfs-init] local-only (IPFS_ANNOUNCE=false)"
else
  # No inbound port is published (swarm 4001 stays inside the container), so the
  # node is reachable only over connections it opens: it joins the DHT as a client
  # (autoclient: it queries and PUBLISHES provider records, but serves no DHT
  # queries), announces what it pins, and uses circuit-relay reservations plus hole
  # punching so peers that look it up can still reach it behind the host's NAT.
  ipfs config Routing.Type autoclient
  ipfs config --json Bootstrap '["auto"]'
  ipfs config --json Provide.Enabled true
  ipfs config Provide.Strategy pinned
  ipfs config --json Swarm.RelayClient '{"Enabled":true}'
  ipfs config --json Swarm.EnableHolePunching true
  echo "[ipfs-init] announcing pinned CIDs over outbound connections"
fi
