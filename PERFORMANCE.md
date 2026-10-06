# Performance: measured baselines

What has been measured about this server, how, and what it does and does not tell you. Everything here was produced by the two
scripts in this repository (`scripts/loadtest.js`, `scripts/capacity.js`); the commands to repeat it are at the end.

**Read this first.** One machine, one run of each test, the client on the same host as the server, loopback networking. The numbers show
*relative* costs (for example fsync on or off), how cost *scales* (with the size of the A/B data), and a baseline for alert thresholds.
They say nothing about a production node, a network, a load balancer, a network volume or the Kubernetes CPU limit (0.5 CPU in the
manifests; the server here had up to a full core). Tail latencies (p99, max) varied by 10x to 30x between runs of the same scenario:
use the medians and the server-side means, which are stable.

| | |
|---|---|
| Machine | 4 vCPU Intel(R) Xeon(R) Processor @ 2.10GHz, 16 GB, linux 6.18.44-fc-v70 (a virtual machine) |
| Runtime | Node 24.21.0 (the version in the Docker image and CI) |
| Run | 2026-10-06, load average 0.31 0.69 1.6 at the start, nothing else running |
| Settings | 2 s warm-up, 8 s measured, closed loop at 1, 16, 64 connections, then an open loop at 50% of the best closed-loop rate |

## 1. Throughput and latency per tool (`scripts/loadtest.js`)

*Closed loop:* N connections, each sends its next request when the previous is answered; it finds the ceiling, and its latencies include
queueing. *Open loop:* requests at a fixed rate, each latency counted from the moment the request was **due** (so a slow server cannot hide
its queue). "Server mean ms" is the server's own time per tool call, read from its latency histogram: it excludes the network, the client and
queueing, and is the number to compare across scenarios. "Server CPU" below 100% means the single-threaded **client** was limiting, so the
rate is a lower bound for the server.

### routing: apply_routing_rules

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 8346 | 0.101 | 0.188 | 0.382 | 5.38 | 0 | 47% | 0.0034 | 83 |
| closed | 16 conn | 20501 | 0.732 | 1.404 | 1.867 | 6.13 | 0 | 77% | 0.0027 | 85 |
| closed | 64 conn | 19761 | 3.132 | 5.085 | 6.733 | 53.84 | 0 | 76% | 0.0027 | 85 |
| open | 10251/s (50% of best) | 10247 | 1.734 | 3.161 | 8.555 | 25.26 | 0 | 41% | 0.0028 | 85 |

### gateway: get_api_stats

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 8417 | 0.097 | 0.195 | 0.355 | 39.68 | 0 | 47% | 0.0034 | 83 |
| closed | 16 conn | 19440 | 0.748 | 1.483 | 2.302 | 8.82 | 0 | 74% | 0.0030 | 89 |
| closed | 64 conn | 18502 | 3.283 | 5.568 | 7.322 | 63.68 | 0 | 74% | 0.0030 | 89 |
| open | 9720/s (50% of best) | 9716 | 1.765 | 14.678 | 203.052 | 245.00 | 0 | 42% | 0.0029 | 89 |

### A/B record_metric, memory only

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 8167 | 0.102 | 0.191 | 0.354 | 6.45 | 0 | 49% | 0.0056 | 110 |
| closed | 16 conn | 18904 | 0.765 | 1.511 | 2.192 | 8.37 | 0 | 79% | 0.0046 | 151 |
| closed | 64 conn | 17915 | 3.335 | 5.997 | 7.918 | 28.78 | 0 | 77% | 0.0048 | 153 |
| open | 9452/s (50% of best) | 9449 | 1.752 | 2.958 | 6.419 | 76.11 | 0 | 47% | 0.0051 | 118 |

### A/B record_metric, data file, fsync off

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 7044 | 0.119 | 0.219 | 0.435 | 7.23 | 0 | 56% | 0.0218 | 112 |
| closed | 16 conn | 20745 | 0.629 | 1.489 | 2.646 | 10.43 | 0 | 96% | 0.0147 | 156 |
| closed | 64 conn | 22166 | 2.540 | 5.114 | 7.444 | 76.29 | 0 | 100% | 0.0144 | 184 |
| open | 11083/s (50% of best) | 11070 | 1.892 | 4.644 | 8.854 | 43.34 | 0 | 75% | 0.0204 | 145 |

### A/B record_metric, data file, AB_FSYNC=1

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 2058 | 0.435 | 0.804 | 1.305 | 12.45 | 0 | 40% | 0.2575 | 85 |
| closed | 16 conn | 3601 | 3.997 | 7.727 | 10.265 | 22.23 | 0 | 56% | 0.2068 | 93 |
| closed | 64 conn | 3156 | 19.029 | 30.717 | 39.162 | 422.37 | 0 | 56% | 0.2340 | 95 |
| open | 1800/s (50% of best) | 1799 | 2.347 | 4.983 | 9.254 | 42.50 | 0 | 41% | 0.2754 | 86 |

### A/B get_experiment_results (10 000 samples)

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 636 | 1.493 | 2.265 | 2.682 | 8.36 | 0 | 87% | 1.1636 | 125 |
| closed | 16 conn | 732 | 20.096 | 36.951 | 46.278 | 99.83 | 0 | 99% | 1.2056 | 237 |
| closed | 64 conn | 759 | 79.106 | 101.747 | 159.385 | 1658.40 | 0 | 100% | 1.1707 | 235 |
| open | 380/s (50% of best) | 380 | 5.018 | 19.395 | 400.092 | 416.83 | 0 | 56% | 1.2965 | 131 |


**Reading the tables**

| Observation | Evidence |
|---|---|
| The in-memory tools cost the server about 3 to 5 microseconds per call; the HTTP and JSON handling around it dominates | server mean 0.003 ms (routing, gateway), 0.005 ms (A/B record, memory only). About 20 000 requests per second at 16 connections with the client, not the server, near its limit (server CPU 74 to 79%) |
| Appending to the A/B data file costs about 15 to 22 microseconds | server mean 0.014 to 0.022 ms with `AB_FSYNC` off; the server reaches 100% CPU at about 22 000 writes per second |
| **`AB_FSYNC=1` costs about 0.2 ms per write on this disk** | server mean 0.21 to 0.28 ms; writes per second fall from about 22 000 to 3 200 to 3 600 (6 to 7 times). A network volume will cost more per flush than this local disk (by how much is not measured here) |
| `get_experiment_results` costs 1.2 ms at 10 000 samples and **blocks the server while it runs** | 636 to 759 calls per second at most; at 64 connections p99 159 ms and max 1.66 s (see section 2: the cost grows with the number of samples) |
| No errors in any run | 0 errors in all 24 runs |

## 2. A/B data capacity (`scripts/capacity.js`)

Fills the data file through the server, stops it, restarts it on the same file, and measures the restart, the memory, and one query. The
manifests give the container **256 MiB of memory and 0.5 CPU**; the server idles at about 85 MiB.

| Measurements | File MiB | Restart replay s | Idle memory MiB | Memory per measurement B | Peak memory after a burst of queries MiB | `get_experiment_results` ms | `/health` p50 / max ms during that burst |
|---:|---:|---:|---:|---:|---:|---:|---|
| 50,000 | 5.7 | 0.18 | 85 | 488 | 276 | 9.0 | 171 / 316 |
| 200,000 | 22.9 | 0.39 | 157 | 501 | 308 | 38.7 | 857 / 1537 |
| 500,000 | 57.2 | 0.77 | 269 | 434 | 583 | 97.6 | 2078 / 3527 |
| 800,000 | 91.6 | 1.18 | 397 | 440 | 851 | 177.2 | 6336 / 6336 |

**What this shows**

| Finding | Evidence |
|---|---|
| **Memory grows with every measurement and is never released** | about 440 to 500 bytes per measurement in memory against 120 on disk. Idle memory is 85 MiB empty, 157 MiB at 200 000 measurements, 269 MiB at 500 000: **the live data alone exceeds the manifests' 256 MiB limit at about 360 000 measurements, a 41 MiB file** |
| The growth warning comes too late for that limit | `AB_DATA_WARN_BYTES` defaults to 100 MiB, which is about 870 000 measurements and about 430 MiB of memory (extrapolated from the 800 000 point). A pod with a 256 MiB limit would be OOM-killed first, and because startup replays the whole file it would restart into the same kill. The manifests now set the warning at 16 MiB (see below) |
| Restart replay is fast, not a startup risk | 0.2 s at 50 000 measurements, 1.2 s at 800 000, well inside the liveness probe's first checks. Memory, not time, is the limit |
| Query cost is linear in the number of samples | 9 ms at 50 000, 39 ms at 200 000, 98 ms at 500 000, 177 ms at 800 000 (about 0.2 microseconds per sample), per call, on one thread |
| A slow query delays everything else, including the probes | during a burst of 8 parallel `get_experiment_results` calls `/health` took p50 171 ms at 50 000 measurements, 857 ms at 200 000, 2.1 s at 500 000 and 6.3 s at 800 000. The manifests' probes have the Kubernetes default timeout of 1 s |
| Peak memory during queries is much higher than idle | 276 MiB at 50 000 measurements. **Caveat:** this machine has 16 GB, so V8 never had to collect aggressively; inside a 256 MiB container the garbage collector works harder and the peak would be lower. The idle figure is the floor. **How close to the limit a real container gets is NOT VERIFIED here** (no container runtime in the authoring sandbox; the CI Docker job could check it) |

### The memory arithmetic the manifests rely on

`memory = 85 MiB + 500 bytes x measurements` (the 500 rounds up the measured 434 to 504), and a measurement is 120 bytes on disk. For the
256 MiB limit that is about 360 000 measurements at the limit; the manifests set `AB_DATA_WARN_BYTES` to 16 MiB (about 140 000
measurements, about 150 MiB, 59% of the limit) so the warning arrives with room to act. A config test keeps this arithmetic true if the
limit or the threshold changes. This only moves the warning earlier: **the module still holds every measurement in memory**, which is the
open storage-growth decision in `ROADMAP.md` and is what the next change addresses.

## 3. What this means for the open decisions

These are recommendations from the evidence. The decisions stay with the owner (`ROADMAP.md`).

| Decision | What the measurements say | Recommendation |
|---|---|---|
| **`AB_FSYNC` default** | the cost is about 0.2 ms per write here, and the ceiling stays above 3 000 writes per second | turn it on in the manifests: A/B writes are rare next to that ceiling, and an acknowledged write that survives a node crash is worth far more than 0.2 ms. On a network volume re-measure: the flush there is typically slower than this local disk, and the ceiling falls in proportion (not measured here) |
| **`RATE_LIMIT_PER_MINUTE`** | the slowest tool at realistic data sizes sets the ceiling: about 3 000 per second for writes with fsync, about 700 per second for `get_experiment_results` at 10 000 samples, on up to a full core (the manifests allow 0.5) | there is no honest single number without the target hardware. Method: measure with `scripts/loadtest.js` on the deployed node, take 50% of the sustained rate of the slowest tool you use, and set the limit at or below it; the limit is global, so it bounds the total |
| **Latency alert threshold** (`IncreadibleSlowToolCalls`, provisional p95 above 1 s) | normal per-call time is 0.003 to 0.3 ms, and 1.2 ms for results at 10 000 samples: a 1 s threshold is three orders of magnitude above normal and would only fire on a stall | tighten it once the O(n) query cost is gone and the node is measured; 250 ms is a sensible first value from this data (results at 800 000 samples take 177 ms today). Not changed here |
| **A/B storage growth** (keep raw measurements in memory, or aggregate) | memory and query cost both grow linearly with the data, and the memory limit is reached at about 41 MiB of file | the data justifies changing it: keep the raw log on disk (nothing is lost) and hold only running aggregates per variant and metric in memory, so memory and query time stop growing |

## Reproduce

```bash
npm ci && npm run build
npm run loadtest                      # all scenarios, about 4 minutes; --list, --scenarios routing,ab-fsync, --duration 8, --concurrency 1,16,64, --json out.json
npm run capacity -- --sizes 50000,200000,500000,800000      # about 2 minutes
INCREADIBLE_ROOT=/path/to/another/checkout npm run loadtest   # test another build
```

Run them on an idle machine, with the client and the server on separate cores where you can. They are not part of CI: shared runners
are too noisy to compare numbers, and `scripts/smoke.sh` only checks that both scripts still run.
