import assert from "node:assert/strict";
import test from "node:test";

import { fetchOfficial } from "../src/arca-client.mjs";

test("rejects a non-official initial host before sending a request", async () => {
  let called = false;
  await assert.rejects(
    fetchOfficial(async () => { called = true; }, "https://example.com/login"),
    /non-official host/,
  );
  assert.equal(called, false);
});

test("rejects a redirect from an official host to a non-official host", async () => {
  let calls = 0;
  await assert.rejects(
    fetchOfficial(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "https://example.com/capture" } });
    }, "https://auth.afip.gob.ar/contribuyente_/login.xhtml"),
    /non-official host/,
  );
  assert.equal(calls, 1);
});

test("rejects a redirect that downgrades an official host to HTTP", async () => {
  await assert.rejects(
    fetchOfficial(async () => new Response(null, {
      status: 302,
      headers: { location: "http://auth.afip.gob.ar/insecure" },
    }), "https://auth.afip.gob.ar/start"),
    /non-HTTPS transport/,
  );
});

test("follows official redirects and converts POST to GET after 302", async () => {
  const calls = [];
  const response = await fetchOfficial(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: "/next" } });
    }
    return new Response("ok", { status: 200 });
  }, "https://auth.afip.gob.ar/start", { method: "POST", body: "field=value" });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { url: "https://auth.afip.gob.ar/start", method: "POST", body: "field=value" },
    { url: "https://auth.afip.gob.ar/next", method: "GET", body: undefined },
  ]);
});
