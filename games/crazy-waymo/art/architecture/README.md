# San Francisco building direction

[Architecture reference](reference.png): generated art direction, not source geometry.

Keep real SF footprints and district height patterns. Exaggerate features enough to read from a moving kart: deep reveals, chunky cornices, visible garage panels and a few strong roof silhouettes. Cars and collision dimensions stay unchanged.

| Family                | Placement                                                   | Built vocabulary                                                                                                                               |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Victorian / Edwardian | Haight, Alamo Square, Hayes Valley, older residential hills | Deep three-sided bays, cream or dark trim, clapboard siding, projecting sills, sash bars, cornice brackets, facade pediments, doors and stoops |
| Avenue stucco         | Sunset, Richmond, Marina                                    | Shallow picture-window bays, pastel district palettes, narrow-lot garage plus entry, stepped parapets                                          |
| Chinatown mixed use   | Chinatown                                                   | Warm masonry, jade canopies, vermilion sign bands and lanterns, iron fire escapes above shops                                                  |
| North Beach masonry   | North Beach, Russian Hill                                   | Cream/ochre/sage palette, recessed sashes, striped green/red shop awnings, iron fire escapes on historic commercial fronts                     |
| Industrial            | SoMa, Dogpatch, Jackson Square                              | Brick courses, roll-up openings, clerestories, northlight sawtooth roofs where the footprint fits                                              |
| Downtown towers       | Financial District and tall measured parcels                | Shop podiums, inset shafts, vertical mullions/stone ribs, mechanical crowns and stepped caps                                                   |

`parcel-style.ts` resolves district colour and detail choices. `parcel-mesh.ts` builds merged dimensional facades near the camera. Exposed flanks keep shader windows. Source provenance affects measured height and party-wall data, never art quality.

Distant OSM silhouettes use conservative interior cores or small convex-ear cuts. They never extend past the source parcel. Their positions use a uniform 16-bit local frame; exact near shapes and collision solids remain unchanged. Street-detail LOD has hysteresis, and teleports reconcile the destination immediately.

Night window gains keep frames legible. Cornice ribbons sit on separate planes to prevent shimmer. The test harness checks facade regressions, complete-source LOD containment, packed world bounds, teleport residency, and both coastal and central-city GPU budgets.

Current corner pass: rare Victorian roofs reserve the top 0.85–1.2u of the existing building volume for mansards or low octagonal turrets. Eligibility requires a convex footprint, two exposed adjacent frontage edges, and enough interior clearance. Near, phone and distant versions share the roof silhouette. Wall and collision footprints stay unchanged.

Fictional shop names use one 512×128 atlas: Sunset Market, North Beach Deli, Bay Books and district-specific neighbors. Lettering sits on shallow framed fascia above actual shop windows. Narrow fronts keep plain sign bands; distant LOD drops lettering. Night lettering has restrained independent emission. The GPU harness includes the atlas and sign UV bytes.

Survey/OSM duplicates are resolved once against the complete plan before skyline and streaming cells split. Only an entirely enclosed footprint and full vertical volume can disappear from rendering. Towers with upper setbacks cannot occlude other parcels. Collision plans remain authoritative and unchanged. Exact boundary tests and edge subdivision retain partial overlaps and concave notches.

Revision 89 source audit finds 12 turrets and 13 mansards, with no roof vertices above their original height or outside their footprint. The render filter removes 667 fully enclosed duplicates; all 130,800 source collision parcels remain.

Two distinctive Victorian roof captures are preserved in [review/](review/): turret and mansard. [Capture metadata](review/revision89-evidence.json) retains all original camera probes and identifies the archived images. Redundant district captures were replaced by the [revision 90 gameplay views](../studio-review/README.md). The older roof captures precede the final three-era tower palette and the separate [Salesforce hero](../salesforce/README.md).

| Retained building geometry, skyline and shared sign atlas | Desktop    | Phone     |
| --------------------------------------------------------- | ---------- | --------- |
| Financial District                                        | 44.17 MiB  | 22.92 MiB |
| Richmond / central residential fabric                     | 108.95 MiB | 57.06 MiB |
| Budget                                                    | 110 MiB    | 70 MiB    |

These probes were measured after the three-era tower pass, before the final redundant podium-window removal. They include streaming and facade hysteresis, packed attributes and the atlas mip chain. The separate Salesforce hero adds 0.573 MiB, keeping the worst combined probe below 110 MiB. These figures measure building allocation, not total renderer memory or frame rate. Other bespoke public buildings remain outside this pass.
