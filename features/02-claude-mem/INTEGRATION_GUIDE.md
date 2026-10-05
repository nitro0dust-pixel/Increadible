# Claude-Mem × Claude Desktop Integration Guide

## Feature: Persistent Memory & Context Management for AI Agents

**Version**: 1.0  
**Status**: Ready for Integration  
**Category**: Agent Intelligence / Memory Management  
**Built by**: [thedotmack](https://github.com/thedotmack)

---

## What is Claude-Mem?

Claude-Mem is a **persistent memory system** that captures agent activities, compresses them with AI, and automatically reinserts relevant context into future sessions. Instead of losing context when sessions end, your Claude agents now have **continuous memory** — like human long-term memory.

### Core Problem It Solves

| Without Claude-Mem | With Claude-Mem |
|---|---|
| Each session starts fresh | Agent remembers all previous work |
| Context lost between disconnects | Seamless continuity across sessions |
| Manual note-taking of context | Automatic memory capture & retrieval |
| No history search | Natural language search through all memories |
| High token usage (re-explain context) | 10x token savings via smart retrieval |

---

## Key Features

### 1. **Persistent Memory Across Sessions**
```
Session 1 (Day 1)
├─ Agent works on "User Auth System"
├─ Makes decisions, creates files
└─ Session ends

                    [Memory Stored]

Session 2 (Day 2, next week)
├─ Agent resumes: "Remember that auth system?"
├─ Automatically loads context
└─ Continues where it left off ✅
```

### 2. **Progressive Disclosure (Token Efficient)**
Three-layer context retrieval optimizes token usage:

```
Layer 1: Search Index
├─ What memory exists? (~50-100 tokens)
├─ Returns compact index with IDs
└─ Cost: Minimal

Layer 2: Timeline
├─ What happened around this time? (~200-500 tokens)
├─ Shows chronological context
└─ Cost: Medium

Layer 3: Full Details
├─ What exactly happened? (~1000+ tokens)
├─ Only fetch when really needed
└─ Cost: High (but rare)

Result: 10x token savings vs fetching everything
```

### 3. **Natural Language Search**
```bash
# Search through all memories naturally
mem-search "How did we handle the database migration?"
→ Finds relevant observations from past sessions
→ Includes citations with observation IDs
→ Shows timeline of events
```

### 4. **Privacy Controls**
Sensitive data doesn't get stored:

```markdown
User API Key: sk-abc123xyz...

<private>
This is sensitive and shouldn't be saved to memory.
Only visible in current session.
</private>
```

### 5. **Automatic Operation**
No manual setup per session — Claude-Mem works automatically:
- Captures activities via lifecycle hooks
- Compresses with AI (summaries not raw logs)
- Injects relevant context at session start
- Updates memory at session end

---

## How It Works (Architecture)

### Five Core Components

```
┌─────────────────────────────────────────────┐
│  Claude Desktop / Claude Code               │
│  (Your AI agent environment)                │
└────────────────┬────────────────────────────┘
                 │
    ┌────────────┴────────────┐
    ↓                          ↓
[Lifecycle Hooks]      [MCP Tools]
├─ SessionStart         ├─ search
├─ UserPromptSubmit     ├─ timeline
├─ PostToolUse          ├─ get_observations
├─ Stop                 └─ mem_search
└─ SessionEnd
    │                      │
    └──────────┬───────────┘
               ↓
        [Worker Service]
    (Local HTTP API + UI)
    Runs on Bun runtime
               │
        ┌──────┴──────┐
        ↓             ↓
    [SQLite DB]   [Chroma Vector DB]
    ├─ Sessions    ├─ Semantic search
    ├─ Activities  ├─ Keyword search
    └─ Summaries   └─ Dense embeddings
```

### Data Flow Example

```
1. Agent works on task
   ↓
2. Tool usage captured (SessionEnd hook)
   ↓
3. Claude compresses into summary
   ↓
4. Stored in SQLite + vectorized in Chroma
   ↓
5. Next session starts
   ↓
6. Relevant memories retrieved (if useful)
   ↓
7. Injected into system prompt
   ↓
8. Agent continues with full context ✅
```

---

## Integration with OmniRoute (Feature #1)

Claude-Mem works beautifully with OmniRoute:

| Feature | Synergy |
|---------|---------|
| **OmniRoute routing** | Selects best provider for queries |
| **Claude-Mem context** | Feeds relevant history to chosen provider |
| **Result** | Right provider, right context, every time |

**Example workflow**:
```
New session starts
   ↓
Claude-Mem retrieves: "User was building an auth system"
   ↓
OmniRoute decides: "This is complex → use Claude Opus"
   ↓
Claude Opus gets: Task + full context + memory
   ↓
Best quality + lowest latency ✅
```

---

## Setup Instructions

### Step 1: Install Claude-Mem

```bash
cd features/02-claude-mem/claude-mem

# Follow claude-mem README for detailed installation
# Typically involves:
# - Install Node.js / Bun
# - Run setup script
# - Configure lifecycle hooks
```

### Step 2: Configure Claude Desktop

Add claude-mem MCP server to Claude Desktop:

```json
{
  "mcpServers": {
    "claude-mem": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "path/to/claude-mem/worker.ts"],
      "tools": [
        "search",
        "timeline",
        "get_observations",
        "mem_search"
      ]
    }
  }
}
```

### Step 3: Enable Lifecycle Hooks

Configure hooks in your Claude Desktop / Claude Code setup:

```yaml
hooks:
  sessionStart: "Load relevant memories"
  userPromptSubmit: "Capture user intent"
  postToolUse: "Record tool results"
  stop: "Save session state"
  sessionEnd: "Compress & archive memories"
```

### Step 4: Test Memory Persistence

```bash
# Session 1
# Create a task or run code
# Session ends

# Session 2 (next day)
# Send: "What were we working on last time?"
# Claude-Mem returns: [Relevant memories with citations]
# ✅ Memory working!
```

---

## Use Cases

### 1. **Long-Running Projects**
- Agent works on large codebase over weeks
- Remembers all design decisions, refactorings, issues
- No context loss despite session breaks
- **Result**: Continuous productivity

### 2. **Multi-Session Debugging**
- Session 1: Identify bug, collect logs
- Session 2: Analyze root cause using past logs
- Session 3: Implement fix with full context
- **Result**: Efficient bug resolution without re-explaining

### 3. **Research & Documentation**
- Agent gathers info from multiple sources
- Compresses findings into memory
- Later sessions reference findings
- **Result**: Knowledge base built progressively

### 4. **Team Collaboration**
- Agent 1 starts project, stores decisions in memory
- Agent 2 picks up work next day
- Auto-loads context from Agent 1
- **Result**: Seamless handoff between agents

### 5. **Cost Optimization** (via 10x token savings)
- Simple queries: Use free models (from OmniRoute)
- Context already in memory (compressed)
- Fewer tokens needed per request
- **Result**: 80-90% cost reduction vs re-explaining context

---

## Token Savings Example

### Without Claude-Mem (Per Session)
```
User: "Continue the authentication system"
Agent: "Wait, what auth system?"
User: [Re-explains 2000 tokens of context]
Claude processes: [2000 + 500 = 2500 tokens]
Cost: $0.075
```

### With Claude-Mem (Per Session)
```
Session starts
Claude-Mem loads: "Auth system in progress" (~200 tokens, pre-compressed)
User: "Continue the authentication system"
Agent: [Understands immediately]
Claude processes: [200 + 200 = 400 tokens]
Cost: $0.012
Progress: 5x cost reduction ✅
```

**Across 10 sessions per week = $0.75 → $0.12 = 84% savings**

---

## Integration with Future Features

Claude-Mem enables Feature #3 and beyond:

| Future Feature | How Claude-Mem Helps |
|---|---|
| **#3: Cost Analytics** | Tracks memory-enabled cost reduction |
| **#4: A/B Testing** | Compares agent performance with/without memory |
| **#5: Local Models** | Local models + memory = instant smart responses |
| **#6: Prompt Caching** | Cache compressed memory across requests |
| **#7: Multi-Provider Streaming** | Stream from provider with best memory context |

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Memories not persisting | Check SQLite DB path; verify SessionEnd hook fires |
| Vector search slow | Index Chroma DB; check embedding model |
| Token usage still high | Enable Progressive Disclosure Layer 1 first |
| Memory too detailed | Increase compression level in AI summarization |
| Privacy leak | Use `<private>` tags for sensitive data |

---

## Configuration Examples

### Ultra-Lightweight (Minimal Memory)
```yaml
compression: aggressive  # Only store key decisions
layers: 1                # Use only Layer 1 (compact index)
retention: 7             # Keep 7 days of history
```

### Full-Featured (Maximum Context)
```yaml
compression: minimal     # Store detailed observations
layers: 3                # Use all three layers
retention: 90            # Keep 3 months of history
embedding_model: claude  # Use Claude for embeddings
```

### Cost-Optimized (Token Savings Focus)
```yaml
compression: medium
layers: 2                # Skip Layer 3 (full details)
retention: 30
search_ranking: relevance # Show most relevant first
```

---

## Quick Start Checklist

- [ ] Clone claude-mem
- [ ] Install dependencies (Node/Bun)
- [ ] Configure MCP server in Claude Desktop
- [ ] Enable lifecycle hooks
- [ ] Test: Run 2 sessions and check memory persistence
- [ ] Configure compression level
- [ ] Enable natural language search
- [ ] Set privacy rules for sensitive data
- [ ] Monitor token usage
- [ ] Combine with OmniRoute for multi-model + memory

---

## Resources

- **GitHub**: https://github.com/thedotmack/claude-mem
- **MCP Protocol**: https://modelcontextprotocol.io/
- **Claude Documentation**: https://claude.ai/code
- **OmniRoute Integration**: See Feature #1 guide

---

## Next Feature Integration

Once Claude-Mem + OmniRoute work together:
- **Feature #3**: Cost Analytics Dashboard (visualize memory savings)
- **Feature #4**: A/B Testing (compare performance with/without memory)
- **Feature #5**: Local Model Marketplace (use local models with memory)

---

**Feature #2 Status**: ✅ Ready for Integration  
**Compatible With**: Claude Code, Claude Desktop, Multiple AI Models  
**Token Savings**: 10x average via Progressive Disclosure  
**Memory Retention**: Configurable (7-90+ days)

**Built for Increadible Feature Collection v1.0**  
**Integration Date**: 2026-10-05  
**Maintainer**: Ashu (hsharma.gxi@gmail.com)
