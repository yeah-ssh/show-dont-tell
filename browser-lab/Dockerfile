# Hardened runner image for LAB_RUNNER=docker. Each repro run starts a throwaway container:
#   --network none --read-only --cap-drop ALL --security-opt no-new-privileges, memory/CPU/pid caps.
# Build from the repo root:  docker build -t browser-lab:latest -f browser-lab/Dockerfile .
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /lab
RUN npm init -y >/dev/null && npm install --no-audit --no-fund @playwright/test@1.63.0
COPY browser-lab/runner /lab/runner

USER pwuser
