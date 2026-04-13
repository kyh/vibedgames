# Variation Patterns for Skills

Techniques for preventing output convergence and encouraging context-appropriate diversity.

## The Convergence Problem

Without explicit variation encouragement, models may develop "favorite" patterns that repeat across outputs:
- Same fonts, colors, layouts in design
- Same code structures and naming
- Same document organization
- Same writing style regardless of context

This creates generic, predictable "AI aesthetic" outputs that lack context-specificity.

**Solution**: Explicitly encourage variation in your skills.

---

## Pattern 1: Explicit Variation Instruction

Directly tell the agent that outputs should vary.

### Template
```markdown
**IMPORTANT: Vary your outputs**

No two [outputs] should be identical unless requirements are identical:
- Different [contexts] need different [approaches]
- Adapt to the specific [situation/audience/purpose]
- Avoid converging on "favorite" [patterns/choices/styles]
```

### Example: frontend-design
```markdown
**IMPORTANT**: Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.
```

### Why It Works
- Makes variation an explicit requirement
- Warns against convergence
- Encourages context-specificity

---

## Pattern 2: Anti-Convergence Warnings

Explicitly call out specific patterns to avoid repeating.

### Template
```markdown
## Avoid These Overused Patterns

DO NOT default to these commonly repeated choices:
- ❌ [Specific pattern 1]
- ❌ [Specific pattern 2]
- ❌ [Specific pattern 3]

Instead, choose based on context and vary across outputs.
```

### Example: Design Skill
```markdown
## Avoid Generic AI Aesthetics

NEVER use these overused patterns:
- ❌ Inter, Roboto, or Arial fonts
- ❌ Purple gradients on white backgrounds
- ❌ Rounded corners everywhere
- ❌ Centered layouts with symmetry
- ❌ Generic "startup" color schemes

Choose distinctive, context-appropriate alternatives that vary per project.
```

### Example: Writing Skill
```markdown
## Avoid Generic Writing Patterns

NEVER default to these overused structures:
- ❌ "In today's fast-paced world..." openings
- ❌ Three-paragraph essay format for everything
- ❌ Bullet point lists for all content
- ❌ "In conclusion..." closing paragraphs

Vary structure based on purpose and audience.
```

### Why It Works
- Identifies specific convergence risks
- Provides negative examples
- Prevents falling into "easy" patterns
- Creates awareness of common defaults

---

## Pattern 3: Context-Driven Variation

Provide a framework for varying based on contextual factors.

### Template
```markdown
## Adapt to Context

Vary your approach based on:

**When [Context A]**:
- Use [Approach A]
- Characteristics: [traits]

**When [Context B]**:
- Use [Approach B]
- Characteristics: [traits]

**When [Context C]**:
- Use [Approach C]
- Characteristics: [traits]

The same solution doesn't fit every context.
```

### Example: Communication Style
```markdown
## Adapt Tone to Context

Vary your writing style based on audience and purpose:

**Executive audience**:
- Lead with conclusions
- Use data-driven insights
- Concise, action-oriented

**Technical audience**:
- Include implementation details
- Use precise terminology
- Provide code examples

**General audience**:
- Use analogies and metaphors
- Avoid jargon
- Focus on benefits over features

Match style to audience, not a template.
```

### Why It Works
- Provides clear variation dimensions
- Shows how context drives choices
- Prevents one-size-fits-all outputs
- Teaches when to vary

---

## Pattern 4: Inspiration, Not Imitation

Provide examples as inspiration while warning against copying.

### Template
```markdown
## Examples for Inspiration

Here are examples of [good outputs]:

[Example 1]
[Example 2]
[Example 3]

**IMPORTANT**: These are for inspiration, not copying. Create something original that fits YOUR specific context, not a variant of these examples.
```

### Example: Design Examples
```markdown
## Design Inspiration

Examples of distinctive aesthetics:
- **Brutalist**: Raw, monospace fonts, stark contrast, exposed structure
- **Art Deco**: Geometric patterns, gold accents, bold typography
- **Organic**: Flowing shapes, earth tones, natural textures

**IMPORTANT**: Don't copy these styles—let them inspire you to create something unique for your specific context. Each project deserves its own aesthetic identity.
```

### Why It Works
- Shows quality without creating templates
- Encourages original thinking
- Provides reference points without constraints
- Balances guidance and creativity

---

## Pattern 5: Explicit Randomness

Instruct explicit randomization or rotation of choices.

### Template
```markdown
## Variation Strategy

Rotate or randomize these elements across outputs:
- [Element 1]: [Options A, B, C, D...]
- [Element 2]: [Options A, B, C, D...]
- [Element 3]: [Options A, B, C, D...]

Don't reuse the same combination twice without strong reason.
```

### Example: Document Styling
```markdown
## Visual Variation

Rotate these elements to create visual diversity:
- **Color scheme**: Warm, cool, monochrome, high-contrast, pastel
- **Layout**: Single column, two column, asymmetric, grid-based, flowing
- **Typography**: Serif + sans, two sans, two serif, monospace hybrid
- **Spacing**: Compact, generous, mixed density

Each document should have a distinct visual identity.
```

### Why It Works
- Provides concrete variation dimensions
- Encourages systematic diversity
- Prevents default choices
- Makes variation measurable

---

## Pattern 6: Quality Over Quantity Variation

Emphasize that variation means context-fit, not arbitrary difference.

### Template
```markdown
## Variation = Context-Appropriate, Not Random

Vary outputs based on context, not for variation's sake:
- **Good variation**: Adapting to audience, purpose, constraints
- **Bad variation**: Arbitrary changes without justification

Every choice should have a reason rooted in context.
```

### Example: Code Architecture
```markdown
## Architectural Variation

Vary architecture based on project needs, not trends:

**Good reasons to vary**:
- Different scaling requirements
- Different team structures
- Different deployment constraints
- Different domain characteristics

**Bad reasons to vary**:
- "We haven't tried X yet"
- "Framework Y is popular"
- "To be different from last project"

Context drives architecture, not variety for its own sake.
```

### Why It Works
- Prevents arbitrary variation
- Emphasizes purposeful choices
- Maintains quality standards
- Teaches good judgment

---

## Pattern 7: Expansion, Not Repetition

For lists and collections, encourage expansion rather than repetition.

### Template
```markdown
## Expanding Your Repertoire

When choosing [options], expand beyond comfortable defaults:

**Beginner level**: [Common safe choices]
**Intermediate level**: [Less common but still familiar]
**Advanced level**: [Distinctive and bold choices]

Push yourself toward advanced choices when context allows.
```

### Example: Typography
```markdown
## Expanding Typography Choices

**Overused fonts** (avoid): Inter, Roboto, Arial, Helvetica
**Familiar alternatives**: Work Sans, DM Sans, Source Sans
**Distinctive choices**: Clash Display, Cabinet Grotesk, Sohne, Zodiak
**Bold choices**: Druk, Playfair Display, Fraunces, Sporting Grotesque

Push toward distinctive and bold when the brand allows creativity.
```

### Why It Works
- Provides progression path
- Encourages skill development
- Expands beyond safe defaults
- Maintains quality while varying

---

## Pattern 8: Multi-Dimensional Variation

Vary across multiple independent dimensions.

### Template
```markdown
## Variation Dimensions

Vary these independently to create diverse outputs:

1. **[Dimension 1]**
   - Options: [A, B, C, D]

2. **[Dimension 2]**
   - Options: [W, X, Y, Z]

3. **[Dimension 3]**
   - Options: [J, K, L, M]

Combinations create exponential diversity: 4 × 4 × 4 = 64 possibilities
```

### Example: Presentation Design
```markdown
## Variation Dimensions

Vary these independently:

1. **Layout Style**
   - Full bleed, Contained, Asymmetric, Grid

2. **Visual Approach**
   - Photo-driven, Illustration, Data viz, Typography-only

3. **Color Strategy**
   - Monochrome, Duotone, Vibrant, Muted, High-contrast

4. **Typography**
   - Modern sans, Classic serif, Display bold, Editorial

These combine for 256 distinct presentation styles.
```

### Why It Works
- Creates structured diversity
- Shows combinatorial possibilities
- Prevents convergence on single style
- Makes variation systematic

---

## Pattern 9: Learnings From Previous Outputs

Explicitly avoid repeating recent patterns.

### Template
```markdown
## Avoid Recent Patterns

For this [output], explicitly avoid patterns used in recent [outputs]:
- Check what [choices] were made recently
- Deliberately choose different [alternatives]
- Maintain variety across a session

Recent ≠ good; fresh choices often work better.
```

### Example: Design Session
```markdown
## Session Variation

For this design, avoid repeating recent choices:
- If last design used warm colors → try cool or monochrome
- If last design was minimal → try maximalist or organic
- If last design used sans serif → try serif or mixed

Conscious differentiation prevents convergence across outputs.
```

### Why It Works
- Actively prevents convergence
- Creates session-level diversity
- Encourages novelty
- Makes variation explicit

---

## Pattern 10: Constraint-Based Variation

Use constraints to force variation.

### Template
```markdown
## Variation Constraints

For each [output], apply a random constraint:
- [Constraint 1]: Forces [variation in dimension X]
- [Constraint 2]: Forces [variation in dimension Y]
- [Constraint 3]: Forces [variation in dimension Z]

Constraints breed creativity and prevent defaults.
```

### Example: Writing Exercises
```markdown
## Writing Variation Constraints

Apply one constraint per piece:
- **No "to be" verbs**: Forces active voice
- **One sentence paragraphs**: Forces conciseness
- **No adjectives**: Forces stronger nouns
- **Start mid-action**: Forces engaging openings
- **Reverse chronological**: Forces unconventional structure

Constraints prevent falling into default writing patterns.
```

### Why It Works
- Forces creative solutions
- Breaks habitual patterns
- Creates systematic diversity
- Makes variation fun

---

## Measuring Variation Effectiveness

Your skill encourages effective variation if outputs:

- [ ] Differ visibly across instances
- [ ] Are context-appropriate (not arbitrary)
- [ ] Avoid clustering around "favorites"
- [ ] Feel unique to their purpose
- [ ] Show deliberate choices, not defaults
- [ ] Span the full range of possibilities
- [ ] Adapt to specific requirements

---

## Common Variation Mistakes

1. **No variation instruction**: Assuming variation happens automatically
2. **Vague variation**: "Be creative" without specifics
3. **Arbitrary variation**: Different without reason
4. **Single-dimension variation**: Only varying one aspect
5. **Template variation**: Just swapping placeholders
6. **Convergence unawareness**: Not identifying overused patterns

---

## How to Add Variation to Existing Skills

1. **Identify convergence points**: Where do outputs tend to repeat?
2. **Add explicit variation instruction**: Pattern 1
3. **Call out overused patterns**: Pattern 2
4. **Provide variation dimensions**: Pattern 3 or 4
5. **Show examples as inspiration**: Pattern 4
6. **Test outputs for diversity**: Do they actually vary?

---

## Summary

**Variation prevents "AI slop" and creates context-appropriate outputs.**

Key principles:
- Make variation explicit (don't assume it happens)
- Identify and warn against convergence patterns
- Provide variation dimensions and frameworks
- Emphasize context-appropriateness over arbitrary difference
- Show examples as inspiration, not templates to copy
- Encourage expanding beyond safe defaults

**The goal**: Every output should feel uniquely designed for its context, not generated from a template.
