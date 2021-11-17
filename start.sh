#!/bin/bash
set -e
yarn run prepare:local
yarn run codegen
docker-compose down
# docker-compose pull
docker-compose up -d
echo "Sleeping 15 seconds for the graph to start..."
sleep 15
yarn run deploy:local