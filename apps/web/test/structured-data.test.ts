import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SiteGraphNode } from "@/lib/structured-data";
import { serializeJsonLd, siteGraph } from "@/lib/structured-data";
import { siteConfig } from "@/lib/site-config";

const graph = siteGraph();
const nodes = graph["@graph"];

const findNode = <TType extends SiteGraphNode["@type"]>(type: TType) =>
  nodes.find((node): node is Extract<SiteGraphNode, { "@type": TType }> => node["@type"] === type);

describe("siteGraph", () => {
  test("is a schema.org graph", () => {
    assert.equal(graph["@context"], "https://schema.org");
    assert.ok(nodes.length >= 3);
  });

  test("Organization has name, description, url and a contactPoint", () => {
    const organization = findNode("Organization");
    assert.ok(organization);
    assert.equal(organization.name, siteConfig.name);
    assert.equal(organization.url, siteConfig.url);
    assert.ok(organization.description.length > 0);

    const [contactPoint] = organization.contactPoint;
    assert.ok(contactPoint, "Organization has no contactPoint");
    assert.ok(contactPoint.contactType.length > 0);
    // Something has to be reachable: the support URL when no monitored mailbox
    // is configured, the mailbox itself once one is.
    assert.ok(contactPoint.url || contactPoint.email || contactPoint.telephone);
  });

  test("Organization lists only verifiable sameAs profiles", () => {
    const organization = findNode("Organization");
    assert.ok(organization);
    assert.ok(organization.sameAs.length > 0);
    for (const profile of organization.sameAs) assert.match(profile, /^https:\/\//);
  });

  test("optional contact fields appear only when configured", () => {
    const organization = findNode("Organization");
    assert.ok(organization);
    assert.equal(organization.email !== undefined, siteConfig.contact.email !== null);
    assert.equal(organization.telephone !== undefined, siteConfig.contact.telephone !== null);
    assert.equal(organization.address !== undefined, siteConfig.contact.address !== null);
    if (organization.address) assert.equal(organization.address["@type"], "PostalAddress");
  });

  test("WebSite has name, description, url and points back at the Organization", () => {
    const organization = findNode("Organization");
    const website = findNode("WebSite");
    assert.ok(organization && website);
    assert.equal(website.name, siteConfig.name);
    assert.equal(website.url, siteConfig.url);
    assert.ok(website.description.length > 0);
    assert.deepEqual(website.publisher, { "@id": organization["@id"] });
  });

  test("SoftwareApplication states its offer, help page and install URL", () => {
    const organization = findNode("Organization");
    const app = findNode("SoftwareApplication");
    assert.ok(organization && app);
    assert.ok(app.description.length > 0);
    assert.equal(app.url, siteConfig.url);
    assert.equal(app.offers.price, "0");
    assert.equal(app.installUrl, `${siteConfig.url}/install`);
    assert.equal(app.softwareHelp.url, `${siteConfig.url}/docs`);
    assert.ok(app.featureList.length > 0);
    assert.deepEqual(app.author, { "@id": organization["@id"] });
  });

  test("featured games are VideoGame entities on their own subdomains", () => {
    const games = nodes.filter((node) => node["@type"] === "VideoGame");
    assert.ok(games.length > 0);
    for (const game of games) {
      assert.match(game.url, /^https:\/\/[a-z0-9-]+\.vibedgames\.com$/);
      assert.ok(game.name.length > 0);
    }
  });
});

describe("serializeJsonLd", () => {
  test("produces parseable JSON", () => {
    assert.deepEqual(JSON.parse(serializeJsonLd({ a: 1 })), { a: 1 });
  });

  test("escapes `<` so a string can never close the script tag", () => {
    const payload = "</script><script>alert(1)</script>";
    const serialized = serializeJsonLd({ x: payload });
    assert.doesNotMatch(serialized, /<\/script>/);
    assert.equal(JSON.parse(serialized).x, payload);
  });

  test("the real graph is embeddable without breaking out of the tag", () => {
    assert.doesNotMatch(serializeJsonLd(graph), /</);
  });
});
