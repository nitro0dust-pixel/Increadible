export const meta = {
  name: 'engineer-loop',
  description: 'Build a change with independent criticism: Research and Planning, then up to 7 rounds of Engineering judged by separate Testing, Security and Validation agents, decided by this script; ends with a patch for a human, never a push or a deployment',
  whenToUse: 'A change that deserves more than one pair of eyes: a fix or feature in this repository where the drivers and the test suite can say whether it works. Cost: about 4 agents per round (default 3 rounds), so use it for work that matters.',
  phases: [
    { title: 'Prepare', detail: 'Research (facts with sources) and Planning (acceptance criteria, the work area)' },
    { title: 'Engineer', detail: 'one Engineering agent per round, in its own git worktree, starting from the previous round' },
    { title: 'Criticise', detail: 'Testing, Security and Validation, three agents that did not write the code and do not see each other' },
    { title: 'Decide', detail: 'the Orchestrator (this script) approves, recycles with the findings, or stops; max 7 rounds' },
  ],
}

// docs/DRIVERS-WORKFLOW.md describes the roles, the loop, the stop rule and the exact way to start this workflow.
//
// args:
//   task            REQUIRED. What to build or fix, in the words of the person asking.
//   run_id          REQUIRED. A short unique name for this run (for example 20261020-1430); it names the work area and the local branch.
//   repo            absolute path of the checkout; default: the current working directory
//   max_iterations  1 to 7; default 3. The loop also stops at once when a round is approved, or when a round finds exactly what the
//                   round before it found (no better proven alternative is being reached)
//   sprint          0 to 5 (0 Discovery and audit, 1 Critical fixes, 2 Architecture and scalability, 3 UX and UI, 4 Features, 5 Optimisation and SEO); it only tells the agents what is in scope
//   verify          the commands the Testing agent runs in a fresh checkout of each round; default ['npm run type-check', 'npm run lint', 'npm test', 'npm run build', 'node scripts/drive-all.js']
//   research        false to skip the Research agent (default true)
if (!args || typeof args.task !== 'string' || args.task.trim() === '') throw new Error('engineer-loop: args.task is required (what to build or fix)')
if (!args.run_id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(String(args.run_id))) throw new Error('engineer-loop: args.run_id is required: 3 to 40 letters, digits, dashes or underscores, starting with a letter or digit (it is part of a git branch name and of paths)')
if (args.repo !== undefined && !/^\/[A-Za-z0-9_\/.-]+$/.test(String(args.repo))) throw new Error('engineer-loop: args.repo must be an absolute path made of letters, digits, / . _ and - only')
if (args.verify !== undefined && !(Array.isArray(args.verify) && args.verify.length <= 12 && args.verify.every((c) => typeof c === 'string' && c.trim() !== '' && c.length <= 200 && !/[\r\n]/.test(c)))) throw new Error('engineer-loop: args.verify must be a list of at most 12 one-line commands')
// what an agent hands back is checked before it is trusted: a commit is a hash, and two hashes name the same commit when one begins with the other
const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s)
const same = (a, b) => isHash(a) && isHash(b) && (a.startsWith(b) || b.startsWith(a))
const severity = (f) => String(f && f.severity).toLowerCase() // a finding is blocking unless it says it is minor: an odd spelling must not make it harmless
const findingKey = (f) => (f && typeof f.key === 'string' && f.key !== '' ? f.key : String((f && f.title) || f).slice(0, 60))
const TASK = args.task.trim()
const RUN = String(args.run_id)
const REPO = args.repo || 'the current working directory (run `pwd` first)'
const MAX = Math.max(1, Math.min(7, Number.isInteger(args.max_iterations) ? args.max_iterations : 3))
const VERIFY = (args.verify && args.verify.length ? args.verify : ['npm run type-check', 'npm run lint', 'npm test', 'npm run build', 'npm run mcpb', 'node scripts/drive-all.js'])
const WORK = `/tmp/engineer-loop-${RUN}`
const BRANCH = `wf/engineer-loop/${RUN}`
const SPRINTS = ['Sprint 0, Discovery and audit: read, measure and report; change nothing but documents', 'Sprint 1, Critical fixes: security, data loss and correctness only; no new features', 'Sprint 2, Architecture and scalability: structure and limits; behaviour stays the same', 'Sprint 3, UX and UI: how it is used and read; accessibility', 'Sprint 4, Feature additions: new capability, each with tests and documents', 'Sprint 5, Optimisation and SEO/conversion: measured improvements only']
const SPRINT = Number.isInteger(args.sprint) && args.sprint >= 0 && args.sprint <= 5 ? `Scope of this run: ${SPRINTS[args.sprint]}.` : ''

const RULES = `
Repository: ${REPO} (read CLAUDE.md there first; it holds the working rules). Work area for this run: ${WORK} (outside the repository). Local branch for this run: ${BRANCH}.
RULES FOR EVERY AGENT: evidence over assumption: say NOT VERIFIED / NOT AVAILABLE / BLOCKED instead of "works"; never invent numbers, citations or results; never print or write a secret value (variable names only); never push, never open or merge a pull request, never deploy, never touch production or another repository; do not install a new major dependency (say it is needed and why instead); do not rewrite history. Anything you create goes under ${WORK} or, for the Engineering agent, into its own worktree. ${SPRINT}
The task: ${TASK}
`

const FACTS_SCHEMA = { type: 'object', properties: { facts: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, source: { type: 'string' }, verified: { type: 'boolean' } }, required: ['claim', 'source', 'verified'] } }, unknowns: { type: 'array', items: { type: 'string' } } }, required: ['facts', 'unknowns'] }
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    base_sha: { type: 'string' },
    criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, statement: { type: 'string' }, how_to_check: { type: 'string' } }, required: ['id', 'statement', 'how_to_check'] } },
    files_likely: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
  },
  required: ['base_sha', 'criteria', 'files_likely', 'risks', 'out_of_scope'],
}
const BUILD_SCHEMA = { type: 'object', properties: { commit: { type: 'string' }, worktree: { type: 'string' }, summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, deviations: { type: 'array', items: { type: 'string' } }, not_done: { type: 'array', items: { type: 'string' } } }, required: ['commit', 'worktree', 'summary', 'files', 'deviations', 'not_done'] }
const TEST_SCHEMA = { type: 'object', properties: { commit: { type: 'string' }, branch_commit: { type: 'string' }, passed: { type: 'boolean' }, commands: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, exit_code: { type: 'integer' }, summary: { type: 'string' } }, required: ['command', 'exit_code', 'summary'] } }, failures: { type: 'array', items: { type: 'string' } }, not_available: { type: 'array', items: { type: 'string' } } }, required: ['commit', 'passed', 'commands', 'failures', 'not_available'] }
const FINDINGS_SCHEMA = { type: 'object', properties: { role: { type: 'string' }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, title: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['key', 'severity', 'title', 'evidence', 'fix'] } } }, required: ['role', 'summary', 'findings'] }
const VALID_SCHEMA = { type: 'object', properties: { summary: { type: 'string' }, criteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, met: { type: 'string', enum: ['yes', 'no', 'unknown'] }, evidence: { type: 'string' } }, required: ['id', 'met', 'evidence'] } }, findings: FINDINGS_SCHEMA.properties.findings }, required: ['summary', 'criteria', 'findings'] }

// ------------------------------------------------------------------ Prepare: Research and Planning

phase('Prepare')
let facts = { facts: [], unknowns: [] }
if (args.research !== false) {
  facts = (await agent(RULES + `
ROLE: RESEARCH. Collect the facts the task depends on, from the repository first (code, tests, docs, ROADMAP.md, git history) and, only when the task needs it, from authoritative external sources. Every fact needs a source: file:line, a command you ran, or a URL you read. A claim that something is "trending", "standard" or "best practice" needs a citation to live implementations, benchmarks or official documentation before it may influence the design; without one it goes under unknowns. Do not design or change anything.`, { label: 'research', phase: 'Prepare', schema: FACTS_SCHEMA })) || facts
}
const plan = await agent(RULES + `
ROLE: PLANNING. Facts gathered by Research (use them, check what matters): ${JSON.stringify(facts)}
Turn the task into a plan that others can judge. 1) Acceptance criteria: 2 to 8 statements, each testable, each with how to check it (a command, a test, a document line). 2) The files likely to change, the risks, and what is out of scope. 3) Make the work area: \`mkdir -p ${WORK}\`, and record the base: \`git -C <repo> rev-parse HEAD\` is base_sha. Do not write any code.`, { label: 'planning', phase: 'Prepare', schema: PLAN_SCHEMA })
if (!plan) throw new Error('engineer-loop: the Planning agent gave no plan; nothing was changed')
if (!isHash(plan.base_sha)) throw new Error('engineer-loop: the plan has no usable base_sha (a commit hash); nothing was changed')
if (!Array.isArray(plan.criteria) || plan.criteria.length < 1 || plan.criteria.some((c) => !c || typeof c.id !== 'string' || c.id === '') || new Set(plan.criteria.map((c) => c.id)).size !== plan.criteria.length) throw new Error('engineer-loop: the plan needs at least one acceptance criterion, each with its own id; nothing was changed')
log(`plan: ${plan.criteria.length} criteria on ${plan.base_sha.slice(0, 10)}`)

// ------------------------------------------------------------------ the loop

const rounds = []
let feedback = []
let previous = plan.base_sha
let status = 'NOT_APPROVED'
let lastKeys = null
for (let n = 1; n <= MAX; n++) {
  phase('Engineer')
  const built = await agent(RULES + `
ROLE: ENGINEERING, round ${n} of at most ${MAX}. The plan: ${JSON.stringify(plan)}.
${feedback.length ? 'Findings from the independent critics of the previous round, which you must address or answer with a reason: ' + JSON.stringify(feedback) : 'This is the first round.'}
Work in your own git worktree: \`git -C <repo> worktree add --detach ${WORK}/round-${n} ${previous}\`, then \`ln -s <repo>/node_modules ${WORK}/round-${n}/node_modules\` if the repository has node_modules. Make the smallest change that meets the criteria, with tests, and update the documents the change touches (the repository's rules say docs move with code). ${n === 1 ? 'If the local branch ' + BRANCH + ' already exists (\`git -C <repo> rev-parse --verify ' + BRANCH + '\`) it belongs to an earlier run: do not touch it, return an empty commit and say so in not_done. ' : ''}Stage the files you changed by name (never \`git add -A\`: the node_modules link in your worktree must not be committed) and check that \`git show --stat\` lists no node_modules and no dist. Run the quick checks you find useful, but you do NOT decide whether the change is good: separate agents will test and criticise it, and they will not believe your summary. Commit in the worktree (message: what and why; end with the repository's Co-Authored-By trailer lines if CLAUDE.md or the session says so), then record it: \`git -C <repo> branch -f ${BRANCH} <your commit>\` (a local branch only: never push). Return the commit hash, the worktree path, a summary, the files, where you deviated from the plan, and what you did not do.`, { label: `engineer:${n}`, phase: 'Engineer', schema: BUILD_SCHEMA })
  if (!built || !isHash(built.commit) || same(built.commit, previous)) { status = 'STOPPED_NO_ENGINEERING_RESULT'; rounds.push({ round: n, error: !built ? 'the Engineering agent gave no result' : !isHash(built.commit) ? 'the Engineering agent gave no commit hash' : 'the Engineering agent changed nothing (its commit is the one it started from)' }); break }

  phase('Criticise')
  const frame = RULES + `You did NOT write this change and you must not trust the Engineering agent's account of it. The commit to judge is ${built.commit} (base ${plan.base_sha}); see it with \`git -C <repo> show ${built.commit}\` and \`git -C <repo> diff ${plan.base_sha} ${built.commit}\`. The plan with its acceptance criteria: ${JSON.stringify(plan)}.\n`
  const [tested, secured, validated] = await parallel([
    () => agent(frame + `
ROLE: TESTING (independent). Make your own checkout: \`git -C <repo> worktree add --detach ${WORK}/test-${n} ${built.commit}\` and \`ln -s <repo>/node_modules ${WORK}/test-${n}/node_modules\`. In it run these commands, each once, in this order, and record the exit code and what failed: ${JSON.stringify(VERIFY)}. A command that does not exist in this repository is "not available" (list it), not a pass. If a command fails, do not fix it and do not retry to make it pass: report the failure and the output that shows it. Also run, if the change touches scripts/drive-*.js or the server, \`node scripts/drive-all.js --json\` (after \`npm run mcpb\` if dist/mcpb is missing: \`npm run build\` removes it) and report any job that is not PASS. passed is true only if every available command exited 0. Also report branch_commit: the commit that \`git -C <repo> rev-parse ${BRANCH}\` gives, and commit: the commit of your own checkout.`, { label: `test:${n}`, phase: 'Criticise', schema: TEST_SCHEMA }),
    () => agent(frame + `
ROLE: SECURITY (independent; you may reject). Read the diff as an attacker and as an operator. Look for: secrets or credentials in code, docs, tests or logs; injection and path traversal; unsafe defaults (open ports, no auth, wide permissions); new or changed dependencies and install scripts (a new major dependency is a blocker until a human approves it); changes to CI, Docker or Kubernetes files; any code that reaches the network, a real provider or production; weakened checks or deleted tests. Give each finding a stable key (a short slug that would be the same next round if the problem is still there). blocker = must not be merged as it is.`, { label: `security:${n}`, phase: 'Criticise', schema: FINDINGS_SCHEMA }),
    () => agent(frame + `
ROLE: VALIDATION (independent). For each acceptance criterion say whether the change meets it (yes / no / unknown) and show the evidence you found yourself (a line, a command output). Then check the rules of the repository on the diff: do the documents, the CHANGELOG and the tests move with the code; is any number, result or capability claimed that nothing in the change or the repository proves (an invented figure, "works", "faster", "secure"); does anything contradict ROADMAP.md or CLAUDE.md; is a requirement of the task missing; does the diff add node_modules, dist or a link to them (a blocker). Give each finding a stable key.`, { label: `validate:${n}`, phase: 'Criticise', schema: VALID_SCHEMA }),
  ])

  phase('Decide')
  // Nothing an agent says is taken at its word: every answer must have the shape it was asked for, and approval needs all of the following.
  const gaps = []
  const problems = []
  if (!tested || typeof tested !== 'object') gaps.push('the Testing agent gave no answer')
  else {
    if (tested.passed !== true) problems.push('passed is not true')
    if (!same(tested.commit, built.commit)) problems.push('it judged another commit than the one to judge')
    if (!same(tested.branch_commit, built.commit)) problems.push('the local branch is not at the commit to judge')
    if (!Array.isArray(tested.commands) || tested.commands.length === 0) problems.push('no command was run')
    else if (!tested.commands.every((c) => c && c.exit_code === 0)) problems.push('a command did not exit with 0')
    if (!Array.isArray(tested.failures) || tested.failures.length > 0) problems.push('failures are listed')
  }
  if (!secured || typeof secured !== 'object') gaps.push('the Security agent gave no answer')
  else if (!Array.isArray(secured.findings)) gaps.push('the Security agent gave no list of findings')
  if (!validated || typeof validated !== 'object') gaps.push('the Validation agent gave no answer')
  else if (!Array.isArray(validated.criteria) || !Array.isArray(validated.findings)) gaps.push('the Validation agent gave no list of criteria and findings')
  // every criterion of the plan must be judged "yes" by the Validation agent: one it did not mention, or judged "Yes", "no" or "unknown", is not met
  const judged = (validated && Array.isArray(validated.criteria)) ? validated.criteria : []
  const unmet = plan.criteria.filter((p) => { const mine = judged.filter((c) => c && c.id === p.id); return mine.length === 0 || mine.some((c) => c.met !== 'yes') }).map((p) => { const bad = judged.filter((c) => c && c.id === p.id).find((c) => c.met !== 'yes') || {}; return { id: p.id, met: bad.met || 'not judged', evidence: bad.evidence || '' } })
  const all = [].concat((secured && Array.isArray(secured.findings)) ? secured.findings : [], (validated && Array.isArray(validated.findings)) ? validated.findings : [])
  const blocking = all.filter((f) => severity(f) !== 'minor')
  const approved = problems.length === 0 && blocking.length === 0 && unmet.length === 0 && gaps.length === 0
  const keys = [].concat(blocking.map((f) => 'f:' + findingKey(f)), unmet.map((c) => 'c:' + c.id), gaps.map((g) => 'g:' + g), problems.map((p) => 't:' + p), tested && Array.isArray(tested.failures) ? tested.failures.map((x) => 't:' + String(x).slice(0, 60)) : []).sort().join('|')
  rounds.push({ round: n, commit: built.commit, summary: built.summary, files: built.files, deviations: built.deviations, not_done: built.not_done, tests: tested, security: secured, validation: validated, unmet_criteria: unmet.map((c) => c.id), blocking: blocking.map((f) => ({ key: findingKey(f), severity: f && f.severity, title: f && f.title })), gaps, problems, approved })
  log(`round ${n}: tests ${tested ? (tested.passed ? 'pass' : 'FAIL') : 'no answer'}, ${blocking.length} blocking finding(s), ${unmet.length} criteria not met, ${gaps.length} gap(s) -> ${approved ? 'APPROVED' : 'recycle'}`)
  previous = built.commit
  if (approved) { status = 'APPROVED_FOR_HUMAN_REVIEW'; break }
  if (lastKeys !== null && keys === lastKeys) { status = 'STALLED_SAME_FINDINGS_TWICE'; break }
  lastKeys = keys
  feedback = [].concat(
    problems.length ? [{ from: 'testing', problems, failures: tested.failures, commands: (Array.isArray(tested.commands) ? tested.commands : []).filter((c) => !c || c.exit_code !== 0) }] : [],
    blocking.map((f) => ({ from: severity(f) + ' finding', key: findingKey(f), title: f && f.title, evidence: f && f.evidence, fix: f && f.fix })),
    unmet.map((c) => ({ from: 'validation', criterion: c.id, met: c.met, evidence: c.evidence })),
    gaps.map((g) => ({ from: 'orchestrator', note: g }))
  )
  if (n === MAX) status = 'NOT_APPROVED_MAX_ROUNDS'
}

// ------------------------------------------------------------------ the deliverables

return {
  status,
  approved: status === 'APPROVED_FOR_HUMAN_REVIEW',
  rounds_run: rounds.length,
  max_rounds: MAX,
  final_commit: previous,
  base: plan.base_sha,
  local_branch: BRANCH,
  work_area: WORK,
  how_to_take_it: `git -C <repo> diff ${plan.base_sha} ${BRANCH}  (or git -C <repo> log ${plan.base_sha}..${BRANCH}); nothing was pushed, merged or deployed. A human reads it, then pushes and opens the pull request or discards the branch.`,
  plan,
  facts,
  implementation_log: rounds.map((r) => ({ round: r.round, commit: r.commit, summary: r.summary, files: r.files, deviations: r.deviations, not_done: r.not_done, approved: r.approved, error: r.error })),
  test_report: rounds.map((r) => ({ round: r.round, passed: r.tests ? r.tests.passed : null, commands: r.tests ? r.tests.commands : [], failures: r.tests ? r.tests.failures : [], not_available: r.tests ? r.tests.not_available : [] })),
  security_report: rounds.map((r) => ({ round: r.round, summary: r.security ? r.security.summary : null, findings: r.security ? r.security.findings : [] })),
  validation_report: rounds.map((r) => ({ round: r.round, summary: r.validation ? r.validation.summary : null, criteria: r.validation ? r.validation.criteria : [], findings: r.validation ? r.validation.findings : [] })),
  production: 'not touched: a deployment to production needs explicit human approval',
}
