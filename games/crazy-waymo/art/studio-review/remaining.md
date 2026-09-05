# Tree penetration: resolved in revision 89, rechecked in 90

Revision 89 has **zero intersecting trunk envelopes across 18,712 stems**. The installed-artifact audit uses full ground-connected bark bounds, source child transforms, exact parcel-ring intersection, and vertical overlap. Foliage is excluded, so canopy overhang remains intentional.

Parks retain 11,833 of their previous 11,860 stems (99.77%). All 2,288 stems embedded in park tiles have colliders at their visible roots; the former tile-center ghost collider is gone. Rejected decorated tiles retain their lawn. All placement paths share one parcel index, cache their source profiles, and preserve the original candidate random draws.

Run from `games/crazy-waymo`: `pnpm exec vite-node tools/audit-trees.mts`. It prints a revision-tagged JSON report and fails on wall intersections or missing embedded root colliders. The same gates run in `pnpm test`. Retained results: [revision 90 tree audit](tree-audit-90.json), [revision 89 baseline](tree-audit-89.json). Both report zero blocked stems and zero missing embedded colliders.

The baseline [warehouse screenshot](tree-roof-penetration.png) shows the original defect near Hunters Point `(1096.94, 5.17, 810.77)`. Revision 87's narrower origin-point audit found 325 of 11,390 SF template placements inside buildings. The later full-envelope audit of revision 88 found 1,548 blocked stems across 20,320 stems, including SF, KayKit, and embedded park trees. Embedded trees themselves had no wall overlaps; their separate defect was collider placement.
