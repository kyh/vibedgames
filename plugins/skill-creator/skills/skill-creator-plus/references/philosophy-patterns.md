# Philosophy Patterns for Skills

How to establish philosophical foundations that guide effective skill execution.

## What is a Skill Philosophy?

A skill philosophy is the **mental framework** that guides decision-making within the skill's domain. It answers:
- **Why** - Why does this skill exist? What problem does it solve?
- **How** - What's the underlying approach or mindset?
- **When** - When should different strategies be applied?

**Philosophy comes before procedure.** It provides the "thinking system" that makes procedures meaningful.

---

## Pattern 1: Pre-Action Questions

Establish questions to ask before taking action. This creates a thinking framework.

### Template
```markdown
## Before [Taking Action]

Ask these questions to guide your approach:
- **[Question 1]**: What is the purpose/goal?
- **[Question 2]**: Who is the audience/user?
- **[Question 3]**: What are the constraints?
- **[Question 4]**: What makes this [unique/memorable/effective]?
```

### Example: frontend-design Skill
```markdown
## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic...
- **Constraints**: Technical requirements (framework, performance, accessibility)
- **Differentiation**: What makes this UNFORGETTABLE?
```

### Why It Works
- Forces contextual thinking before execution
- Prevents jumping to solutions prematurely
- Creates a decision framework
- Guides choices throughout the process

---

## Pattern 2: Guiding Principles

Establish core principles that apply across the domain.

### Template
```markdown
## Core Principles

1. **[Principle 1]**: [Explanation and why it matters]
2. **[Principle 2]**: [Explanation and why it matters]
3. **[Principle 3]**: [Explanation and why it matters]

These principles should guide all decisions in this domain.
```

### Example: Code Review Philosophy
```markdown
## Core Principles

1. **Collaborative, not Critical**: Reviews improve code AND developers. Frame feedback constructively.
2. **High-Impact First**: Focus on bugs and architecture before style nitpicks.
3. **Explain the Why**: Don't just point out issues—explain why they matter.
4. **Consistency Over Perfection**: Team consistency beats individual "perfect" code.
```

### Why It Works
- Provides decision-making criteria
- Creates shared understanding
- Guides prioritization
- Helps handle edge cases

---

## Pattern 3: Mental Models

Establish a mental model or metaphor that shapes thinking.

### Template
```markdown
## Mental Model

Think of [domain] as [metaphor/model]:
- [Aspect 1 of metaphor] → [How it applies]
- [Aspect 2 of metaphor] → [How it applies]
- [Aspect 3 of metaphor] → [How it applies]

This model helps guide decisions about [key domain challenges].
```

### Example: API Design Philosophy
```markdown
## Mental Model

Think of APIs as **conversations between systems**:
- **Clear language** → Well-named endpoints and parameters
- **Predictable responses** → Consistent data structures and status codes
- **Good manners** → Proper error messages and documentation
- **Listening** → Accepting input in flexible formats
- **Speaking clearly** → Returning structured, typed responses

This conversational model guides all API design decisions.
```

### Why It Works
- Makes abstract concepts concrete
- Provides intuitive guidance
- Helps generalize to new situations
- Creates memorable framework

---

## Pattern 4: Spectrum of Approaches

Define a spectrum with when to use each approach.

### Template
```markdown
## Choosing Your Approach

[Domain] exists on a spectrum. Choose based on context:

**[Approach A] when**:
- [Condition 1]
- [Condition 2]
- [Condition 3]

**[Approach B] when**:
- [Condition 1]
- [Condition 2]
- [Condition 3]

**[Approach C/Hybrid] when**:
- [Condition 1]
- [Condition 2]
```

### Example: Architecture Decisions
```markdown
## Choosing Your Approach

Architecture exists on a spectrum. Choose based on context:

**Monolith when**:
- Team <10 people
- Single domain/bounded context
- Fast iteration is priority
- Simple deployment preferred

**Microservices when**:
- Multiple autonomous teams
- Services scale independently
- Clear bounded contexts
- Deployment independence needed

**Modular Monolith when**:
- Want modularity without distribution overhead
- Team is growing but not yet multiple teams
- Preparing for potential future split
```

### Why It Works
- Prevents one-size-fits-all thinking
- Provides clear decision criteria
- Acknowledges context matters
- Enables principled choices

---

## Pattern 5: Intentionality Over Intensity

Emphasize that the quality of thinking matters more than the amount of effort.

### Template
```markdown
## [Domain] Philosophy

The key is not [intensity metric] but [intentionality]:
- [Extreme 1] works if executed with clear intent
- [Extreme 2] works if executed with clear intent
- What fails is [lack of intentionality/thoughtfulness]

Choose your approach deliberately based on [context/purpose].
```

### Example: frontend-design
```markdown
## Design Philosophy

**CRITICAL**: Choose a clear conceptual direction and execute it with precision.

Bold maximalism and refined minimalism both work—the key is intentionality, not intensity.

What fails is:
- Accidental complexity (maximalism without purpose)
- Lazy minimalism (simplicity without craft)
- Lack of aesthetic point-of-view
```

### Why It Works
- Validates multiple approaches
- Focuses on quality of thinking
- Prevents confusion about "right" way
- Emphasizes purposeful choice

---

## Pattern 6: Progressive Philosophy

Start with simple principles, then add nuance.

### Template
```markdown
## Core Philosophy

[Simple, memorable principle]

### Nuance

However, [important qualifications]:
- [Nuance 1]
- [Nuance 2]
- [Nuance 3]

The principle guides; the nuance refines.
```

### Example: Data Modeling
```markdown
## Core Philosophy

**Normalize to reduce redundancy.**

### Nuance

However, denormalization is appropriate when:
- Read performance matters more than write consistency
- Joins become too expensive
- Data access patterns strongly favor duplication
- Event sourcing or audit trail is needed

The principle guides initial design; context determines when to deviate.
```

### Why It Works
- Easy to remember core principle
- Acknowledges real-world complexity
- Prevents dogmatic application
- Scales from beginner to advanced

---

## Pattern 7: Degrees of Freedom Philosophy

Match guidance intensity to task fragility.

### Template
```markdown
## Approach Philosophy

This skill uses varying degrees of guidance:

**High freedom tasks** (text-based instructions):
- [Task type 1]
- Multiple valid approaches exist

**Medium freedom tasks** (pseudocode/parameterized):
- [Task type 2]
- Preferred patterns with acceptable variation

**Low freedom tasks** (specific scripts):
- [Task type 3]
- Fragile operations requiring precision

Match the guidance to the task's needs.
```

### Example: Document Generation Skill
```markdown
## Approach Philosophy

This skill balances flexibility and precision:

**High freedom** (creative writing):
- Content tone and style
- Narrative structure
- Examples and metaphors

**Medium freedom** (structured content):
- Section organization
- Heading hierarchy
- Formatting choices

**Low freedom** (technical operations):
- Binary file manipulation
- XML structure generation
- Format validation

The fragility of the task determines the specificity of guidance.
```

### Why It Works
- Explains why some parts are detailed, others aren't
- Sets appropriate expectations
- Prevents both over and under-specification
- Makes guidance level intentional

---

## Pattern 8: Unlock vs. Constrain Philosophy

Explicitly state that the skill unlocks rather than constrains.

### Template
```markdown
## Philosophy: Unlocking Capabilities

This skill aims to **unlock** the agent's capabilities in [domain], not constrain them:

**Unlocking means**:
- Providing frameworks, not templates
- Guiding thinking, not dictating outputs
- Preventing pitfalls while enabling creativity
- Setting high expectations for quality

**Not constraining means**:
- Adapt these guidelines to context
- Use judgment when edge cases arise
- Vary approaches based on requirements
- Push boundaries when appropriate
```

### Example: Creative Writing Skill
```markdown
## Philosophy: Unlocking Creativity

This skill unlocks creative writing capabilities rather than constraining them to formulas:

**Unlocking means**:
- Providing narrative techniques and principles
- Showing what makes writing compelling
- Preventing common mistakes
- Encouraging experimentation

**Not constraining means**:
- Don't follow these as rigid rules
- Adapt to genre and purpose
- Break conventions when it serves the story
- Trust creative instincts informed by craft

Remember: AI agents are capable of extraordinary creative work. These guidelines illuminate paths, they don't fence them.
```

### Why It Works
- Sets empowering tone
- Clarifies role of guidelines
- Encourages creative adaptation
- Prevents mechanical application

---

## How to Choose the Right Pattern

| Pattern | Best For | Example Domain |
|---------|----------|----------------|
| Pre-Action Questions | Domains needing context assessment | Design, Writing, Planning |
| Guiding Principles | Domains with clear values | Code Review, Ethics, Quality |
| Mental Models | Abstract/complex domains | API Design, System Architecture |
| Spectrum of Approaches | Domains with multiple valid paths | Architecture, Testing Strategy |
| Intentionality Over Intensity | Creative/subjective domains | Design, Writing, Art |
| Progressive Philosophy | Domains with simple core, complex edge cases | Data Modeling, Optimization |
| Degrees of Freedom | Mixed rigidity domains | Document Generation, Automation |
| Unlock vs. Constrain | Creative/knowledge work domains | Writing, Design, Problem Solving |

---

## Combining Patterns

The most effective skills often combine multiple patterns:

**Example: Data Analysis Skill**
```markdown
## Data Analysis Philosophy

### Pre-Action Questions (Pattern 1)
Before analyzing data, ask:
- What question am I trying to answer?
- Who needs this analysis?
- What decisions will this inform?

### Guiding Principles (Pattern 2)
1. **Validity over complexity**: Simple correct analysis beats complex flawed analysis
2. **Visual over textual**: Charts communicate insights faster than tables
3. **Assumptions documented**: Always state what you're assuming

### Unlock vs. Constrain (Pattern 8)
These principles guide analysis without constraining methodology. Adapt to data characteristics and stakeholder needs.
```

---

## Philosophy Quality Checklist

A good skill philosophy should:

- [ ] Answer "why" before "how"
- [ ] Be memorable and concise
- [ ] Guide decisions without dictating
- [ ] Acknowledge context matters
- [ ] Prevent common pitfalls
- [ ] Enable creative adaptation
- [ ] Be grounded in domain expertise
- [ ] Empower rather than constrain

---

## Common Philosophy Mistakes

1. **Too vague**: "Do good work" - Not actionable
2. **Too rigid**: "Always use method X" - Doesn't acknowledge context
3. **Too obvious**: "Think carefully" - Doesn't add value
4. **Too complex**: 20 interlocking principles - Cognitive overload
5. **Missing**: Jumping straight to procedures - No mental framework

---

## Summary

**Philosophy = Mental Framework**

Good skill philosophies:
- Establish thinking frameworks before procedures
- Guide decisions without dictating outputs
- Balance principles with context-awareness
- Empower adaptation and creativity
- Make implicit expertise explicit

**The goal**: Give the agent not just what to do, but **how to think** about the domain.
