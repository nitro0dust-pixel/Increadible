# Performance: measured baselines

What has been measured about this server, how, and what it does and does not tell you. Everything here was produced by the two
scripts in this repository (`scripts/loadtest.js`, `scripts/capacity.js`); the commands to repeat it are at the end.

**Updated after roadmap step 9** (the A/B module no longer holds every measurement in memory). The A/B tables and the capacity table were measured
again on the new code, and the figures of the previous code are kept where they show what changed ("before"). Routing and gateway were not
measured again: nothing they use changed.

**Read this first.** One machine, one run of each test, the client on the same host as the server, loopback networking. The numbers show
*relative* costs (for example fsync on or off), how cost *scales* (with the size of the A/B data), and a baseline for alert thresholds.
They say nothing about a production node, a network, a load balancer, a network volume or the Kubernetes CPU limit (0.5 CPU in the
manifests; the server here had up to a full core). Tail latencies (p99, max) varied by 10x to 30x between runs of the same scenario:
use the medians and the server-side means, which are stable.

| | |
|---|---|
| Machine | 4 vCPU Intel(R) Xeon(R) Processor @ 2.10GHz, 16 GB, linux 6.18.44-fc-v70 (a virtual machine) |
| Runtime | Node 24.21.0 (the version in the Docker image and CI) |
| Run | 2026-10-06. First run (the figures marked "before"): load average 0.31 0.69 1.6 at the start. Step 9 runs: capacity 0.77 1.10 0.95, load tests 1.86 1.49 1.13 (new code) and 1.55 1.48 1.19 (previous code, immediately after, same machine); nothing else was running, but the load average shows the machine was busier than in the first run |
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
| closed | 1 conn | 7061 | 0.116 | 0.256 | 0.450 | 5.59 | 0 | 48% | 0.0065 | 83 |
| closed | 16 conn | 18730 | 0.768 | 1.564 | 2.358 | 10.29 | 0 | 80% | 0.0048 | 83 |
| closed | 64 conn | 18587 | 3.253 | 5.543 | 7.384 | 45.24 | 0 | 79% | 0.0046 | 84 |
| open | 9365/s (50% of best) | 9359 | 1.721 | 2.795 | 5.149 | 26.12 | 0 | 43% | 0.0047 | 83 |

### A/B record_metric, data file, fsync off

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 6661 | 0.124 | 0.253 | 0.482 | 7.80 | 0 | 55% | 0.0233 | 83 |
| closed | 16 conn | 18021 | 0.732 | 1.750 | 2.775 | 49.50 | 0 | 94% | 0.0170 | 83 |
| closed | 64 conn | 20523 | 2.725 | 5.755 | 7.922 | 83.22 | 0 | 97% | 0.0154 | 84 |
| open | 10262/s (50% of best) | 10259 | 1.860 | 3.753 | 8.300 | 74.84 | 0 | 70% | 0.0205 | 84 |

### A/B record_metric, data file, AB_FSYNC=1

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 1834 | 0.492 | 0.904 | 1.598 | 31.78 | 0 | 41% | 0.2813 | 79 |
| closed | 16 conn | 3683 | 3.911 | 7.370 | 10.010 | 24.39 | 0 | 56% | 0.2021 | 82 |
| closed | 64 conn | 3746 | 15.769 | 25.664 | 34.118 | 356.61 | 0 | 56% | 0.1982 | 82 |
| open | 1873/s (50% of best) | 1872 | 2.404 | 5.253 | 17.715 | 99.24 | 0 | 44% | 0.2854 | 82 |

### A/B get_experiment_results (10 000 samples)

| mode | load | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | server CPU | server mean ms | RSS MB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| closed | 1 conn | 7443 | 0.111 | 0.215 | 0.429 | 6.28 | 0 | 53% | 0.0101 | 85 |
| closed | 16 conn | 20192 | 0.676 | 1.492 | 2.377 | 11.31 | 0 | 90% | 0.0073 | 97 |
| closed | 64 conn | 19485 | 2.860 | 5.868 | 8.242 | 95.98 | 0 | 89% | 0.0075 | 97 |
| open | 10096/s (50% of best) | 10092 | 1.797 | 3.196 | 6.349 | 66.41 | 0 | 65% | 0.0099 | 87 |

**Before and after step 9**, measured back to back on the same machine (16 connections, closed loop; "before" is the previous code, the one that held every measurement in memory):

| Scenario (16 connections, closed loop) | req/s before → after | Server mean ms before → after | Process RSS MB before → after |
|---|---:|---:|---:|
| A/B record_metric, memory only | 18,503 → 18,730 | 0.0047 → 0.0048 | 148 → 83 |
| A/B record_metric, data file, fsync off | 17,571 → 18,021 | 0.0173 → 0.0170 | 150 → 83 |
| A/B record_metric, data file, AB_FSYNC=1 | 3,226 → 3,683 | 0.2303 → 0.2021 | 88 → 82 |
| A/B get_experiment_results (10 000 samples) | 756 → 20,192 | 1.1707 → 0.0073 | 237 → 97 |

Writes cost the same (differences are within the run-to-run noise); what changed is the query and the memory.

**Reading the tables**

| Observation | Evidence |
|---|---|
| The in-memory tools cost the server about 3 to 5 microseconds per call; the HTTP and JSON handling around it dominates | server mean 0.003 ms (routing, gateway), 0.005 ms (A/B record, memory only). About 20 000 requests per second at 16 connections with the client, not the server, near its limit (server CPU 74 to 80%) |
| Appending to the A/B data file costs about 12 to 17 microseconds more | server mean 0.017 ms against 0.005 ms memory-only (`AB_FSYNC` off); the server reaches about 94% CPU at 16 connections |
| **`AB_FSYNC=1` costs about 0.2 ms per write on this disk** | server mean 0.20 to 0.29 ms (0.23 to 0.30 ms in the run on the previous code); writes per second fall from about 18 000 to 20 500 to 3 200 to 3 700 (5 to 6 times). A network volume will cost more per flush than this local disk (by how much is not measured here) |
| **`get_experiment_results` costs 7 microseconds at 10 000 samples and no longer depends on how many there are** | 20 000 calls per second at 16 connections, server mean 0.0073 ms; it was 1.17 ms and 756 per second, and blocked the server while it ran |
| No errors in any run | 0 errors in all 24 first-run tests and in the 32 runs of step 9 |

## 2. A/B data capacity (`scripts/capacity.js`)

Fills the data file through the server, stops it, restarts it on the same file, and measures the restart, the memory, and one query. The
manifests give the container **256 MiB of memory and 0.5 CPU**; an empty server idles at about 62 MiB (Node 24).

**After step 9** (the module keeps counts and a running mean and variance per variant and metric; the raw values stay in the file):

| Measurements | File MiB | Restart replay s | Idle memory MiB | Peak memory after a burst of queries MiB | `get_experiment_results` ms | `/health` p50 / max ms during that burst |
|---:|---:|---:|---:|---:|---:|---|
| 50,000 | 5.7 | 0.16 | 67 | 88 | 0.07 | 1.0 / 8 |
| 200,000 | 22.9 | 0.31 | 67 | 88 | 0.05 | 1.0 / 9 |
| 500,000 | 57.2 | 0.64 | 66 | 87 | 0.06 | 1.0 / 13 |
| 800,000 | 91.6 | 1.00 | 67 | 86 | 0.04 | 1.1 / 9 |
| 2,000,000 | 228.9 | 2.23 | 68 | 87 | 0.06 | 1.2 / 8 |

**Before step 9** (every measurement held in memory), same machine and Node version, for comparison:

| Measurements | File MiB | Restart replay s | Idle memory MiB | Peak memory after a burst of queries MiB | `get_experiment_results` ms | `/health` p50 / max ms during that burst |
|---:|---:|---:|---:|---:|---:|---|
| 50,000 | 5.7 | 0.18 | 85 | 276 | 9.0 | 171 / 316 |
| 200,000 | 22.9 | 0.39 | 157 | 308 | 38.7 | 857 / 1537 |
| 500,000 | 57.2 | 0.77 | 269 | 583 | 97.6 | 2077 / 3527 |
| 800,000 | 91.6 | 1.18 | 397 | 851 | 177.2 | 6335 / 6336 |

**Starting on a file nearly the size of the manifests' volume** (`scripts/make-ab-data.js`, then the server started on it, one run): 8 000 000 measurements, a 915.5 MiB file (89% of the 1Gi volume),
**healthy after 9.0 seconds** with 67 MiB of memory at peak and idle, and the first `get_experiment_results` answered in 5 ms.

**What this shows**

| Finding | Evidence |
|---|---|
| **Memory no longer depends on the data** | idle 66 to 68 MiB at every size from 50 000 to 2 000 000 measurements (before: 85, 157, 269, 397 MiB at 50 000 to 800 000), and 67 MiB with 8 000 000. About 62 MiB is the server itself; the rest is the running aggregates (a few hundred bytes per experiment) and code the first requests warm up |
| **A results call no longer depends on the data** | 0.04 to 0.07 ms from 50 000 to 2 000 000 measurements (before: 9 ms at 50 000 to 177 ms at 800 000) |
| **A query no longer delays the probes** | `/health` p50 about 1 ms during a burst of 8 parallel results calls, at every size (before: 171 ms at 50 000 to 6.3 s at 800 000; the probes' timeout is 1 s) |
| Peak memory after queries is 86 to 88 MiB at every size | before: 276 MiB at 50 000 and 851 MiB at 800 000. This machine has 16 GB, and inside a 256 MiB container the garbage collector works harder, so the peak there should be lower; **how close a real container gets is checked by the container probe in CI, not here** |
| Startup replay is linear and about 1.1 microseconds per measurement | 0.16 s at 50 000, 1.0 s at 800 000, 2.2 s at 2 000 000, 9.0 s at 8 000 000. It runs before the HTTP port opens, so for that long `/health` refuses connections |
| What limits the data now is the volume, and then startup time | the 1Gi volume holds about 8.9 million measurements (120 bytes each). The manifests' liveness probe (first check after 5 s, every 15 s, three failures) restarts the pod about 35 s after it starts: 9 s for 8 million measurements here is a margin of about 4. **NOT VERIFIED:** the 0.5 CPU limit (the server had up to a full core here) and a network volume, either of which makes replay slower; a `startupProbe` would remove the risk and is a recommendation, not applied |

### What the earlier version of this document got wrong

It said an empty server idles at 85 MiB and gave the memory formula as "85 MiB + 500 bytes per measurement". 85 MiB was the reading **at 50 000 measurements**; the
empty server is 62 MiB (the first run's own baseline column says 61 to 62, and an empty server was measured again for the step 9 runs: 58 to 59 MiB on Node 22, 62 MiB on Node 24).
The formula was therefore conservative by about 21 MiB, and the previous code reached the 256 MiB limit at roughly 400 000 to 460 000 measurements (62 MiB plus 440 to 500 bytes
each), not at the 360 000 the first version of this document stated. That does not change the conclusion (it still happened well before the default 100 MiB growth warning at about 870 000
measurements), and the regression check added with step 9 (a 400 000-measurement file replayed under a 48 MiB heap, which the previous code could not do even with 96 MiB) does not
depend on the figure.

### The growth warning

`AB_DATA_WARN_BYTES` is a warning only, and the file is still never compacted. With memory out of the picture the manifests set it to the code default, 100 MiB (10% of the 1Gi volume,
about 870 000 measurements), which leaves time to plan a rollup or a bigger volume; a config test keeps it well below the volume size. Step 8 had set it to 16 MiB to protect the
memory limit, a reason that no longer exists.

## 3. What this means for the open decisions

These are recommendations from the evidence. The decisions stay with the owner (`ROADMAP.md`).

| Decision | What the measurements say | Recommendation |
|---|---|---|
| **`AB_FSYNC` default** | the cost is about 0.2 ms per write here, and the ceiling stays above 3 000 writes per second | turn it on in the manifests: A/B writes are rare next to that ceiling, and an acknowledged write that survives a node crash is worth far more than 0.2 ms. On a network volume re-measure: the flush there is typically slower than this local disk, and the ceiling falls in proportion (not measured here) |
| **`RATE_LIMIT_PER_MINUTE`** | the slowest tool sets the ceiling, and it is now a write with fsync: about 3 200 to 3 700 per second (results calls are about 20 000 per second at any data size), on up to a full core (the manifests allow 0.5) | there is no honest single number without the target hardware. Method: measure with `scripts/loadtest.js` on the deployed node, take 50% of the sustained rate of the slowest tool you use, and set the limit at or below it; the limit is global, so it bounds the total |
| **Latency alert threshold** (`IncreadibleSlowToolCalls`, provisional p95 above 1 s) | normal per-call time is 0.003 to 0.3 ms, and 1.2 ms for results at 10 000 samples: a 1 s threshold is three orders of magnitude above normal and would only fire on a stall | the O(n) query cost is gone: the slowest normal call is a write with `AB_FSYNC=1`, 0.2 to 0.3 ms here. About 250 ms is a sensible first value, still about 1 000 times the normal; tighten it after measuring the deployed node, and re-measure the flush on a network volume first. Not changed here |
| **A/B storage growth** (keep raw measurements in memory, or aggregate) | **done in step 9**: memory 67 MiB flat from 50 000 to 8 000 000 measurements, results in 0.04 to 0.07 ms | nothing left to decide for memory or query time. The file itself still only grows (never compacted): rollup or rotation is a separate decision for when the volume fills, see "What limits the data now" |

## Reproduce

```bash
npm ci && npm run build
npm run loadtest                      # all scenarios, about 4 minutes; --list, --scenarios routing,ab-fsync, --duration 8, --concurrency 1,16,64, --json out.json
npm run capacity -- --sizes 50000,200000,500000,800000,2000000      # about 5 minutes
node scripts/make-ab-data.js --file big.jsonl --measurements 8000000   # a large data file in seconds, to start the server on (AB_DATA_FILE=big.jsonl)
INCREADIBLE_ROOT=/path/to/another/checkout npm run loadtest   # test another build
```

Run them on an idle machine, with the client and the server on separate cores where you can. They are not part of CI: shared runners
are too noisy to compare numbers, and `scripts/smoke.sh` only checks that both scripts still run.
