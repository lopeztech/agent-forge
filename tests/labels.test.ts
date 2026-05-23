import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AREA_ALL_LABEL,
  GAP_LABELS,
  HUMAN_NEEDED_LABEL,
  LABEL_VOCABULARY,
  STATE_LABELS,
  TERMINAL_STATE_LABELS,
  isStateLabel,
  iterLabel,
} from "../shared/labels.ts";

describe("label vocabulary", () => {
  it("contains every workflow state exactly once", () => {
    const vocabularyNames = LABEL_VOCABULARY.map((label) => label.name);

    for (const stateLabel of Object.values(STATE_LABELS)) {
      assert.equal(
        vocabularyNames.filter((name) => name === stateLabel).length,
        1,
        `${stateLabel} should be seeded exactly once`,
      );
    }
  });

  it("does not define duplicate labels", () => {
    const names = LABEL_VOCABULARY.map((label) => label.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("classifies state labels without accepting adjacent labels", () => {
    assert.equal(isStateLabel(STATE_LABELS.ready), true);
    assert.equal(isStateLabel(STATE_LABELS.awaitingCostApproval), true);
    assert.equal(isStateLabel(HUMAN_NEEDED_LABEL), false);
    assert.equal(isStateLabel(GAP_LABELS.specConflict), false);
    assert.equal(isStateLabel(AREA_ALL_LABEL), false);
  });

  it("keeps terminal labels aligned with state constants", () => {
    assert.deepEqual(
      [...TERMINAL_STATE_LABELS].sort(),
      [STATE_LABELS.cancelled, STATE_LABELS.done].sort(),
    );
  });

  it("formats supported iteration labels", () => {
    assert.equal(iterLabel(1), "iter:1");
    assert.equal(iterLabel(2), "iter:2");
    assert.equal(iterLabel(3), "iter:3");
  });
});
