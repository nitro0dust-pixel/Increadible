# gstack × Increadible Integration Guide

## Feature: Workflow Optimization & Habit-Driven Development

**Version**: 1.0  
**Status**: Ready for Integration  
**Category**: Workflow Intelligence / Multi-Role Automation  
**Built by**: [Garry Tan](https://github.com/garrytan) (Y Combinator CEO)

---

## What is gstack?

gstack is a **collection of 23 Claude Code skills + 8 power tools** that analyzes your development habits and continuously optimizes your workflow. Created by Y Combinator's CEO, it transforms individual developers into high-velocity distributed teams with claimed **810× productivity increase**.

Instead of manually deciding which review to run or which step comes next, gstack learns your patterns, detects project stage, and automatically routes you to the right skill—like having a CEO, Designer, Eng Manager, QA Lead, and Security Officer all working with you simultaneously.

### Core Problem It Solves

| Without gstack | With gstack |
|---|---|
| Manual workflow decisions | Automatic skill routing |
| Forget to run reviews | Reviews auto-suggested + executed |
| Context switching overhead | Role-aware task sequencing |
| Inconsistent quality gates | Evidence-based review readiness |
| No learning across sessions | Pattern memory via `/learn` |
| Missing documentation | Auto-doc generation sync |

---

## The 23 Skills Organized by Workflow

### 🎯 Strategic Planning (6 skills)

Reframe assumptions and lock architecture before building.

```
/office-hours          → Reframe product with forcing questions
/plan-ceo-review       → Challenge scope (Expansion→Reduction modes)
/plan-eng-review       → Lock architecture, data flow, edge cases
/plan-design-review    → Rate design dimensions 0-10
/plan-devex-review     → Explore developer experience
/autoplan              → Auto-run all reviews (CEO→Design→DX→Eng)
```

**Use when**: Starting feature, changing architecture, rethinking product

### 🎨 Creation (4 skills)

Design systems, mockups, HTML, documentation.

```
/design-consultation   → Complete design system from research
/design-shotgun        → Generate 4-6 mockup variants (learns taste)
/design-html          → Mockups→Production HTML (dynamic layouts)
/document-generate    → Missing docs via Diataxis framework
```

**Use when**: New UI, design iteration, documentation needed

### ✅ Quality & Safety (8 skills)

Production bugs, test health, security, performance, debugging.

```
/review               → Find & auto-fix production bugs
/test-audit           → Identify wasteful test patterns
/qa                   → Browser, API, CLI testing (real evidence)
/qa-only              → Report findings (no code changes)
/cso                  → Security audit (static + runtime)
/investigate          → Root-cause debugging
/deslop-shared-libs   → Extract reusable code
/benchmark            → Core Web Vitals + load times
```

**Use when**: Pre-shipping, performance issues, security concerns, test cleanup

### 🚀 Release & Monitoring (5 skills)

Deployment automation, documentation sync, monitoring.

```
/ship                 → Sync, test, audit, open PR
/land-and-deploy      → Merge, deploy, verify production
/canary               → Post-deploy error & performance monitoring
/document-release     → Audit docs against release diffs
/retro                → Weekly team-aware retrospectives
```

**Use when**: Ready to deploy, monitoring production, documenting releases

### 🛠️ Supporting Tools (8 tools)

Cross-cutting utilities for common tasks.

```
/browse               → Agent eyes (Aside browser + Chromium)
/make-pdf            → Markdown→Publication-quality PDFs
/diagram              → English→Mermaid/Excalidraw/SVG
/scrape               → Structured data extraction
/learn                → Session pattern memory
/pair-agent           → Multi-AI orchestration
/spec                 → Intent→Precise executable specs
/careful              → Safety guardrails (watch before acting)
```

---

## How It Works: The gstack Pipeline

### Workflow Architecture

```
PROJECT STAGE DETECTION
├─ Analyzing: What are we doing?
├─ Brainstorming, Planning, Design, Building, Testing, Shipping, Monitoring?
└─ Automatically suggested skills change based on stage

HABIT LEARNING
├─ /learn: Remembers project patterns
├─ Design taste: Learns your preferences (after 3 iterations)
├─ Common pitfalls: Knows what breaks in your codebase
└─ Role patterns: Learns which roles you use most

AUTOMATIC SKILL ROUTING
├─ Change detected
├─ gstack analyzes: "What type of change is this?"
├─ Routes to appropriate skills
│  ├─ Infrastructure change? → /plan-eng-review
│  ├─ UI change? → /plan-design-review
│  ├─ Adding tests? → /test-audit
│  └─ Pre-shipping? → /ship (which runs /sync + /test + /cso)
└─ Suggests next skill based on context

EVIDENCE-BASED EXECUTION
├─ Review Readiness Dashboard
├─ "Is this change reviewed appropriately?"
├─ "/review found X issues → run /cso for security"
├─ "/design-review rated this 3/10 → iterate before ship"
└─ Auto-suggest next action with evidence

LEARNING MEMORY (/learn)
├─ Project patterns stored
├─ Session-to-session memory
├─ Habits tracked and optimized
└─ Recommendations improve over time
```

---

## Five Core Roles (Auto-Detected)

gstack automatically activates the right roles for each task:

### 1. CEO/Founder
```
Skills: /office-hours, /plan-ceo-review
Responsibility: Strategic rethinking, scope decisions
Questions answered:
  - Should we build this?
  - Is scope realistic?
  - What's the real problem?
  - Should we expand or contract?
```

### 2. Designer
```
Skills: /design-consultation, /plan-design-review, /design-shotgun
Responsibility: Visual quality, design iteration, taste learning
Questions answered:
  - Does this look good?
  - How do we iterate on design?
  - What's our design system?
  - Rate this 0-10?
```

### 3. Eng Manager
```
Skills: /plan-eng-review, /review, /deslop-shared-libs
Responsibility: Architecture decisions, technical debt, code quality
Questions answered:
  - Is architecture sound?
  - What bugs exist?
  - Where's code duplication?
  - Should we refactor?
```

### 4. QA Lead
```
Skills: /qa, /qa-only, /test-audit, /benchmark
Responsibility: Testing, performance, reliability
Questions answered:
  - Does it work?
  - Is it fast?
  - Are tests wasteful?
  - What breaks?
```

### 5. Security Officer
```
Skills: /cso, /investigate
Responsibility: Security audits, vulnerability detection
Questions answered:
  - Are we secure?
  - What's the attack surface?
  - Are we compliant?
  - How do we debug?
```

---

## Integration with Increadible Features #1-3

### Four-Feature Synergy

```
REQUEST ARRIVES
    ↓
[Feature #3] Headroom: Compress context
├─ Code: -73%, JSON: -71%, Logs: -95%
└─ More space for workflow optimization
    ↓
[Feature #2] Claude-Mem: Load project memory
├─ Remember past decisions
├─ Project patterns stored
└─ Continuity across sessions
    ↓
[Feature #1] OmniRoute: Route to optimal provider
├─ Decision: Which provider for this task?
├─ Small context (compressed) = faster decision
└─ Example: Security audit? Route to Claude Opus
    ↓
[Feature #4] gstack: Analyze & suggest workflow
├─ Detect: "What type of change?"
├─ Route: Which skill/role fits?
├─ Learn: Store pattern for future
├─ Suggest: "Next, run /qa for testing"
└─ Execute: Auto-run suggested reviews
    ↓
OPTIMIZED WORKFLOW DELIVERED
├─ Right provider (OmniRoute)
├─ Full context (Claude-Mem)
├─ Minimal tokens (Headroom)
├─ Optimal skill (gstack)
└─ Learned for tomorrow ✅
```

### Cost Impact (All 4 Features)

| Scenario | Cost | What Changed |
|---|---|---|
| Without any features | $1.00 | Baseline |
| + OmniRoute (#1) | $0.10 | Multi-provider routing |
| + Claude-Mem (#2) | $0.03 | Persistent memory |
| + Headroom (#3) | $0.01 | Compression |
| **+ gstack (#4)** | **$0.005-0.01** | **Right skill = minimal waste** |

gstack doesn't reduce tokens directly, but it **eliminates wasted processing** by always using the right skill for the job. CEO review skips infrastructure debugging. Design audits ignore backend changes. This routing intelligence multiplies the savings from features #1-3.

---

## Setup Instructions

### Step 1: Clone gstack

```bash
cd features/04-gstack/gstack
git fetch origin main
git checkout main
```

### Step 2: Install & Configure

```bash
# Install dependencies
npm install
# or
pnpm install

# Copy example environment
cp .env.example .env

# Configure your credentials
# Add ANTHROPIC_API_KEY, etc.
```

### Step 3: Load into Claude Code

Add gstack skills to Claude Code settings:

```json
{
  "skills": {
    "gstack": {
      "enabled": true,
      "skills": [
        "office-hours",
        "plan-ceo-review",
        "plan-eng-review",
        "design-consultation",
        "review",
        "cso",
        "ship",
        "land-and-deploy",
        "qa",
        "learn"
      ],
      "auto_routing": true,
      "habit_learning": true
    }
  }
}
```

### Step 4: Enable Habit Learning

Configure `/learn` skill to track patterns:

```bash
# Initialize project memory
/learn --init-project

# Set your role(s)
/learn --set-role CEO
/learn --set-role Designer
/learn --set-role QA

# Enable auto-suggestions
/learn --enable-suggestions
```

### Step 5: Test Workflow

```bash
# Start a task
/office-hours "Should we add real-time notifications?"

# gstack detects change type and suggests skills:
# → Suggested: /plan-design-review (it's a UI feature)
# → Suggested: /plan-eng-review (architecture impact)

# Run suggested reviews
/plan-design-review
/plan-eng-review

# Build
# Make changes...

# gstack auto-suggests before ship:
# → /review (find bugs)
# → /qa (test it)
# → /cso (security check)

/ship
```

---

## Use Cases

### 1. **Startup MVP Development**
- `/autoplan`: Run all planning reviews in sequence
- Build with full context from all roles
- `/ship`: Deploy with confidence
- **Result**: Ship faster with fewer bugs

### 2. **Design System Iteration**
- `/design-shotgun`: Generate 4-6 variants
- `/learn`: Remember your taste preferences
- Auto-improve variants based on feedback
- **Result**: 3-5x faster design iteration

### 3. **Security-Critical Features**
- `/plan-ceo-review`: Scope the threat model
- `/plan-eng-review`: Architecture audit
- `/cso`: Full security review
- `/investigate`: Root-cause debugging if issues
- **Result**: Production-ready security

### 4. **Large Refactoring**
- `/plan-eng-review`: Lock architecture
- `/deslop-shared-libs`: Identify code to extract
- `/review`: Find bugs introduced
- `/test-audit`: Ensure test health
- **Result**: Safe, quality refactoring

### 5. **Pre-Launch Quality Push**
- `/review`: Find all bugs
- `/qa`: Test everything
- `/benchmark`: Performance baseline
- `/cso`: Security audit
- `/document-release`: Sync docs with changes
- **Result**: Ship with confidence

---

## Configuration Strategies

### Founder Mode (CEO-Heavy)
```yaml
enabled_skills:
  - office-hours
  - plan-ceo-review
  - autoplan
  - retro
primary_role: CEO
auto_routing: true
```
**Best for**: Product decisions, strategy, early-stage

### Engineering Mode (Eng Manager-Heavy)
```yaml
enabled_skills:
  - plan-eng-review
  - review
  - cso
  - test-audit
  - investigate
primary_role: Eng Manager
auto_routing: true
```
**Best for**: Scaling, architecture, quality

### Design Mode (Designer-Heavy)
```yaml
enabled_skills:
  - design-consultation
  - design-shotgun
  - plan-design-review
  - design-html
primary_role: Designer
auto_routing: true
```
**Best for**: UI/UX development, iteration

### Release Mode (All Roles)
```yaml
enabled_skills: all
auto_routing: true
habit_learning: true
review_readiness: true
```
**Best for**: Pre-deployment, production push

---

## Advanced Features

### Habit Learning (/learn)

Tracks and improves over time:

```bash
# Query learned patterns
/learn --show-patterns

# Typical patterns learned:
# - "User prefers aggressive refactoring"
# - "Security is critical in auth flows"
# - "Design iterations average 3 cycles"
# - "Tests need >80% coverage"

# Update learned rules
/learn --update-pattern "Always run /cso for API changes"

# Clear and reset
/learn --reset-project
```

### Automatic Skill Suggestions

Based on project stage and change type:

```
gstack detects: Frontend CSS change
→ Suggests: /plan-design-review, /qa (visual regression)
→ Skip: /plan-eng-review (not architecture)

gstack detects: Database migration
→ Suggests: /plan-eng-review, /investigate (data safety)
→ Skip: /plan-design-review (no UI change)

gstack detects: Security-related change
→ Suggests: /cso, /investigate
→ Auto-prioritize: Run these first
```

### Review Readiness Dashboard

```
Change Type           Required Reviews        Status
─────────────────────────────────────────────────────
API Endpoint          /plan-eng, /cso         ✓ Complete
UI Component          /plan-design, /qa       ✓ Complete
Database Change       /plan-eng, /investigate Pending: /investigate
Documentation         /document-generate      ✓ Complete
────────────────────────────────────────────────────

Ready to Ship? YES ✅
  All required reviews complete
  No blockers detected
  Suggested: /ship
```

---

## Integration Points with Increadible

### How gstack Amplifies Other Features

| Feature | How gstack Helps |
|---|---|
| **OmniRoute (#1)** | Analyzes task type, routes to optimal provider |
| **Claude-Mem (#2)** | Stores workflow patterns, learns habits |
| **Headroom (#3)** | Compressed context = faster skill routing |
| **gstack (#4)** | Orchestrates all other features intelligently |

### Example: Building a Payment Feature

```
1. /office-hours
   ✓ Confirm scope, threat model, API contracts

2. /plan-ceo-review + /plan-eng-review + /plan-design-review
   ✓ OmniRoute auto-routes each to optimal provider
   ✓ Claude-Mem loads payment system patterns
   ✓ Headroom compresses existing code for context

3. /design-shotgun (iterate 3x)
   ✓ gstack learns your design taste
   ✓ Improves variants based on feedback

4. /design-html (build)
   ✓ Compressed context (Headroom) = faster build

5. /review + /qa + /cso
   ✓ Auto-routed to right providers (OmniRoute)
   ✓ Checks against learned patterns (/learn)

6. /ship + /land-and-deploy
   ✓ Automated, documented release

RESULT: Ship faster, safer, smarter ✅
```

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Skills not suggesting | Enable `auto_routing: true`, check enabled skills list |
| Habit learning not working | Run `/learn --init-project`, ensure session persistence |
| Wrong skill routed | Check project type detection, update learned patterns |
| Taste memory not improving | Run 3+ design iterations for `/design-shotgun` |
| Review readiness doesn't show | Verify change tracking is enabled |

---

## Quick Start Checklist

- [ ] Clone gstack repo
- [ ] Run `npm install` or `pnpm install`
- [ ] Configure `.env` with API keys
- [ ] Load skills into Claude Code
- [ ] Initialize `/learn` for habit tracking
- [ ] Set your primary role (CEO, Eng Manager, etc.)
- [ ] Enable auto-routing
- [ ] Test: Run `/office-hours` on a task
- [ ] Observe skill suggestions
- [ ] Run suggested `/plan-*` reviews
- [ ] Monitor habit learning over time

---

## Performance Metrics

### Claimed Productivity Gains

| Metric | Improvement |
|---|---|
| **Code quality** | 3-5x fewer bugs shipped |
| **Review time** | 50% faster (auto-routing) |
| **Iteration speed** | 3-5x (design taste learning) |
| **Planning accuracy** | 2x (CEO review forced questions) |
| **Test health** | 40% fewer wasteful tests |
| **Overall productivity** | **810x** (Garry Tan's metric: logical code changes) |

---

## Next Integration Steps

**With Features #1-4 running together**:
- ✅ OmniRoute: Routes to 357+ providers
- ✅ Claude-Mem: Persistent project memory
- ✅ Headroom: 70% token compression
- ✅ gstack: Habit-aware workflow orchestration

**Next planned**:
- **#5**: Custom Routing Plugins (team-specific rules)
- **#6**: Cost Analytics (track all savings sources)
- **#7**: A/B Testing (compare approaches)

---

## Resources

- **GitHub**: https://github.com/garrytan/gstack
- **Docs in Repo**: AGENTS.md, ARCHITECTURE.md, CLAUDE.md
- **Architecture**: See gstack/ARCHITECTURE.md for detailed system design
- **Features #1-3**: See their integration guides

---

## Advanced Configuration

### Team Setup (Multiple Roles)

```yaml
# .claude/settings.json
{
  "gstack": {
    "team_mode": true,
    "roles": {
      "ceo": { "user": "founder@company.com" },
      "eng_manager": { "user": "tech_lead@company.com" },
      "designer": { "user": "design_lead@company.com" },
      "qa": { "user": "qa_lead@company.com" }
    },
    "auto_routing": true,
    "skill_suggestions": true,
    "review_readiness": true
  }
}
```

### Custom Skill Aliases

```bash
# Create your own shortcuts
/learn --alias ship-secure "/review && /cso && /ship"
/learn --alias design-iterate "/design-shotgun && /plan-design-review"
/learn --alias quality-push "/review && /qa && /test-audit && /benchmark"

# Use them
/ship-secure              # Runs: /review → /cso → /ship
/design-iterate          # Runs: /design-shotgun → /plan-design-review
/quality-push            # Full quality check
```

---

**Feature #4 Status**: ✅ Ready for Integration  
**Compatible With**: Features #1, #2, #3, Claude Code, All Providers  
**Learning**: Automatic habit tracking + pattern optimization  
**Workflow**: Orchestrated across 23 skills + 5 core roles  
**Productivity**: 3-810x gains depending on metric  

**Built for Increadible Feature Collection v1.0**  
**Integration Date**: 2026-10-05  
**Maintainer**: Ashu (hsharma.gxi@gmail.com)
