# Skill Composability

How skills work together and design principles for composable skills.

## What is Skill Composability?

**Composability** means skills can work together automatically without explicitly referencing each other. The agent loads and uses multiple relevant skills simultaneously based on their descriptions and the user's request.

> "While Skills can't explicitly reference other Skills, agents can use multiple Skills together automatically. This composability is one of the most powerful parts of the Skills feature."

---

## How Multi-Skill Invocation Works

### The Progressive Disclosure Flow

```
User Request
    ↓
Agent Reviews Skill Metadata (names + descriptions)
    ↓
Identifies Relevant Skills (based on descriptions)
    ↓
Loads SKILL.md Bodies for Relevant Skills
    ↓
Applies Combined Instructions
    ↓
Accesses Referenced Resources As Needed
```

### Example: Data Analysis Request

**User**: "Analyze our Q4 sales data and create a branded executive report."

**Agent may load**:
1. **data-analysis** skill → Analysis methodology
2. **brand-guidelines** skill → Visual styling rules
3. **excel-creation** skill → Output format handling

Each skill contributes its domain expertise without knowing about the others.

---

## Principles of Composable Skill Design

### 1. Clear, Specific Scope

**Good**: Each skill has a well-defined domain
```yaml
name: data-visualization
description: Create charts and graphs from datasets using matplotlib and seaborn
```

**Bad**: Overlapping or vague scope
```yaml
name: data-stuff
description: Do things with data, make it look good, and create reports
```

**Why**: Clear scope prevents conflicts and makes relevance determination easier.

---

### 2. Descriptive Descriptions

The `description` field determines when skills are loaded. Make it comprehensive.

**Good**: Explains what, when, and triggers
```yaml
description: "Create, edit, and analyze Excel spreadsheets with support for formulas, formatting, charts, and data analysis. Use when working with .xlsx files, financial models, data tables, or when users request spreadsheet operations."
```

**Bad**: Vague or incomplete
```yaml
description: Excel stuff
```

**Why**: The agent uses descriptions to determine which skills are relevant. Poor descriptions lead to skills not being loaded when needed.

---

### 3. Self-Contained Instructions

Skills should provide complete instructions for their domain without assuming other skills exist.

**Good**: Complete within domain
```markdown
# Brand Guidelines Skill

When creating visual content, apply these brand standards:
- Primary colors: #1E3A8A, #FFFFFF
- Fonts: Montserrat for headers, Open Sans for body
- Logo placement: Top left, minimum padding 20px
...
```

**Bad**: Assumes other skills
```markdown
# Brand Guidelines Skill

After creating content using the content-creation skill, apply these styles...
```

**Why**: Skills should be usable independently or in combination. Explicit dependencies break composability.

---

### 4. Orthogonal Concerns

Design skills around **orthogonal** (independent) concerns that can combine multiplicatively.

**Good orthogonal skill set**:
- **content-strategy** → What to say
- **brand-guidelines** → How it should look
- **format-handler** → What format to create

These combine: content × brand × format = composable

**Bad overlapping skill set**:
- **branded-content** → Combines content + brand
- **content-formatting** → Combines content + format
- **brand-formatting** → Combines brand + format

These create conflicts and redundancy.

**Why**: Orthogonal skills combine cleanly without conflicts.

---

### 5. Non-Conflicting Guidance

Skills that may be loaded together should not provide contradictory instructions.

**Conflict example**:
```markdown
# coding-style-skill-a
Always use single quotes for strings.

# coding-style-skill-b
Always use double quotes for strings.
```

**Resolution strategies**:
1. **Defer to user**: "Use single quotes unless project convention differs"
2. **Prioritize by context**: "Single quotes for Python, double for JavaScript"
3. **Consolidate**: Merge into one comprehensive coding-style skill

**Why**: Conflicts create confusion and inconsistent outputs.

---

## Composability Patterns

### Pattern 1: Layer Cake (Different Abstraction Levels)

Skills operate at different levels of abstraction and stack cleanly.

**Example stack**:
```
┌─────────────────────────┐
│  Internal Comms         │ ← Communication style and structure
├─────────────────────────┤
│  Brand Guidelines       │ ← Visual identity and tone
├─────────────────────────┤
│  Document Creation      │ ← File format handling
└─────────────────────────┘
```

Request: "Write a status update for the team"
- **Internal comms** → Provides structure and content guidance
- **Brand guidelines** → Applies visual styling
- **Document creation** → Handles .docx generation

Each layer adds value without conflicting.

---

### Pattern 2: Domain Specialist (Horizontal Specialization)

Skills specialize in different domains that don't overlap.

**Example set**:
- **sql-expert** → Database queries
- **python-expert** → Python programming
- **react-expert** → React development

Request: "Build a dashboard that queries our database"
- **sql-expert** → Provides query guidance
- **react-expert** → Provides UI component guidance
- Neither conflicts because domains don't overlap

---

### Pattern 3: Workflow + Domain (Process × Content)

One skill provides workflow, others provide domain knowledge.

**Example**:
- **code-review** skill → Review process and checklist (workflow)
- **security-expert** skill → Security vulnerability knowledge (domain)
- **performance-expert** skill → Performance optimization knowledge (domain)

Request: "Review this code for security and performance"
- **code-review** → Provides review methodology
- **security-expert** → Provides security criteria
- **performance-expert** → Provides performance criteria

The workflow skill orchestrates; domain skills provide expertise.

---

### Pattern 4: General + Specific (Inheritance-like)

A general skill provides foundations; specific skills add specialization.

**Example**:
- **frontend-design** → General design principles
- **brand-guidelines** → Specific brand requirements

Request: "Design a landing page for our product"
- **frontend-design** → Provides design philosophy and general best practices
- **brand-guidelines** → Overrides with specific brand colors, fonts, logos

Specific overrides general where they overlap.

---

## Designing for Composability

### Do's

✅ **Write self-contained skills** - Complete within their domain
✅ **Use clear, specific descriptions** - Enable accurate triggering
✅ **Focus on orthogonal concerns** - Independent dimensions
✅ **Provide flexible guidance** - "Prefer X unless..." not "Always X"
✅ **Document assumptions** - Make implicit expectations explicit
✅ **Test in combination** - Try using multiple skills together

### Don'ts

❌ **Don't reference other skills explicitly** - Breaks modularity
❌ **Don't assume execution order** - Skills load based on relevance, not sequence
❌ **Don't create hard conflicts** - "Always X" vs "Never X"
❌ **Don't duplicate across skills** - DRY applies to skills too
❌ **Don't make skills too large** - Focused skills compose better
❌ **Don't use vague descriptions** - Poor triggering ruins composition

---

## Handling Skill Overlaps

When skills may overlap, use these strategies:

### Strategy 1: Priority Guidance

```markdown
# General Coding Skill
Use camelCase for variables unless language convention differs.

# Python Coding Skill
Python uses snake_case for variables (per PEP 8).
```

Specific overrides general.

### Strategy 2: Conditional Guidance

```markdown
# Writing Skill
Use active voice unless:
- Academic context requires passive
- Scientific writing conventions apply
- Other style guides specify otherwise
```

Leaves room for other skills to override.

### Strategy 3: Complementary Focus

```markdown
# Accessibility Skill
Focus: Semantic HTML, ARIA labels, keyboard navigation

# Performance Skill
Focus: Loading speed, bundle size, rendering optimization
```

Different concerns, minimal overlap.

### Strategy 4: Explicit Hierarchy

```markdown
# Default Style Skill
These are defaults. Defer to project-specific or brand guidelines if present.
```

Makes priority explicit.

---

## Testing Composability

### Test Scenarios

1. **Individual use**: Does each skill work well alone?
2. **Paired use**: Do likely combinations work well together?
3. **Triple+ use**: Do complex multi-skill scenarios work?
4. **Unexpected combos**: What happens when unusual skills combine?

### Test Questions

- Are there contradictory instructions?
- Is one skill's output appropriate input for another?
- Do skills complement or conflict?
- Is the combined output better than individual outputs?
- Does adding a skill improve or degrade quality?

---

## Common Composability Anti-Patterns

### Anti-Pattern 1: Skill A Calls Skill B

```markdown
# Marketing Skill
After using the brand-guidelines skill, create content...
```

**Problem**: Assumes other skill exists and loaded
**Solution**: Provide complete instructions; let the agent compose automatically

---

### Anti-Pattern 2: Duplicate Instructions

```markdown
# Skill A
Use blue (#0066CC) for primary actions

# Skill B
Use blue (#0066CC) for primary actions
```

**Problem**: Wastes tokens, creates maintenance burden
**Solution**: One skill owns color guidance

---

### Anti-Pattern 3: Hard Conflicts

```markdown
# Skill A
NEVER use semicolons

# Skill B
ALWAYS use semicolons
```

**Problem**: Impossible to satisfy both
**Solution**: Context-conditional guidance or consolidation

---

### Anti-Pattern 4: Circular Dependencies

```markdown
# Skill A
Follow formatting from skill B

# Skill B
Follow structure from skill A
```

**Problem**: Neither is self-sufficient
**Solution**: Each skill must be independently usable

---

## Skill Ecosystem Patterns

### Ecosystem 1: Corporate Knowledge Base

```
Company Skills:
├── brand-guidelines (visual identity)
├── writing-style (communication tone)
├── code-standards (engineering practices)
├── security-policy (security requirements)
└── deployment-process (operations workflow)
```

All composable, all company-specific.

### Ecosystem 2: Technical Stack

```
Development Skills:
├── react-expert (UI framework)
├── typescript-expert (type system)
├── testing-expert (test strategies)
├── ci-cd-expert (deployment)
└── monitoring-expert (observability)
```

Each specialized domain, composable for full-stack work.

### Ecosystem 3: Creative Suite

```
Creative Skills:
├── writing-craft (narrative techniques)
├── visual-design (aesthetic principles)
├── brand-identity (brand application)
├── accessibility (inclusive design)
└── user-research (user insights)
```

Combines for comprehensive creative work.

---

## Best Practices Summary

1. **Scope**: One skill, one clear domain
2. **Description**: Comprehensive and specific
3. **Independence**: Self-contained instructions
4. **Orthogonality**: Non-overlapping concerns when possible
5. **Flexibility**: "Prefer" over "always" to allow composition
6. **Testing**: Test both individual and combined use
7. **Documentation**: Make assumptions explicit
8. **Refinement**: Iterate based on multi-skill performance

---

## Progressive Disclosure and Composability

Composability interacts with progressive disclosure:

```
Skill A (metadata loaded) ──┐
Skill B (metadata loaded) ──┼──→ Agent decides relevance
Skill C (metadata loaded) ──┘
                             ↓
            Loads SKILL.md for A and B (C not relevant)
                             ↓
          Uses A's and B's instructions together
                             ↓
       Loads references from A and B as needed
```

**Design implication**: Descriptions must indicate relevance; bodies must compose well.

---

## Summary

**Composability makes the whole greater than the sum of parts.**

Key principles:
- Skills work together automatically based on descriptions
- Design for independence but allow combination
- Avoid conflicts and explicit cross-references
- Focus on orthogonal concerns
- Test both individual and combined use
- Use flexible guidance that allows override

**The goal**: Create focused, self-contained skills that automatically combine to provide comprehensive capabilities.
