#/bin/bash
docker logs subgraph_graph-node_1 2>&1 | grep -A 10 -B 50 "WASM runtime thread terminated"

# If exit code is zero then grep found errors
if [ $? -eq 0 ]; then 
    exit 1
fi

echo "No WASM errors detected 🤙"
exit 0
