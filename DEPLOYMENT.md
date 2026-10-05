# Deployment

> **Verification status:** the server is tested locally (`npm run verify`) and CI builds and probes the
> Docker image. **Nothing has been deployed to a real environment.** `k8s/staging-deployment.yaml` has been applied once
> to a local Docker Desktop cluster with a locally built image (rollout, auth, ConfigMap rules and A/B persistence across
> `rollout restart` all checked). The production and monitoring manifests have only been parsed and checked for internal
> consistency by `tests/config.test.ts`, and the GHCR pull path is untested. Treat them as a starting point.

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
`RULES_FILE` (/data/rules.yaml), `EXPERIMENTS_FILE` (/data/experiments.yaml), `AB_DATA_FILE`
(/data/ab-data.jsonl). Mount a volume at `/data` to keep edited rules and A/B data across container restarts
(`docker run -v increadible-data:/data ...`). Without a volume, A/B data is lost when the container is removed.

CI (`.github/workflows/ci-cd.yml`) builds the image, starts it, probes `/health`, `/metrics` (must be 401
without the token) and `/mcp`, and pushes `ghcr.io/nitro0dust-pixel/increadible:{latest,sha-<commit>}` on
pushes to `main`. The GHCR package is private by default; the cluster needs an image pull secret or the
package must be made public.

After each push to `main`, a second job (`verify-published-image`) logs in to GHCR, checks that `:latest` and
`:sha-<commit>` both resolve to the digest that was just pushed, pulls the image **by that digest**, and runs
the same probe (`scripts/probe-image.sh`) against the pulled copy: non-root user, command, architecture, HTTP and
auth behavior, A/B data surviving a container restart on a volume, and Docker's `HEALTHCHECK` reporting healthy.
You can run the probe yourself against any image with `bash scripts/probe-image.sh <image-ref>` (needs Docker, curl and jq).

## Kubernetes (staging verified locally only)

Run this from a machine whose `kubectl` points at the cluster you intend (check `kubectl config current-context`).
Do it in staging first.

```bash
NS=increadible-staging
kubectl create namespace "$NS"
kubectl -n "$NS" create secret generic increadible-secrets --from-literal=auth-token="$(openssl rand -hex 32)"
# Only while the GHCR package is private (see "Pulling a private image" below):
kubectl -n "$NS" create secret docker-registry ghcr-pull --docker-server=ghcr.io \
  --docker-username=<github-user> --docker-password=<token-with-read:packages>
kubectl apply -f k8s/staging-deployment.yaml
# Pin the exact image CI verified instead of the moving :latest tag:
kubectl -n "$NS" set image deploy/increadible increadible=ghcr.io/nitro0dust-pixel/increadible@sha256:<digest>
kubectl -n "$NS" rollout status deploy/increadible
kubectl -n "$NS" port-forward svc/increadible 8080:80   # then: curl localhost:8080/health
```

Take `<digest>` from the `verify-published-image` job log (`DIGEST`), or from
`docker buildx imagetools inspect ghcr.io/nitro0dust-pixel/increadible:sha-<commit> --format '{{json .Manifest}}' | jq -r .digest`.
Pinning by digest matters: production uses `imagePullPolicy: IfNotPresent`, so a rollout that still says `:latest` would
never pick up a newer image.

To check that A/B data really persists on the cluster, call `create_experiment` and `record_metric` through
`POST /mcp` (bearer token = the `auth-token` secret), run `kubectl -n "$NS" rollout restart deploy/increadible`, and
confirm `get_experiment_results` still returns the data.

### Pulling a private image

The manifests list an optional `imagePullSecrets: [{name: ghcr-pull}]`. While the GHCR package is private, the cluster
needs that secret or the pod stays in `ImagePullBackOff`:

- Create it as shown above, with a GitHub token that can read packages (`read:packages`; check GitHub's current
  documentation for which token types GHCR accepts) and your GitHub username. Use a dedicated token with nothing else
  enabled, and set an expiry.
- `ghcr-pull` is namespaced, so create it in every namespace you deploy to (`increadible-staging`, `increadible`).
- If the secret does not exist, Kubernetes still starts the pod and attempts an anonymous pull (a warning event is
  recorded), so the same manifests work unchanged once the package is made public. Making it public is the alternative to
  keeping a pull secret: GitHub package settings, "Change visibility". That is a deliberate decision, since anyone could
  then pull the image.
- Rotate the token by deleting and recreating the secret; running pods are not affected until they next pull.
- Check the result with `kubectl -n "$NS" describe pod -l app=increadible` (look at the Events for pull errors).

Production is the same with `k8s/production-deployment.yaml` and namespace `increadible`, pinned to a digest the same
way. Design choices to be aware of:

- **One replica**, `Recreate` strategy: A/B data is appended to a file on a 1Gi `ReadWriteOnce` PersistentVolumeClaim
  (`increadible-data`, mounted at `/data`), which has a single writer. Do not add an HPA or more replicas.
  Rule hit counts are still in memory. The cluster needs a default StorageClass (or set `storageClassName` in the PVC).
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
