# GLOSSARY.md Format

`GLOSSARY.md` is the canonical language for this teaching workspace. All lessons, practice tasks, and learning records should adhere to its terminology. Building it is itself part of learning: compressing a concept into a tight definition is evidence the user understands it.

## Structure

```md
# Game Development Glossary

{One or two sentence description of what this glossary covers.}

## Terms

**Game feel**:
The tactile, kinesthetic sense of manipulating a virtual object — the product of input response, simulated physics, and polish effects.
_Avoid_: Juice (that's the polish layer specifically), "it feels good"

**Coyote time**:
A forgiveness window of a few frames after walking off a ledge during which a jump input still fires.
_Avoid_: Ledge grace, jump buffer (that's the input-side twin)

**Hitbox**:
The invisible shape used for collision decisions, deliberately decoupled from the sprite's visual bounds.
_Avoid_: Collider-as-drawn, "the sprite"
```

## Rules

- **Add a term only when the user understands it.** The glossary is a record of compressed knowledge, not a dictionary the user reads to learn. If the user has just been introduced to a concept, wait until they can use it correctly before promoting it here.
- **Be opinionated.** When several words exist for the same concept, pick the best one and list the rest as aliases to avoid. This is how language compresses.
- **Keep definitions tight.** One or two sentences. Define what the term IS, not what it does or how to do it.
- **Use the glossary's own terms inside definitions.** Once a term is in the glossary, prefer it everywhere — including inside other definitions. This is what makes complex terms easier to grasp later.
- **Group under subheadings** when natural clusters emerge (e.g. `## Feel & Polish`, `## Engine`, `## Multiplayer`). A flat list is fine when terms cohere.
- **Flag ambiguities explicitly.** If a term is used loosely in the wider field, note the resolution: "In this workspace, 'frame' always means a render frame — fixed-step logic ticks are called ticks."
- **Revise as understanding deepens.** A definition the user wrote in week one may be wrong by week six. Update in place; do not leave stale entries.
