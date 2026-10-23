export const meta = {
  name: 'drive-gate',
  description: 'Run every request driver (scripts/drive-all.js), then have independent critics judge the evidence; reports PASS, FAIL or REVIEW_REQUIRED and never deploys',
  whenToUse: 'Before merging a change to the server, the drivers or their scenarios, and after building a package or an image to check it. Read-only on the repository (it may write dist/, which git ignores).',
  phases: [
    { title: 'Run', detail: 'a Testing agent per run runs scripts/drive-all.js and keeps the raw report' },
    { title: 'Critique', detail: 'Validation, Security and an adversarial tester, each independent of the runner and of each other' },
    { title: 'Verdict', detail: 'the Orchestrator (this script) decides from the evidence; no agent may approve its own work' },
  ],
}

// docs/DRIVERS-WORKFLOW.md describes the roles, the gates and the exact way to start this workflow.
//
// args (all optional):
//   repo           absolute path of the checkout to judge; default: the current working directory
//   evidence_dir   where the raw reports are kept; default: /tmp/drive-gate-evidence (outside the repository)
//   runs           [{ label, path_prefix }]: one Testing agent per entry, run in parallel, for example the same checkout under two Node
//                  versions: [{ label: 'node22', path_prefix: '/opt/node22/bin' }, { label: 'node24', path_prefix: '/opt/node24/bin' }]
//                  (path_prefix is put in front of PATH; default one run with the PATH as it is)
//   breakages      how many deliberate server breakages the adversarial tester tries (default 3, at most 6)
const REPO = (args && args.repo) || 'the current working directory (run `pwd` first)'
const EVIDENCE = (args && args.evidence_dir) || '/tmp/drive-gate-evidence'
const RUNS = (args && args.runs && args.runs.length ? args.runs : [{ label: 'default', path_prefix: '' }])
const BREAKAGES = Math.max(1, Math.min(6, (args && args.breakages) || 3))

const COMMON = `
Repository: ${REPO}. It is a Node project (an MCP server "increadible") with dependency-free request drivers in scripts/drive-*.js, described in docs/DRIVERS.md; scripts/drive-all.js runs all of them against all shipped scenarios in parallel and scripts/drive-expected.json says how many steps each job must report.
RULES FOR EVERY AGENT: never modify tracked files in the repository; never run git commit, push, checkout, reset or stash; never print or invent a secret value; leave no process running and no port open; scratch files only under ${EVIDENCE}/ or a directory you create under /tmp. Nothing here deploys anything: a deployment needs a human's explicit approval.
`

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    exit_code: { type: 'integer' },
    report_path: { type: 'string' },
    table_path: { type: 'string' },
    sha256: { type: 'string' },
    node_version: { type: 'string' },
    git_head: { type: 'string' },
    tracked_files_modified: { type: 'boolean' },
    problems_starting: { type: 'string' },
  },
  required: ['label', 'exit_code', 'report_path', 'sha256', 'node_version', 'git_head', 'tracked_files_modified'],
}

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'REVIEW_REQUIRED'] },
    checked: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
          next_action: { type: 'string' },
        },
        required: ['severity', 'title', 'evidence', 'next_action'],
      },
    },
  },
  required: ['role', 'verdict', 'checked', 'findings'],
}

// ------------------------------------------------------------------ Run: the Testing role

phase('Run')
const runs = await parallel(RUNS.map((run) => () => agent(
  COMMON + `
ROLE: TESTING RUNNER (label "${run.label}"). You run the drivers and keep the evidence; you do not interpret it and you do not decide anything.
Steps, in order:
1. cd ${REPO}. Put ${run.path_prefix ? `\`${run.path_prefix}\` in front of PATH for every command you run` : 'PATH as it is'}. Record \`node --version\` and \`git rev-parse HEAD\`.
2. If dist/src/main.js does not exist run \`npm run build\`; if dist/mcpb/*.mcpb does not exist run \`npm run mcpb\` (both write only to dist/, which git ignores). If either fails, return exit_code 2 and say why in problems_starting.
3. mkdir -p ${EVIDENCE}. Run exactly: \`node scripts/drive-all.js --json > ${EVIDENCE}/${run.label}.json 2> ${EVIDENCE}/${run.label}.stderr\` and keep its exit code; then run \`node scripts/drive-all.js > ${EVIDENCE}/${run.label}.txt 2>&1\` for the human-readable table. Do not retry a failing run to make it pass; report what happened the first time.
4. Compute the SHA-256 of ${EVIDENCE}/${run.label}.json. Run \`git status --porcelain --untracked-files=no\` and set tracked_files_modified to true if it printed anything.
Return the fields of the schema. Do not summarise the report: the critics read the files themselves.`,
  { label: `run:${run.label}`, phase: 'Run', schema: RUN_SCHEMA }
)))
const ranOk = runs.filter(Boolean)
log(`runs: ${runs.map((r, i) => (r ? `${RUNS[i].label}=exit ${r.exit_code}` : `${RUNS[i].label}=agent failed`)).join(', ')}`)

// ------------------------------------------------------------------ Critique: independent roles

phase('Critique')
const evidenceList = ranOk.map((r) => `- ${r.label}: ${r.report_path} (sha256 ${r.sha256}, exit code ${r.exit_code}, node ${r.node_version}, git ${r.git_head}); table: ${r.table_path || EVIDENCE + '/' + r.label + '.txt'}`).join('\n') || '(no run produced evidence)'
const FRAME = COMMON + `
You did NOT produce this evidence and you must not trust anyone's summary of it. The raw reports:
${evidenceList}
Each report is the JSON of \`node scripts/drive-all.js --json\`: { verdict, jobs: [{ id, status, steps, passed, failing, problems, note, ms }], leftBehind }.
Answer with the schema: your verdict (PASS only if you looked and found nothing that matters; REVIEW_REQUIRED when something needs a human's judgement; FAIL when the evidence shows a defect), what you checked, and findings, each with the evidence you saw and the next action.`

const critics = await parallel([
  () => agent(FRAME + `
ROLE: VALIDATION. Is the evidence complete and does it support what the repository claims?
- Read the report(s) yourself. Are all jobs there that scripts/drive-all.js --list names? Any job with a note such as "no expected count", any skipped or CANNOT RUN job, any step count different from scripts/drive-expected.json?
- Re-run ONE job yourself, chosen by you (for example \`node scripts/drive-stdio.js --scenario gateway --json\`) and compare it with the report: the same steps, the same verdict?
- Read docs/DRIVERS.md sections 3 and 5 and the Status line in ROADMAP.md: does the evidence contradict anything stated there as verified? Is anything stated as verified that no job covers?
- Say plainly what the drivers do NOT cover (Windows, any real provider, Claude Desktop itself): a PASS must not read as more than it is.`, { label: 'critic:validation', phase: 'Critique', schema: CRITIC_SCHEMA }),
  () => agent(FRAME + `
ROLE: SECURITY. Did the run behave safely, and does the evidence show nothing it should not?
- grep the reports and the .txt/.stderr files for anything that looks like a secret value (long hex or base64 strings, "Bearer ", names containing TOKEN, KEY, SECRET or PASSWORD followed by a value); the drivers promise to print names only.
- Check that no real provider was called: every gateway answer in the reports must be sample data, and no driver was given GATEWAY_LIVE_APIS. Look at the processes and listening ports now (\`ps\`, \`ss -ltn\` or \`netstat\`): is anything of the run still alive? Are there directories named increadible-drive-* in the temporary folder?
- Read scripts/drive-all.js and the diff of scripts/ against the last tag or the previous commit (\`git log -5 --stat -- scripts\`): does anything start a process with more environment than the drivers' own allow-list, write outside a temporary folder, or follow a path the user did not give?
- Report anything that would make you unwilling to run this on a machine with real credentials in its environment.`, { label: 'critic:security', phase: 'Critique', schema: CRITIC_SCHEMA }),
  () => agent(FRAME + `
ROLE: ADVERSARIAL TESTER. A gate that cannot fail proves nothing; your job is to show that this one can.
Make ${BREAKAGES} different deliberate breakages of the SERVER, one at a time, in a COPY: mkdir -p /tmp/drive-gate-breaker && cp -r ${REPO}/dist ${REPO}/package.json /tmp/drive-gate-breaker/ && ln -s ${REPO}/node_modules /tmp/drive-gate-breaker/node_modules (re-copy dist before each breakage). Edit the copy of dist/ only. Choose breakages in different parts: a routing rule behaviour (dist/features/07-routing-plugins/src/mcp-server.js), a statistic (dist/features/08-ab-testing/src/mcp-server.js), a gateway behaviour (dist/features/09-api-gateway/src/mcp-server.js), the HTTP layer (dist/src/index.js: a status code, a header), the protocol layer (dist/src/server.js). For each, run \`node ${REPO}/scripts/drive-all.js --only stdio,http --root /tmp/drive-gate-breaker --json\` and record whether the gate went red, which job and step named the breakage, and the exit code. A breakage that leaves the gate green is a blocker finding: say exactly what you changed. Never touch ${REPO}.`, { label: 'critic:adversarial', phase: 'Critique', schema: CRITIC_SCHEMA }),
])

// ------------------------------------------------------------------ Verdict: the Orchestrator

phase('Verdict')
const failedRuns = runs.map((r, i) => ({ r, run: RUNS[i] })).filter((x) => !x.r || x.r.exit_code !== 0)
const modified = ranOk.filter((r) => r.tracked_files_modified)
const criticFailed = critics.map((c, i) => ({ c, i })).filter((x) => !x.c)
const reds = critics.filter(Boolean).filter((c) => c.verdict === 'FAIL' || (c.findings || []).some((f) => f.severity === 'blocker'))
const yellows = critics.filter(Boolean).filter((c) => c.verdict === 'REVIEW_REQUIRED' || (c.findings || []).some((f) => f.severity === 'major'))

let verdict = 'PASS'
const reasons = []
if (failedRuns.length) { verdict = 'FAIL'; reasons.push(`${failedRuns.length} run(s) did not end with exit code 0: ${failedRuns.map((x) => x.run.label + (x.r ? ' (exit ' + x.r.exit_code + ')' : ' (agent failed)')).join(', ')}`) }
if (modified.length) { verdict = 'FAIL'; reasons.push(`a run modified tracked files: ${modified.map((r) => r.label).join(', ')}`) }
if (reds.length) { verdict = 'FAIL'; reasons.push(`critic(s) found a defect: ${reds.map((c) => c.role).join(', ')}`) }
if (verdict === 'PASS' && (criticFailed.length || yellows.length)) {
  verdict = 'REVIEW_REQUIRED'
  if (criticFailed.length) reasons.push(`${criticFailed.length} critic agent(s) gave no answer, so their question is unanswered`)
  if (yellows.length) reasons.push(`critic(s) ask for a human's judgement: ${yellows.map((c) => c.role).join(', ')}`)
}
if (verdict === 'PASS') reasons.push('every run ended with exit code 0 and no critic found anything that matters')

const findings = critics.filter(Boolean).flatMap((c) => (c.findings || []).map((f) => ({ role: c.role, ...f })))
return {
  verdict,
  reasons,
  evidence: ranOk.map((r) => ({ label: r.label, exit_code: r.exit_code, report: r.report_path, sha256: r.sha256, node: r.node_version, git_head: r.git_head })),
  critics: critics.map((c, i) => (c ? { role: c.role, verdict: c.verdict, checked: c.checked } : { role: ['validation', 'security', 'adversarial'][i], verdict: 'NO ANSWER' })),
  findings,
  next_actions: findings.filter((f) => f.severity !== 'minor').map((f) => `${f.role}: ${f.next_action}`),
  not_covered: ['Windows', 'any real provider (the drivers never switch live calls on)', 'Claude Desktop itself accepting the package'],
  deploy: 'not performed: a deployment to production needs explicit human approval',
}
