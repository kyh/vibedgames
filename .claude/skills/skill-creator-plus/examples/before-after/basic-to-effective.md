# Transforming a Basic Skill into an Effective One

This example shows how to transform a simple procedural skill into an effective philosophy-driven skill.

---

## BEFORE: Basic Email Writing Skill

```markdown
---
name: email-writer
description: Help write emails
---

# Email Writing

## Steps

1. Write a clear subject line
2. Start with a greeting
3. Write the email body
4. End with a closing
5. Add your signature

## Tips

- Be professional
- Keep it short
- Proofread before sending
```

### Problems with This Skill

- ❌ Vague description ("Help write emails")
- ❌ Pure procedural checklist
- ❌ No philosophy or mental model
- ❌ No anti-patterns
- ❌ No variation guidance
- ❌ Generic advice ("be professional")
- ❌ Doesn't prevent common mistakes
- ❌ No context awareness

**analyze_skill.py score**: ~25/100

---

## AFTER: Effective Email Writing Skill

```markdown
---
name: email-writing
description: "Write effective professional emails with appropriate tone, structure, and clarity. Use when composing business emails, internal communications, external correspondence, or when users request help writing emails for professional contexts."
---

# Email Writing Skill

## Philosophy: Clarity and Respect

Effective emails respect the recipient's time and attention:

**Before writing, ask**:
- **Purpose**: What action or response do I need?
- **Audience**: What's the recipient's context and priorities?
- **Tone**: What relationship and formality level is appropriate?

**Core principle**: Every email should be **scannable** (key info visible quickly) and **actionable** (clear next steps).

## Email Structure Framework

### Subject Line
- **Specific and actionable**: "Q4 Budget Review - Need approval by Friday"
- **Not vague**: "Question" or "Following up"
- **Include urgency if relevant**: "URGENT:" or "[Action Required]"

### Opening
Adapt based on context:

**Internal/familiar**: Direct and friendly
```
Hi Sarah,

Quick question about the deployment schedule...
```

**External/formal**: Professional and respectful
```
Dear Dr. Martinez,

Thank you for your email regarding the partnership proposal. I'd like to address your questions about...
```

**Cold outreach**: Value-first
```
Hi Alex,

I noticed your team is working on X. We recently solved a similar challenge with Y approach that reduced costs by 30%...
```

### Body
- **One main point per paragraph**
- **Use bullets for multiple items** (increases scannability)
- **Bold key information** that needs attention
- **Keep paragraphs to 2-3 sentences**

### Closing
Match the opening in formality:
- Internal: "Thanks!" or "Let me know"
- External: "Best regards," or "Sincerely,"
- Include clear call-to-action: "Please confirm by EOD Thursday"

## Anti-Patterns to Avoid

❌ **Buried lede**: Important request at the end
```
Hi team, how was your weekend? I've been thinking about the project timeline
and wanted to share some thoughts on the approach we discussed last week...
BY THE WAY, the client needs this delivered by tomorrow.
```

✅ **Lead with what matters**:
```
Hi team, heads up: client needs this delivered by tomorrow.

Here's the plan: [...]
```

❌ **Wall of text**: No paragraph breaks, dense prose
❌ **Vague requests**: "Let me know your thoughts"
❌ **Unnecessary formality**: "Per our discussion, please be advised that..."
❌ **Emotional language when upset**: Wait, rewrite when calm
❌ **Reply-all abuse**: Check who actually needs to see this
❌ **No clear next step**: Reader doesn't know what action to take

## Context-Specific Variation

**IMPORTANT**: Emails should vary based on context. Don't use the same structure and tone for every email.

**When delivering bad news**:
- Start with context/empathy
- Be direct about the news (don't bury it)
- Explain reasoning
- Offer alternatives or next steps

**When requesting something**:
- Lead with the request
- Explain why it matters
- Make it easy to say yes (provide options, deadlines, context)

**When sharing information**:
- Use "TLDR" or executive summary at top
- Detailed information below for those who need it
- Clearly mark optional vs. required reading

**When following up**:
- Reference previous email
- Restate the question/request
- Assume good faith (people are busy)
- Provide new information or deadline

## Quality Checklist

Before sending, verify:
- [ ] Subject line is specific and actionable
- [ ] Main point is clear in first 2 sentences
- [ ] Request or purpose is explicit
- [ ] Next steps are clear
- [ ] Tone matches relationship and context
- [ ] Length is appropriate (shorter is usually better)
- [ ] Key information is bold or bulleted
- [ ] Proofread for typos and tone

## Remember

Email is a tool for clear, respectful communication. These guidelines help achieve that—they're not rigid rules. Use judgment based on your specific context and relationship with the recipient.
```

### Improvements Made

✅ **Clear, comprehensive description** with specific use cases
✅ **Philosophy established first** (clarity and respect)
✅ **Pre-writing questions** to establish context
✅ **Organized by section** (subject, opening, body, closing)
✅ **Explicit anti-patterns** with examples
✅ **Context-specific variation** guidance
✅ **Concrete examples** (not vague advice)
✅ **Empowering tone** ("use judgment")

**analyze_skill.py score**: ~78/100

---

## Key Transformations

| Aspect | Basic Version | Effective Version |
|--------|--------------|-------------------|
| **Philosophy** | None | Clarity and respect framework |
| **Structure** | Linear checklist | Categorized guidelines with rationale |
| **Anti-patterns** | None | Explicit examples of what to avoid |
| **Variation** | Implied | Explicit context-specific guidance |
| **Examples** | None | Concrete before/after examples |
| **Tone** | Prescriptive | Empowering with judgment |
| **Length** | 50 lines | 150 lines (but much more valuable) |

---

## What This Demonstrates

1. **Philosophy transforms checklists** into mental frameworks
2. **Anti-patterns are as important** as positive guidance
3. **Context-specific variation** prevents one-size-fits-all
4. **Concrete examples** beat abstract advice
5. **Organization aids understanding** and execution
6. **Length matters less than value** - 150 lines of good guidance > 50 lines of generic advice

The effective version doesn't just tell you **what** to do—it teaches you **how to think** about email writing in a way that transfers to novel situations.
