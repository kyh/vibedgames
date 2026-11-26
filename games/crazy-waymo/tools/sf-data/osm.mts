import { readFileSync } from "node:fs";

import { z } from "zod";

const geomSchema = z.object({ lat: z.number(), lon: z.number() });

const memberSchema = z.object({
  geometry: z.array(geomSchema).optional(),
  ref: z.number().optional(),
  role: z.string(),
  type: z.string(),
});

const elementSchema = z.object({
  geometry: z.array(geomSchema).optional(),
  id: z.number(),
  members: z.array(memberSchema).optional(),
  tags: z.record(z.string(), z.string()).optional(),
  type: z.string(),
});

const overpassSchema = z.object({ elements: z.array(elementSchema) });

/** One `{ lat, lon }` vertex of an Overpass `out geom` way. */
export type OsmGeom = z.infer<typeof geomSchema>;

/** One member of an Overpass relation, with its geometry when the query asked for it. */
export type OsmMember = z.infer<typeof memberSchema>;

/** An element's OSM tags. */
export type OsmTags = Readonly<Record<string, string>>;

/** One element (node, way or relation) of an Overpass JSON answer. */
export type OsmElement = z.infer<typeof elementSchema>;

/** Read and parse an Overpass JSON dump. */
export const readOverpass = (url: URL | string) =>
  overpassSchema.parse(JSON.parse(readFileSync(url, "utf-8")));
