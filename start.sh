#!/bin/bash
set -e
export NETWORK_NAME="arbitrum"
export RPC_URL="http://host.docker.internal:8545"
yarn run prepare:local
yarn run codegen
docker-compose down
# docker-compose pull
docker-compose up -d
echo "Sleeping 15 seconds for the graph to start..."
sleep 25
yarn run deploy:local