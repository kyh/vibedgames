# Skill Anti-Patterns

Common mistakes when creating skills and how to avoid them.

## 1. Template Trap

**Anti-Pattern**: Creating rigid templates that constrain creativity and force the agent into a template-filling role.

**Problem**:
- Reduces the agent to mechanical slot-filling
- Produces generic, cookie-cutter outputs
- Limits adaptation to context
- Results in "AI slop" aesthetics

**Example**:
```markdown
Always use this exact structure:
1. Title: [INSERT TITLE]
2. Introduction: [WRITE 2 PARAGRAPHS]
3. Body: [WRITE 3 SECTIONS]
4. Conclusion: [SUMMARIZE]
```

**Better Approach**:
```markdown
Structure your document based on the content and audience:
- Consider what structure best serves the purpose
- Adapt sections to the context
- Vary depth and organization based on complexity
- Use judgment rather than following a rigid template
```

---

## 2. Checklist Syndrome

**Anti-Pattern**: Providing rules without underlying philosophy or explaining why.

**Problem**:
- No mental framework to guide decisions
- Can't adapt to novel situations
- Lacks principled decision-making
- Follows rules blindly without understanding

**Example**:
```markdown
Code Review Checklist:
☐ Check for syntax errors
☐ Verify variable names
☐ Test all functions
☐ Add comments
```

**Better Approach**:
```markdown
## Code Review Philosophy

Before diving into specifics, understand what makes a good review:
- **Purpose**: Catch bugs early and improve code quality
- **Mindset**: Constructive collaboration, not criticism
- **Focus**: High-impact issues first, style issues second

With this foundation, review code systematically...
```

---

## 3. Generic Guidance Syndrome

**Anti-Pattern**: Advice so vague it applies to everything but helps with nothing.

**Problem**:
- No actionable specifics
- Could apply to any domain
- Doesn't prevent common mistakes
- Adds tokens without adding value

**Example**:
```markdown
Write good code.
Make it readable.
Use best practices.
Test thoroughly.
```

**Better Approach**:
```markdown
## React Component Best Practices

- **Use functional components with hooks** rather than class components
- **Extract custom hooks** when logic is reused across 3+ components
- **Memoize expensive calculations** with useMemo when render cost >10ms
- **Avoid prop drilling >2 levels deep** - use Context or state management instead
```

---

## 4. Context Blindness

**Anti-Pattern**: Same approach regardless of situation, ignoring context-specific needs.

**Problem**:
- One-size-fits-all thinking
- Misses situational nuances
- Produces inappropriate solutions
- Fails to adapt to constraints

**Example**:
```markdown
Always use microservices architecture.
Always write tests first.
Always optimize for performance.
```

**Better Approach**:
```markdown
## Architecture Decision Framework

Choose architecture based on context:

**Monolith when**:
- Team <10 people
- Single domain
- Fast iteration priority

**Microservices when**:
- Multiple autonomous teams
- Different scaling needs per service
- Clear bounded contexts

**Consider hybrid** for evolving systems
```

---

## 5. Over-Engineering Trap

**Anti-Pattern**: Too many rules, constraints, and complexity for simple domains.

**Problem**:
- Overwhelming cognitive load
- Analysis paralysis
- Adds complexity without value
- Slows down simple tasks

**Example**:
```markdown
# Email Writing Skill (500 lines)

## Grammar Rules (50 rules)
## Tone Guidelines (30 variations)
## Structure Templates (20 templates)
## Cultural Considerations (40 contexts)
## Legal Disclaimers (10 scenarios)
...
```

**Better Approach**:
```markdown
# Email Writing Skill

## Core Principles
- Clear subject line
- Concise opening
- Actionable content
- Appropriate tone for audience

Adapt based on context. Professional emails are more formal, internal emails can be casual.
```

---

## 6. Under-Engineering Trap

**Anti-Pattern**: Too few guidelines for complex, fragile domains.

**Problem**:
- Missing critical details
- Error-prone execution
- Inconsistent quality
- Lacks necessary structure

**Example**:
```markdown
# Complex Financial Modeling Skill

Just build a financial model. Make sure it's accurate.
```

**Better Approach**:
```markdown
# Financial Modeling Skill

## Core Principles
[Establish philosophy]

## Model Structure
- Historical data validation (min 3 years)
- Assumption documentation with sources
- Sensitivity analysis on key drivers
- Audit trail for all formulas

## Common Errors to Avoid
- Circular references without iteration limits
- Hardcoded values instead of assumptions
- Missing error checking on external data
...

See references/financial-modeling-standards.md for detailed guidelines
```

---

## 7. Favorite Patterns Convergence

**Anti-Pattern**: Converging on repeated "favorite" choices across outputs.

**Problem**:
- Same fonts, colors, structures every time
- Lack of creative diversity
- Predictable, boring outputs
- Generic "AI aesthetic"

**Example**:
```markdown
# Design Skill

Always use:
- Font: Inter
- Colors: Purple gradient on white
- Layout: Centered with rounded corners
```

**Better Approach**:
```markdown
# Design Skill

## Typography
Choose fonts based on brand and purpose. Vary your choices:
- **Distinctive display fonts** for headers
- **Refined body fonts** for readability
- **NEVER default to Inter, Roboto, or Arial**
- Different font for each project

## Color Approach
- Commit to a cohesive palette per project
- Vary drastically between projects
- Avoid purple gradients (overused)
- Let context drive color choices
```

---

## 8. Duplication Between SKILL.md and References

**Anti-Pattern**: Same information appears in both SKILL.md and reference files.

**Problem**:
- Wastes context window
- Creates maintenance burden
- Confusing which is authoritative
- Inefficient progressive disclosure

**Example**:
```markdown
# SKILL.md
## API Reference
[500 lines of API documentation]

# references/api-docs.md
[Same 500 lines repeated]
```

**Better Approach**:
```markdown
# SKILL.md
## Using the API

For complete API reference, see references/api-docs.md

Quick start:
[50 lines of essential workflow]

# references/api-docs.md
[500 lines of detailed API documentation]
```

---

## 9. Missing Negative Guidance

**Anti-Pattern**: Only showing what TO do, never what NOT to do.

**Problem**:
- Common pitfalls not prevented
- Repeating known mistakes
- No warnings about fragile areas
- Missing critical "don't" knowledge

**Example**:
```markdown
# SQL Query Skill

Write efficient queries:
- Use indexes
- Join tables properly
- Select only needed columns
```

**Better Approach**:
```markdown
# SQL Query Skill

## Write Efficient Queries
- Use indexes on frequently queried columns
- Join tables on indexed foreign keys
- Select only needed columns

## Common Mistakes to AVOID
- ❌ NEVER use SELECT * in production queries
- ❌ DON'T join without indexes (causes table scans)
- ❌ AVOID N+1 queries (use joins or batch loading)
- ❌ DON'T compare dates without normalizing timezones
```

---

## 10. Neglecting Variation Instructions

**Anti-Pattern**: Not explicitly telling the agent that outputs should vary.

**Problem**:
- Model may develop "favorite" patterns
- Outputs become predictable
- Less creative exploration
- Convergence on safe choices

**Example**:
```markdown
# Presentation Skill

Create slides with clear titles, bullet points, and visuals.
```

**Better Approach**:
```markdown
# Presentation Skill

Create slides with clear titles, content, and visuals.

**IMPORTANT: Vary your approach**
- Different presentations should look different
- Adapt to audience and purpose
- Avoid converging on the same layout/style
- Professional presentations are not all alike
```

---

## Summary: How to Avoid These Anti-Patterns

1. **Provide frameworks, not templates** - Guide thinking, don't constrain outputs
2. **Establish philosophy before rules** - Mental models beat checklists
3. **Be specific and actionable** - Generic advice wastes tokens
4. **Adapt to context** - One size doesn't fit all
5. **Match complexity to domain** - Simple for simple, complex for complex
6. **Encourage variation explicitly** - Tell the agent outputs should differ
7. **Use progressive disclosure** - SKILL.md for essentials, references for details
8. **Include anti-patterns** - What NOT to do is as important as what to do
9. **Balance freedom and structure** - Enough guidance without over-constraining
10. **Think "unlock vs constrain"** - Best skills unlock capabilities

## When to Break These Rules

These are guidelines, not rigid laws. Break them when:
- The domain truly requires rigid structure (e.g., legal compliance)
- Templates are requested explicitly by users
- Safety/security demands strict constraints
- The context justifies an exception

The key is **intentional choice**, not accidental anti-patterns.
