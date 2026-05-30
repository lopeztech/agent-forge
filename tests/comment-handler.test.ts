import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPROVERS,
  hasLabel,
  parseCommand,
} from "../infra/glue/comment-handler/src/logic.ts";

describe("parseCommand", () => {
  it("recognises /approve-cost on first line", () => {
    assert.equal(parseCommand("/approve-cost"), "approve-cost");
  });

  it("recognises /cancel on first line", () => {
    assert.equal(parseCommand("/cancel"), "cancel");
  });

  it("ignores trailing lines after a valid command", () => {
    assert.equal(parseCommand("/approve-cost\nsome note here"), "approve-cost");
  });

  it("ignores leading blank lines and picks first non-empty line", () => {
    assert.equal(parseCommand("\n\n/approve-cost"), "approve-cost");
  });

  it("trims whitespace from each line before matching", () => {
    assert.equal(parseCommand("  /approve-cost  "), "approve-cost");
    assert.equal(parseCommand("  /cancel  "), "cancel");
  });

  it("is case-sensitive — mixed-case command is not recognised", () => {
    assert.equal(parseCommand("/Approve-Cost"), undefined);
    assert.equal(parseCommand("/CANCEL"), undefined);
  });

  it("returns undefined for an unknown command", () => {
    assert.equal(parseCommand("/foo"), undefined);
    assert.equal(parseCommand("approve-cost"), undefined); // missing slash
  });

  it("returns undefined for an empty body", () => {
    assert.equal(parseCommand(""), undefined);
    assert.equal(parseCommand("   \n  \n  "), undefined);
  });

  it("returns undefined for a plain comment with no command", () => {
    assert.equal(parseCommand("looks good to me!"), undefined);
  });
});

describe("hasLabel", () => {
  const labels = [
    { name: "state:awaiting-cost-approval" },
    { name: "area:glue" },
  ];

  it("returns true when the label is present", () => {
    assert.equal(hasLabel(labels, "state:awaiting-cost-approval"), true);
    assert.equal(hasLabel(labels, "area:glue"), true);
  });

  it("returns false when the label is absent", () => {
    assert.equal(hasLabel(labels, "state:ready"), false);
    assert.equal(hasLabel(labels, "human-needed"), false);
  });

  it("returns false on an empty array", () => {
    assert.equal(hasLabel([], "state:awaiting-cost-approval"), false);
  });
});

describe("APPROVERS", () => {
  it("allows OWNER and MEMBER", () => {
    assert.equal(APPROVERS.has("OWNER"), true);
    assert.equal(APPROVERS.has("MEMBER"), true);
  });

  it("rejects COLLABORATOR, CONTRIBUTOR, and NONE", () => {
    assert.equal(APPROVERS.has("COLLABORATOR"), false);
    assert.equal(APPROVERS.has("CONTRIBUTOR"), false);
    assert.equal(APPROVERS.has("NONE"), false);
  });
});
