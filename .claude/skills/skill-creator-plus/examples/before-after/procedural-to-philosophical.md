# From Procedural to Philosophical

This example shows the transformation from "do A, then B, then C" to "think about X, consider Y, then decide approach."

---

## BEFORE: Procedural Code Review Skill

```markdown
---
name: code-review
description: Review code
---

# Code Review

## Code Review Steps

1. Read the code changes
2. Check for syntax errors
3. Verify variable names are descriptive
4. Check for proper indentation
5. Look for code duplication
6. Verify functions are documented
7. Check for security issues
8. Test the changes
9. Leave comments
10. Approve or request changes
```

### Problems

- Pure procedural checklist
- No "why" behind any step
- No priority guidance
- No context awareness
- Mechanical approach
- No philosophy

---

## AFTER: Philosophical Code Review Skill

```markdown
---
name: code-review
description: "Perform thoughtful, constructive code reviews that improve both code quality and team collaboration. Use when reviewing pull requests, providing code feedback, or conducting technical assessments."
---

# Code Review Skill

## Philosophy: Collaborative Improvement

Code review is not about catching mistakes—it's about collaborative learning and quality improvement.

**Mental model**: Think of code review as **mentorship through asynchronous conversation**.
- **Good reviews** teach and explain why
- **Great reviews** make both reviewer and author better
- **Poor reviews** just point out problems without context

### Core Principles

1. **Kindness and Respect**: You're reviewing code, not judging the person
2. **Explain the Why**: Don't just say "this is wrong"—explain why it matters
3. **Distinguish Must vs. Nice**: Blocking issues vs. suggestions
4. **Teach, Don't Command**: Share knowledge, not orders

## Pre-Review Questions

Before diving into line-by-line review, understand context:

- **What's the purpose?** Feature, bug fix, refactor, experiment?
- **What's the scope?** Should this PR be smaller?
- **What's the risk?** Customer-facing vs. internal tooling?
- **Who's the author?** Junior needing mentorship vs. senior with context you lack?

Context shapes review approach.

## Review Philosophy: Layers of Importance

Review in layers, from most to least critical:

### Layer 1: Correctness (CRITICAL - Must Fix)
Does this code work correctly?
- **Logic errors** that produce wrong results
- **Security vulnerabilities** (injection, auth bypass, data leaks)
- **Data corruption** risks
- **Race conditions** or concurrency bugs

**Tone**: Direct and explanatory
```
❌ This causes a SQL injection vulnerability.
✅ This is vulnerable to SQL injection because user input isn't sanitized.
   Use parameterized queries instead: cursor.execute("SELECT * FROM users WHERE id = ?", [user_id])
```

### Layer 2: Architecture (HIGH - Usually Fix)
Does this fit the system well?
- **Wrong abstraction level** (too specific or too generic)
- **Breaks existing patterns** without good reason
- **Creates tight coupling** that makes changes harder
- **Violates SOLID principles** in ways that matter

**Tone**: Questioning and explanatory
```
❌ This is the wrong abstraction.
✅ This couples payment processing directly to the controller. Consider extracting
   to a PaymentService—it'll make testing easier and let us reuse this logic in
   the batch payment flow we're planning.
```

### Layer 3: Clarity (MEDIUM - Should Fix)
Will the next person understand this?
- **Unclear naming** that obscures intent
- **Missing documentation** for non-obvious behavior
- **Complex logic** that needs comments
- **Inconsistent patterns** with surrounding code

**Tone**: Suggesting improvements
```
❌ Rename this variable.
✅ Consider renaming 'data' to 'userPreferences'—it's clearer about what's stored
   and makes this line easier to understand: updateProfile(userPreferences)
```

### Layer 4: Style (LOW - Nice to Have)
Does this match our conventions?
- **Formatting** (spacing, line length)
- **Style preferences** (trailing commas, quote style)
- **Naming conventions** (camelCase vs snake_case per language)

**Tone**: Nit-pick labeled, not blocking
```
nit: Add trailing comma for easier git diffs in future
(not blocking, can fix in future PR)
```

## Anti-Patterns in Reviews

### ❌ Gatekeeping Without Explanation
```
This is wrong. Please fix.
```

**Why bad**: No learning, creates frustration

**Better**:
```
This approach has an edge case: when X happens, Y breaks because Z.
Consider handling X explicitly before this check. Happy to pair on this if helpful!
```

### ❌ Style Nitpicking That Blocks PRs
```
Request changes: You used double quotes instead of single quotes.
```

**Why bad**: Wastes time on low-impact issues

**Better**:
```
nit: Our style guide prefers single quotes (can auto-fix with prettier)
Approving—please run prettier before merging. Not blocking.
```

### ❌ Reviewing Code You Don't Understand
```
Looks good to me! ✅
```

**Why bad**: Rubber-stamping without understanding

**Better**:
```
I'm not familiar with this payment API. Can you walk me through the error
handling strategy? Specifically, what happens if the payment succeeds but
the webhook fails?
```

### ❌ Rewriting in Your Style
```
I would have done this completely differently. Please rewrite using [my approach].
```

**Why bad**: Preference isn't requirement

**Better**:
```
Interesting approach! I usually use [alternative approach] because [reason].
Either works here—your call.
```

### ❌ Assuming Malice or Incompetence
```
Why didn't you just...? This makes no sense.
```

**Why bad**: Assumes context and attacks competence

**Better**:
```
Help me understand the reasoning here—I'm seeing X but expected Y.
Is there a constraint I'm missing?
```

## Context-Adaptive Review Strategies

**IMPORTANT**: Review approach should vary based on context.

### Reviewing Junior Developer Code
- **Mentor actively**: Explain patterns and why
- **Provide resources**: Link to docs, examples
- **Separate learning from blocking**: "This works, but here's a pattern to learn..."
- **Praise good decisions**: Positive reinforcement

### Reviewing Senior Developer Code
- **Ask questions**: Assume there's context you're missing
- **Focus on high-level**: Architecture over style
- **Share knowledge**: "I learned X recently that might apply..."
- **Respect expertise**: They may know better

### Reviewing Urgent Hotfix
- **Security and correctness only**: Skip style
- **Fast turnaround**: Don't block on nice-to-haves
- **Follow-up PR**: Note improvements for later
- **Verify the fix works**: Test the specific bug

### Reviewing Experimental/Prototype Code
- **Approach over implementation**: Focus on direction
- **Lighter touch**: It's exploration, not production
- **Ask questions**: Understand the experiment goals
- **Encourage learning**: Try weird things in experiments

## The Feedback Sandwich (Anti-Pattern)

❌ **Don't use the "feedback sandwich"** (praise → criticism → praise)

**Why**: Feels manipulative and dilutes real issues

**Instead**: Be genuine
- Praise when it's earned: "This error handling is excellent"
- Be direct but kind about issues: "This has a security concern..."
- Keep them separate

## Positive Reviews Matter

When code is good, say so and explain why:

```
✅ This is really clean. I especially like:
   - Error handling covers all edge cases
   - Naming makes the business logic obvious
   - Tests are comprehensive and readable

No changes needed. Great work!
```

## Remember

Code review is a **conversation**, not a **judgment**.

These guidelines help you be a thoughtful reviewer—they don't replace thinking about the specific code and context in front of you. When in doubt, be kind and explain your reasoning.
```

### What Changed

| Aspect | Procedural | Philosophical |
|--------|-----------|--------------|
| **Approach** | Do steps 1-10 | Understand context, review in layers |
| **Guidance** | What to check | Why it matters and how to prioritize |
| **Tone** | Mechanical | Thoughtful and context-aware |
| **Learning** | Checklist to follow | Mental model to internalize |
| **Flexibility** | One process | Adapt to context |
| **Focus** | Find problems | Collaborative improvement |

---

## Key Insights

### 1. Philosophy Provides Priority

**Procedural**: All 10 steps equal priority
**Philosophical**: Security > Architecture > Clarity > Style

### 2. Context Shapes Approach

**Procedural**: Same process every time
**Philosophical**: Junior vs senior, hotfix vs feature, experiment vs production

### 3. Why Matters

**Procedural**: "Check for security issues"
**Philosophical**: "This is vulnerable to SQL injection because... use parameterized queries instead..."

### 4. Mental Model Transfers

**Procedural**: Only works for exact situation described
**Philosophical**: "Code review as mentorship" applies to novel situations

### 5. Empowers Rather Than Constrains

**Procedural**: Follow these 10 steps
**Philosophical**: Think about these principles, adapt to context

---

## The Transformation Pattern

```
PROCEDURAL SKILL:
1. Do A
2. Do B
3. Do C

↓ Transform to ↓

PHILOSOPHICAL SKILL:

## Philosophy
[Why this domain exists, mental model]

## Before Acting
[Questions to understand context]

## Guiding Principles
[How to think about decisions]

## Approaches
[When to use different strategies]

## Anti-Patterns
[Common mistakes and why]

## Remember
[Empowering conclusion]
```

---

## Summary

Procedural skills create **checklist-followers**.
Philosophical skills create **thoughtful practitioners**.

The shift is from:
- **What** to do → **Why** and **when** to do it
- **Steps** → **Mental frameworks**
- **Mechanical** → **Thoughtful**
- **One-size-fits-all** → **Context-adaptive**
- **Constraining** → **Empowering**

This is the core transformation that makes skills effective.
