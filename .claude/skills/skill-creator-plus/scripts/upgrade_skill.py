#!/usr/bin/env python3
"""
Generate suggestions for improving an existing skill.

Usage:
    python upgrade_skill.py <path/to/skill>
"""

import sys
import os
from pathlib import Path
import yaml


def load_skill(skill_path):
    """Load and parse a SKILL.md file."""
    skill_md_path = Path(skill_path) / "SKILL.md"

    if not skill_md_path.exists():
        print(f"❌ SKILL.md not found at {skill_md_path}")
        sys.exit(1)

    with open(skill_md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split frontmatter and body
    parts = content.split('---', 2)
    if len(parts) < 3:
        print(f"❌ Invalid SKILL.md format - missing frontmatter")
        sys.exit(1)

    frontmatter = yaml.safe_load(parts[1])
    body = parts[2].strip()

    return frontmatter, body, content


def generate_suggestions(frontmatter, body):
    """Generate specific suggestions for improvement."""
    suggestions = []

    # Check for philosophy section
    if 'philosophy' not in body.lower() and 'principle' not in body.lower():
        suggestions.append({
            'category': 'Philosophy',
            'priority': 'HIGH',
            'suggestion': 'Add a philosophy or principles section',
            'example': '''## Core Philosophy

Before diving into procedures, understand the fundamental approach:
- What is the underlying philosophy guiding this domain?
- What questions should be asked before taking action?
- What mental model helps make better decisions?'''
        })

    # Check for anti-patterns section
    if 'anti-pattern' not in body.lower() and 'avoid' not in body.lower()[:500]:
        suggestions.append({
            'category': 'Anti-Patterns',
            'priority': 'HIGH',
            'suggestion': 'Add anti-patterns or "what to avoid" section',
            'example': '''## Anti-Patterns to Avoid

Common mistakes when [doing this task]:
- ❌ **Template trap**: Using rigid templates that constrain creativity
- ❌ **Context blindness**: Applying same approach regardless of situation
- ❌ **Over-specification**: Adding unnecessary constraints'''
        })

    # Check for variation encouragement
    if 'vary' not in body.lower() and 'different' not in body.lower():
        suggestions.append({
            'category': 'Variation',
            'priority': 'MEDIUM',
            'suggestion': 'Add explicit variation encouragement',
            'example': '''## Encouraging Variation

**IMPORTANT**: Outputs should vary based on context. Avoid converging on "favorite" patterns:
- Adapt to the specific use case
- Consider different approaches for different scenarios
- No two outputs should be identical unless requirements are identical'''
        })

    # Check for empowering language
    if 'extraordinary' not in body.lower() and 'capable' not in body.lower():
        suggestions.append({
            'category': 'Empowerment',
            'priority': 'LOW',
            'suggestion': 'Add empowering conclusion',
            'example': '''## Remember

Claude is capable of extraordinary work in this domain. These guidelines unlock that potential—they don't constrain it. Use judgment, adapt to context, and push boundaries when appropriate.'''
        })

    # Check description
    description = frontmatter.get('description', '')
    if len(description) < 100:
        suggestions.append({
            'category': 'Description',
            'priority': 'HIGH',
            'suggestion': 'Expand the description field in frontmatter',
            'example': f'''Current: {description}

Suggested: Add more detail about when to use this skill, what triggers it, and what tasks it helps with. Aim for 100-200 characters with specific use cases.'''
        })

    # Check for section organization
    section_count = body.count('\n##')
    if section_count < 3:
        suggestions.append({
            'category': 'Organization',
            'priority': 'MEDIUM',
            'suggestion': 'Add more section headers for better organization',
            'example': '''Organize the skill into clear sections:
## Philosophy/Principles
## Core Guidelines
## Anti-Patterns
## Examples (optional)
## Advanced Topics (optional)'''
        })

    return suggestions


def display_upgrade_suggestions(skill_path):
    """Display upgrade suggestions for a skill."""
    print(f"\n🔧 Analyzing upgrade opportunities for: {skill_path}\n")

    frontmatter, body, content = load_skill(skill_path)
    suggestions = generate_suggestions(frontmatter, body)

    print("=" * 70)
    print(f"UPGRADE SUGGESTIONS: {frontmatter.get('name', 'unknown')}")
    print("=" * 70)

    if not suggestions:
        print("\n✅ No major improvements needed! This skill follows best practices.\n")
        return

    # Group by priority
    high_priority = [s for s in suggestions if s['priority'] == 'HIGH']
    medium_priority = [s for s in suggestions if s['priority'] == 'MEDIUM']
    low_priority = [s for s in suggestions if s['priority'] == 'LOW']

    if high_priority:
        print("\n🔴 HIGH PRIORITY IMPROVEMENTS")
        print("-" * 70)
        for i, suggestion in enumerate(high_priority, 1):
            print(f"\n{i}. {suggestion['category']}: {suggestion['suggestion']}")
            print(f"\nExample:\n{suggestion['example']}\n")

    if medium_priority:
        print("\n🟡 MEDIUM PRIORITY IMPROVEMENTS")
        print("-" * 70)
        for i, suggestion in enumerate(medium_priority, 1):
            print(f"\n{i}. {suggestion['category']}: {suggestion['suggestion']}")
            print(f"\nExample:\n{suggestion['example']}\n")

    if low_priority:
        print("\n🟢 LOW PRIORITY IMPROVEMENTS")
        print("-" * 70)
        for i, suggestion in enumerate(low_priority, 1):
            print(f"\n{i}. {suggestion['category']}: {suggestion['suggestion']}")
            print(f"\nExample:\n{suggestion['example']}\n")

    print("=" * 70)
    print("NEXT STEPS")
    print("=" * 70)
    print("""
1. Review the suggestions above
2. Edit your SKILL.md to incorporate relevant improvements
3. Run analyze_skill.py to see how the score improves
4. Test the skill with real use cases
5. Iterate based on performance
    """)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python upgrade_skill.py <path/to/skill>")
        sys.exit(1)

    skill_path = sys.argv[1]

    if not os.path.exists(skill_path):
        print(f"❌ Skill directory not found: {skill_path}")
        sys.exit(1)

    display_upgrade_suggestions(skill_path)
