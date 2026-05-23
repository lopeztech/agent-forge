// Tests for the transient-401 retry inside shared/github/repo.ts's `gh()`.
// The retry isn't directly exposed; we drive it through a public function
// (addLabels) and a monkey-patched globalThis.fetch.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { addLabels, postComment, removeLabel } from "../shared/github/repo.ts";

type FetchCall = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let originalLog: typeof console.log;
let logLines: string[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(responses: Response[]): void {
  let i = 0;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const r = responses[i++];
    if (!r) throw new Error(`scripted fetch exhausted at call ${i}`);
    return r;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  logLines = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
});

const OPTS = { token: "ghs_abc", userAgent: "test" };

describe("gh() transient-401 retry", () => {
  it("retries once on 401 and returns the second response", async () => {
    installFetch([
      jsonResponse(401, { message: "Bad credentials" }),
      jsonResponse(200, []),
    ]);

    await addLabels(OPTS, "owner/repo", 1, ["state:ready"]);

    assert.equal(calls.length, 2, "should make two requests");
    assert.equal(calls[0]!.url, calls[1]!.url);
    assert.equal(calls[0]!.init.method, "POST");

    const retryLog = logLines.find((l) => l.includes("github-api-401-retry"));
    assert.ok(retryLog, "should log the retry");
    assert.match(retryLog!, /POST/);
    assert.match(retryLog!, /\/repos\/owner\/repo\/issues\/1\/labels/);
  });

  it("propagates a second-attempt 401 as a thrown error from ghOrThrow", async () => {
    installFetch([
      jsonResponse(401, { message: "Bad credentials" }),
      jsonResponse(401, { message: "Bad credentials" }),
    ]);

    await assert.rejects(
      addLabels(OPTS, "owner/repo", 1, ["state:ready"]),
      /failed: 401/,
    );
    assert.equal(calls.length, 2, "should retry once before throwing");
  });

  it("does not retry on success (2xx)", async () => {
    installFetch([jsonResponse(201, { id: 99, html_url: "x" })]);

    await postComment(OPTS, "owner/repo", 1, "hi");

    assert.equal(calls.length, 1, "no retry on first-call success");
    assert.equal(logLines.filter((l) => l.includes("github-api-401-retry")).length, 0);
  });

  it("does not retry on 404 (removeLabel treats 404 as no-op)", async () => {
    installFetch([jsonResponse(404, { message: "not found" })]);

    // removeLabel swallows 404 — no throw, no retry.
    await removeLabel(OPTS, "owner/repo", 1, "missing");

    assert.equal(calls.length, 1);
  });

  it("does not retry on 5xx (out of scope for this fix)", async () => {
    installFetch([
      jsonResponse(503, { message: "service unavailable" }),
    ]);

    await assert.rejects(
      addLabels(OPTS, "owner/repo", 1, ["x"]),
      /failed: 503/,
    );
    assert.equal(calls.length, 1, "5xx is not retried by this fix");
  });
});
