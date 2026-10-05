# Deployment

> **Verification status:** the server is tested locally (`npm run verify`) and CI builds and probes the
> Docker image. **Nothing has been deployed to a cluster.** The `k8s/` manifests are parsed and checked for
> internal consistency by `tests/config.test.ts`, not applied. Treat them as a starting point.

## Run locally

```bash
npm ci && npm run build
node dist/src/index.js                      # stdio (Claude Desktop)
PORT=3000 AUTH_TOKEN=change-me node dist/src/index.js   # HTTP
npm run verify                              # type-check, lint, tests, build, smoke, docker build if available
```

## Docker

```bash
docker build -t increadible .
docker run --rm -p 3000:3000 -e AUTH_TOKEN="$(openssl rand -hex 32)" increadible
curl localhost:3000/health
```

Config via env: `PORT` (3000), `HOST` (0.0.0.0 in the image, 127.0.0.1 otherwise), `AUTH_TOKEN`,
`RULES_FILE` (/data/rules.yaml), `EXPERIMENTS_FILE` (/data/experiments.yaml). Mount a volume at `/data`
to keep edited rules across restarts. A/B measurements are in memory only.

CI (`.github/workflows/ci-cd.yml`) builds the image, starts it, probes `/health`, `/metrics` (must be 401
without the token) and `/mcp`, and pushes `ghcr.io/nitro0dust-pixel/increadible:{latest,sha-<commit>}` on
pushes to `main`. The GHCR package is private by default; the cluster needs an image pull secret or the
package must be made public.

## Kubernetes (unverified)

```bash
kubectl -n increadible-staging create namespace increadible-staging --dry-run=client -o yaml | kubectl apply -f -
kubectl -n increadible-staging create secret generic increadible-secrets --from-literal=auth-token="$(openssl rand -hex 32)"
kubectl apply -f k8s/staging-deployment.yaml
kubectl -n increadible-staging rollout status deploy/increadible
kubectl -n increadible-staging port-forward svc/increadible 8080:80   # then curl localhost:8080/health
```

Production is the same with `k8s/production-deployment.yaml` and namespace `increadible`; pin the image to a
`sha-<commit>` tag. Design choices to be aware of:

- **One replica**, `Recreate` strategy: experiment data and stats are per-process memory. Do not add an HPA.
- **Rules are read-only** (ConfigMap mount): edit `increadible-config`, then `kubectl rollout restart`. The
  `update_rules` tool returns an error in this setup.
- **ClusterIP only**, protected by `AUTH_TOKEN`. There is no TLS or ingress; add one before exposing it.
- Health endpoints (`/health`, `/ready`) are unauthenticated for the kubelet; `/metrics` and `/mcp` need the token.

### Monitoring (optional, unverified)

`k8s/monitoring.yaml` needs the Prometheus Operator CRDs and kube-state-metrics, and applies to the `increadible`
namespace. Alerts use only metrics the server emits (`increadible_tool_calls_total`, `increadible_tool_errors_total`,
`increadible_rpc_errors_total`, `increadible_uptime_seconds`) plus kube-state-metrics restarts. There is no
dashboard, and no latency or cost metric exists yet.

## Rollback

`kubectl -n increadible rollout undo deploy/increadible`, or `kubectl set image` back to the previous `sha-` tag.
