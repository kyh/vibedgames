#!/usr/bin/env python3
"""
Analyze a skill's effectiveness and provide quality scoring.

Usage:
    python analyze_skill.py <path/to/skill>
"""

import sys
import os
import re
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

    return frontmatter, body


def check_philosophy(body):
    """Check if the skill establishes a clear philosophical foundation."""
    score = 0
    feedback = []

    # Check for philosophy-related keywords
    philosophy_keywords = [
        'philosophy', 'approach', 'principle', 'mental model', 'framework',
        'thinking', 'mindset', 'why', 'consider', 'understand'
    ]

    body_lower = body.lower()
    found_keywords = [kw for kw in philosophy_keywords if kw in body_lower]

    if len(found_keywords) >= 3:
        score += 30
        feedback.append(f"✅ Philosophy indicators found: {', '.join(found_keywords[:5])}")
    elif len(found_keywords) >= 1:
        score += 15
        feedback.append(f"⚠️  Some philosophy indicators found: {', '.join(found_keywords)}")
    else:
        feedback.append("❌ No clear philosophical foundation detected")

    # Check for questions that establish thinking
    questions = re.findall(r'\?[^\n]*', body)
    if len(questions) >= 3:
        score += 10
        feedback.append(f"✅ Contains {len(questions)} guiding questions")
    elif len(questions) >= 1:
        score += 5
        feedback.append(f"⚠️  Contains {len(questions)} guiding question(s)")

    return score, feedback


def check_anti_patterns(body):
    """Check if the skill explicitly warns about anti-patterns."""
    score = 0
    feedback = []

    # Check for anti-pattern indicators
    anti_pattern_keywords = [
        'avoid', 'never', 'don\'t', 'do not', 'anti-pattern', 'mistake',
        'common pitfall', 'warning', 'incorrect', 'wrong way'
    ]

    body_lower = body.lower()
    found_keywords = [kw for kw in anti_pattern_keywords if kw in body_lower]

    if len(found_keywords) >= 5:
        score += 25
        feedback.append(f"✅ Strong anti-pattern guidance: {', '.join(found_keywords[:5])}")
    elif len(found_keywords) >= 2:
        score += 12
        feedback.append(f"⚠️  Some anti-pattern guidance: {', '.join(found_keywords)}")
    else:
        feedback.append("❌ No explicit anti-pattern warnings")

    # Check for "NEVER" or "DO NOT" in caps (strong warnings)
    strong_warnings = re.findall(r'\b(NEVER|DO NOT|DON\'T)\b', body)
    if strong_warnings:
        score += 10
        feedback.append(f"✅ Contains {len(strong_warnings)} strong warning(s)")

    return score, feedback


def check_variation(body):
    """Check if the skill encourages output variation."""
    score = 0
    feedback = []

    # Check for variation-related keywords
    variation_keywords = [
        'vary', 'variation', 'different', 'diverse', 'context-specific',
        'adapt', 'customize', 'unique', 'avoid repetition', 'not the same'
    ]

    body_lower = body.lower()
    found_keywords = [kw for kw in variation_keywords if kw in body_lower]

    if len(found_keywords) >= 3:
        score += 20
        feedback.append(f"✅ Variation encouraged: {', '.join(found_keywords[:5])}")
    elif len(found_keywords) >= 1:
        score += 10
        feedback.append(f"⚠️  Some variation mentioned: {', '.join(found_keywords)}")
    else:
        feedback.append("❌ No explicit variation encouragement")

    # Check for warnings against templates or repetition
    template_warnings = re.findall(r'(template|repetitive|generic|cookie-cutter|converge)', body_lower)
    if template_warnings:
        score += 10
        feedback.append(f"✅ Warns against generic patterns ({len(template_warnings)} mentions)")

    return score, feedback


def check_organization(body):
    """Check if the skill is well-organized."""
    score = 0
    feedback = []

    # Check for section headers
    headers = re.findall(r'^#+\s+(.+)$', body, re.MULTILINE)

    if len(headers) >= 5:
        score += 10
        feedback.append(f"✅ Well-structured with {len(headers)} sections")
    elif len(headers) >= 2:
        score += 5
        feedback.append(f"⚠️  Has {len(headers)} sections")
    else:
        feedback.append("❌ Lacks clear organization")

    # Check for lists (actionable items)
    lists = re.findall(r'^\s*[-*]\s+', body, re.MULTILINE)
    if len(lists) >= 10:
        score += 5
        feedback.append(f"✅ Contains {len(lists)} list items (actionable)")

    return score, feedback


def check_empowerment(body):
    """Check if the skill empowers rather than constrains."""
    score = 0
    feedback = []

    # Check for empowering language
    empowering_keywords = [
        'extraordinary', 'capable', 'unlock', 'enable', 'empower',
        'creative', 'innovative', 'push boundaries', 'explore'
    ]

    body_lower = body.lower()
    found_keywords = [kw for kw in empowering_keywords if kw in body_lower]

    if len(found_keywords) >= 3:
        score += 10
        feedback.append(f"✅ Empowering tone: {', '.join(found_keywords)}")
    elif len(found_keywords) >= 1:
        score += 5
        feedback.append(f"⚠️  Some empowering language: {', '.join(found_keywords)}")

    # Check for rigid constraints (might indicate over-constraining)
    constraint_keywords = ['must', 'always', 'required', 'mandatory']
    found_constraints = [kw for kw in constraint_keywords if kw in body_lower]

    if len(found_constraints) > 20:
        score -= 5
        feedback.append(f"⚠️  Many rigid constraints ({len(found_constraints)} instances)")

    return score, feedback


def analyze_skill(skill_path):
    """Main analysis function."""
    print(f"\n🔍 Analyzing skill at: {skill_path}\n")

    frontmatter, body = load_skill(skill_path)

    total_score = 0
    all_feedback = []

    # Check description quality
    description = frontmatter.get('description', '')
    if len(description) > 50:
        desc_score = 5
        all_feedback.append(("Description", 5, ["✅ Comprehensive description"]))
    else:
        desc_score = 0
        all_feedback.append(("Description", 0, ["❌ Description too brief"]))
    total_score += desc_score

    # Run all checks
    phil_score, phil_feedback = check_philosophy(body)
    total_score += phil_score
    all_feedback.append(("Philosophy", phil_score, phil_feedback))

    anti_score, anti_feedback = check_anti_patterns(body)
    total_score += anti_score
    all_feedback.append(("Anti-Patterns", anti_score, anti_feedback))

    var_score, var_feedback = check_variation(body)
    total_score += var_score
    all_feedback.append(("Variation", var_score, var_feedback))

    org_score, org_feedback = check_organization(body)
    total_score += org_score
    all_feedback.append(("Organization", org_score, org_feedback))

    emp_score, emp_feedback = check_empowerment(body)
    total_score += emp_score
    all_feedback.append(("Empowerment", emp_score, emp_feedback))

    # Display results
    print("=" * 60)
    print(f"SKILL QUALITY ANALYSIS: {frontmatter.get('name', 'unknown')}")
    print("=" * 60)
    print(f"\n📊 OVERALL SCORE: {total_score}/100\n")

    for category, score, feedback in all_feedback:
        print(f"\n{category}: {score} points")
        for item in feedback:
            print(f"  {item}")

    print("\n" + "=" * 60)
    print("RECOMMENDATIONS")
    print("=" * 60)

    if total_score >= 80:
        print("\n🌟 Excellent! This skill follows best practices.")
    elif total_score >= 60:
        print("\n✅ Good skill. Consider the suggestions above to improve.")
    elif total_score >= 40:
        print("\n⚠️  Needs improvement. Focus on:")
        if phil_score < 20:
            print("   - Add philosophical foundation")
        if anti_score < 15:
            print("   - Include anti-pattern warnings")
        if var_score < 10:
            print("   - Encourage variation in outputs")
    else:
        print("\n❌ Significant improvements needed:")
        print("   - Establish a clear philosophical framework")
        print("   - Add explicit anti-patterns section")
        print("   - Encourage context-specific variation")
        print("   - Improve organization and structure")

    print("\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python analyze_skill.py <path/to/skill>")
        sys.exit(1)

    skill_path = sys.argv[1]

    if not os.path.exists(skill_path):
        print(f"❌ Skill directory not found: {skill_path}")
        sys.exit(1)

    analyze_skill(skill_path)
