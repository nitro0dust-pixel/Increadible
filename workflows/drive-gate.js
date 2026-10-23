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
// What the caller gives ends up inside shell commands that agents are told to run, so it must be plain: paths of letters, digits and / . _ - only, names of letters, digits, _ and -.
const SAFE_PATH = /^\/[A-Za-z0-9_\/.-]+$/
const SAFE_PREFIX = /^[A-Za-z0-9_\/.:-]*$/
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/
if (args && args.repo !== undefined && !SAFE_PATH.test(String(args.repo))) throw new Error('drive-gate: args.repo must be an absolute path made of letters, digits, / . _ and - only')
if (args && args.evidence_dir !== undefined && !SAFE_PATH.test(String(args.evidence_dir))) throw new Error('drive-gate: args.evidence_dir must be an absolute path made of letters, digits, / . _ and - only')
if (args && args.runs !== undefined && !(Array.isArray(args.runs) && args.runs.length >= 1 && args.runs.length <= 4 && args.runs.every((r) => r && typeof r.label === 'string' && SAFE_LABEL.test(r.label) && (r.path_prefix === undefined || (typeof r.path_prefix === 'string' && SAFE_PREFIX.test(r.path_prefix)))) && new Set(args.runs.map((r) => r.label)).size === args.runs.length)) throw new Error('drive-gate: args.runs must be 1 to 4 entries with different labels (letters, digits, _ and -) and a path_prefix of letters, digits, / . : _ and - only')
const REPO = (args && args.repo) || 'the current working directory (run `pwd` first)'
const EVIDENCE = (args && args.evidence_dir) || '/tmp/drive-gate-evidence'
const RUNS = (args && args.runs ? args.runs.map((r) => ({ label: String(r.label), path_prefix: r.path_prefix ? String(r.path_prefix) : '' })) : [{ label: 'default', path_prefix: '' }])
const BREAKAGES = (args && Number.isInteger(args.breakages) && args.breakages !== 0) ? Math.max(1, Math.min(6, args.breakages)) : 3

const COMMON = `
Repository: ${REPO}. It is a Node project (an MCP server "increadible") with dependency-free request drivers in scripts/drive-*.js, described in docs/DRIVERS.md; scripts/drive-all.js runs all of them against all shipped scenarios in parallel and scripts/drive-expected.json says how many steps each job must report.
RULES FOR EVERY AGENT: evidence over assumption: say NOT VERIFIED / NOT AVAILABLE / BLOCKED instead of "works", and never invent numbers or results; never modify tracked files in the repository; never run git commit, push, checkout, reset or stash; never print or invent a secret value; leave no process running and no port open; scratch files only under ${EVIDENCE}/ or a directory you create under /tmp. Nothing here deploys anything: a deployment needs a human's explicit approval.
`

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    exit_code: { type: 'integer' },
    report_path: { type: 'string' },
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
    reports: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, report_verdict: { type: 'string' }, sha256: { type: 'string' } }, required: ['label', 'report_verdict', 'sha256'] } },
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
// one runner after the other: each builds the checkout (the build removes dist/ first), so two at once would pull the build from under each other
const runs = []
for (const run of RUNS) runs.push(await agent(
  COMMON + `
ROLE: TESTING RUNNER (label "${run.label}"). You run the drivers and keep the evidence; you do not interpret it and you do not decide anything.
Steps, in order:
1. cd ${REPO}. Put ${run.path_prefix ? `\`${run.path_prefix}\` in front of PATH for every command you run` : 'PATH as it is'}. Record \`node --version\` and \`git rev-parse HEAD\`, and keep the output of \`git status --porcelain --untracked-files=no\` as it is before you do anything else (the baseline).
2. Run \`npm run build\` and then \`npm run mcpb\`, so that what is run is this commit (both write only to dist/, which git ignores; the build removes dist/mcpb, so the package comes second). If either fails, return exit_code 2 and say why in problems_starting.
3. \`mkdir -p ${EVIDENCE} && rm -f ${EVIDENCE}/${run.label}.json ${EVIDENCE}/${run.label}.stderr\` (nothing left from an earlier run may pass for this one). Run exactly: \`node scripts/drive-all.js --json > ${EVIDENCE}/${run.label}.json 2> ${EVIDENCE}/${run.label}.stderr\` and keep its exit code (once: the critics read this file, and a second run could differ from it). Do not retry a failing run to make it pass; report what happened the first time.
4. Compute the SHA-256 of ${EVIDENCE}/${run.label}.json. Run \`git status --porcelain --untracked-files=no\` again and set tracked_files_modified to true if its output differs from the baseline.
Return the fields of the schema. Do not summarise the report: the critics read the files themselves.`,
  { label: `run:${run.label}`, phase: 'Run', schema: RUN_SCHEMA }
))
const ranOk = runs.filter(Boolean)
log(`runs: ${runs.map((r, i) => (r ? `${RUNS[i].label}=exit ${r.exit_code}` : `${RUNS[i].label}=agent failed`)).join(', ')}`)

// ------------------------------------------------------------------ Critique: independent roles

phase('Critique')
const evidenceList = ranOk.map((r) => `- ${r.label}: ${r.report_path} (sha256 ${r.sha256}, exit code ${r.exit_code}, node ${r.node_version}, git ${r.git_head})`).join('\n') || '(no run produced evidence)'
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
- Say plainly what the drivers do NOT cover (Windows, any real provider, Claude Desktop itself): a PASS must not read as more than it is.
- In \`reports\` give, for every report file named above, its label, the \`verdict\` field you read in that JSON yourself, and the SHA-256 you computed yourself; the script compares them with what the runner said.`, { label: 'critic:validation', phase: 'Critique', schema: CRITIC_SCHEMA }),
  () => agent(FRAME + `
ROLE: SECURITY. Did the run behave safely, and does the evidence show nothing it should not?
- grep the reports and the .txt/.stderr files for anything that looks like a secret value (long hex or base64 strings, "Bearer ", names containing TOKEN, KEY, SECRET or PASSWORD followed by a value); the drivers promise to print names only.
- Check that no real provider was called: every gateway answer in the reports must be sample data, and no driver was given GATEWAY_LIVE_APIS. Look at the processes and listening ports now (\`ps\`, \`ss -ltn\` or \`netstat\`): is anything of the run still alive? Other critics run drivers while you look (the Validation critic re-runs a job, the adversarial tester runs drive-all): wait until \`pgrep -f drive-\` prints nothing for 5 seconds before you judge what is left, and count only what stays then. Are there directories named increadible-drive-* in the temporary folder that are newer than the evidence files (older ones come from earlier runs and are not this run's)? The runs leave nothing behind and drive-all gives its drivers a folder of their own.
- Read scripts/drive-all.js and the diff of scripts/ against the last tag or the previous commit (\`git log -5 --stat -- scripts\`): does anything start a process with more environment than the drivers' own allow-list, write outside a temporary folder, or follow a path the user did not give?
- Report anything that would make you unwilling to run this on a machine with real credentials in its environment.`, { label: 'critic:security', phase: 'Critique', schema: CRITIC_SCHEMA }),
  () => agent(FRAME + `
ROLE: ADVERSARIAL TESTER. A gate that cannot fail proves nothing; your job is to show that this one can.
Make ${BREAKAGES} different deliberate breakages of the SERVER, one at a time, in a COPY: mkdir -p /tmp/drive-gate-breaker && cp -r ${REPO}/dist ${REPO}/package.json /tmp/drive-gate-breaker/ && ln -s ${REPO}/node_modules /tmp/drive-gate-breaker/node_modules (re-copy dist before each breakage). Edit the copy of dist/ only. Choose breakages in different parts: a routing rule behaviour (dist/features/07-routing-plugins/src/mcp-server.js), a statistic (dist/features/08-ab-testing/src/mcp-server.js), a gateway behaviour (dist/features/09-api-gateway/src/mcp-server.js), the HTTP layer (dist/src/index.js: a status code, a header), the protocol layer (dist/src/server.js). For each, run \`node ${REPO}/scripts/drive-all.js --only stdio,http --root /tmp/drive-gate-breaker --json\` and record whether the gate went red, which job and step named the breakage, and the exit code. A breakage that leaves the gate green is a blocker finding: say exactly what you changed. Never touch ${REPO}. A FAIL from you says the gate has a hole at that place; it does not say the checkout is wrong. Known not covered, so do not choose them: the value of protocolVersion in the initialize answer (the drivers only check that it is a string).`, { label: 'critic:adversarial', phase: 'Critique', schema: CRITIC_SCHEMA }),
])

// ------------------------------------------------------------------ Verdict: the Orchestrator

phase('Verdict')
// Every answer is checked before it counts; an answer of the wrong shape is a missing answer, and an odd spelling is never a reason to pass.
const ROLES = ['validation', 'security', 'adversarial']
const severity = (f) => String(f && f.severity).toLowerCase()
const validRun = (r, i) => !!r && typeof r === 'object' && r.label === RUNS[i].label && Number.isInteger(r.exit_code) && typeof r.sha256 === 'string' && r.sha256 !== '' && typeof r.report_path === 'string' && r.report_path !== ''
// 'none' = no usable answer, 'red' = a defect, 'green' = looked and found nothing that matters, 'yellow' = anything else (a human decides)
const state = (c) => {
  if (!c || typeof c !== 'object' || !Array.isArray(c.findings)) return 'none'
  const verdict = String(c.verdict).toUpperCase().replace(/[^A-Z]/g, '_')
  if (verdict.startsWith('FAIL') || c.findings.some((f) => severity(f) === 'blocker')) return 'red'
  if (verdict === 'PASS' && c.findings.every((f) => severity(f) === 'minor')) return 'green'
  return 'yellow'
}
const states = critics.map(state)
const named = (wanted) => states.map((s, i) => (s === wanted ? ROLES[i] : null)).filter(Boolean)
const failedRuns = runs.map((r, i) => ({ r, run: RUNS[i], ok: validRun(r, i) })).filter((x) => !x.ok || x.r.exit_code !== 0)
const modified = runs.filter((r, i) => validRun(r, i) && r.tracked_files_modified !== false) // true, or an answer that does not say
// The runner's account is compared with what the Validation critic read in the report itself
const confirmations = runs.map((r, i) => {
  if (!validRun(r, i)) return null
  const mine = (critics[0] && Array.isArray(critics[0].reports)) ? critics[0].reports.find((x) => x && x.label === r.label) : undefined
  if (!mine) return { label: r.label, problem: 'the Validation critic did not report what the report file says' }
  if (String(mine.sha256).toLowerCase() !== String(r.sha256).toLowerCase()) return { label: r.label, problem: 'the report file is not the one the runner described (different SHA-256)', hard: true }
  if ((String(mine.report_verdict).toUpperCase() === 'PASS') !== (r.exit_code === 0)) return { label: r.label, problem: 'the exit code the runner gave does not match the verdict in the report (' + mine.report_verdict + ')', hard: true }
  return null
}).filter(Boolean)

let verdict = 'PASS'
const reasons = []
if (failedRuns.length) { verdict = 'FAIL'; reasons.push(`${failedRuns.length} run(s) did not end with exit code 0: ${failedRuns.map((x) => x.run.label + (x.ok ? ' (exit ' + x.r.exit_code + ')' : x.r ? ' (answer unusable)' : ' (agent failed)')).join(', ')}`) }
if (modified.length) { verdict = 'FAIL'; reasons.push(`a run modified tracked files (or did not say it had not): ${modified.map((r) => r.label).join(', ')}`) }
if (confirmations.some((c) => c.hard)) { verdict = 'FAIL'; reasons.push(confirmations.filter((c) => c.hard).map((c) => c.label + ': ' + c.problem).join('; ')) }
if (named('red').length) { verdict = 'FAIL'; reasons.push(`critic(s) found a defect: ${named('red').join(', ')}`) }
if (verdict === 'PASS' && (named('none').length || named('yellow').length || confirmations.length)) {
  verdict = 'REVIEW_REQUIRED'
  if (named('none').length) reasons.push(`${named('none').length} critic agent(s) gave no usable answer, so their question is unanswered: ${named('none').join(', ')}`)
  if (named('yellow').length) reasons.push(`critic(s) ask for a human's judgement: ${named('yellow').join(', ')}`)
  if (confirmations.length) reasons.push(confirmations.map((c) => c.label + ': ' + c.problem).join('; '))
}
if (verdict === 'PASS') reasons.push('every run ended with exit code 0, the Validation critic confirmed each report, and no critic found anything that matters')

const findings = critics.flatMap((c, i) => (states[i] === 'none' ? [] : c.findings.map((f) => ({ ...(f && typeof f === 'object' ? f : { title: String(f) }), role: ROLES[i] }))))
return {
  verdict,
  reasons,
  evidence: runs.filter((r, i) => validRun(r, i)).map((r) => ({ label: r.label, exit_code: r.exit_code, report: r.report_path, sha256: r.sha256, node: r.node_version, git_head: r.git_head })),
  critics: critics.map((c, i) => (states[i] === 'none' ? { role: ROLES[i], verdict: 'NO ANSWER' } : { role: ROLES[i], verdict: c.verdict, checked: c.checked })),
  findings,
  next_actions: findings.filter((f) => severity(f) !== 'minor').map((f) => `${f.role}: ${f.next_action}`),
  not_covered: ['Windows', 'any real provider (the drivers never switch live calls on)', 'Claude Desktop itself accepting the package'],
  deploy: 'not performed: a deployment to production needs explicit human approval',
}
