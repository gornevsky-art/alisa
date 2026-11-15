import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/index.js";

const envNames = ["GEMINI_API_KEY", "GEMINI_API", "SERPER_API_KEY", "SERPER_API", "GEMINI_MODEL"];
const cases = [
  {
    name: "short environment names enable Gemini and Serper",
    env: { GEMINI_API: "test-gemini-short", SERPER_API: "test-serper-short" },
    gemini: "test-gemini-short",
    serper: "test-serper-short"
  },
  {
    name: "original environment names still work",
    env: { GEMINI_API_KEY: "test-gemini-original", SERPER_API_KEY: "test-serper-original" },
    gemini: "test-gemini-original",
    serper: "test-serper-original"
  },
  {
    name: "original names take precedence when both variants exist",
    env: {
      GEMINI_API_KEY: "test-gemini-original", GEMINI_API: "test-gemini-short",
      SERPER_API_KEY: "test-serper-original", SERPER_API: "test-serper-short"
    },
    gemini: "test-gemini-original",
    serper: "test-serper-original"
  },
  {
    name: "empty original values fall back to the short names",
    env: { GEMINI_API_KEY: "", GEMINI_API: "test-gemini-short", SERPER_API_KEY: "", SERPER_API: "test-serper-short" },
    gemini: "test-gemini-short",
    serper: "test-serper-short"
  }
];

test("configured API keys reach both upstream services", async t => {
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
      t.after(() => {
        for (const name of envNames) {
          if (previous[name] === undefined) delete process.env[name];
          else process.env[name] = previous[name];
        }
      });
      for (const name of envNames) delete process.env[name];
      Object.assign(process.env, scenario.env);

      const calls = [];
      t.mock.method(globalThis, "fetch", async (url, options) => {
        calls.push({ url, options });
        if (url === "https://google.serper.dev/search") {
          return { ok: true, json: async () => ({ organic: [{ title: "Погода", snippet: "Сегодня солнечно." }] }) };
        }
        assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Сегодня солнечно." }] } }] }) };
      });

      let statusCode;
      let payload;
      const res = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return value; }
      };
      await handler({ method: "POST", body: { request: { command: "Какая погода сегодня?" } } }, res);

      assert.equal(statusCode, 200);
      assert.equal(payload.response.text, "Сегодня солнечно.");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://google.serper.dev/search");
      assert.equal(calls[0].options.headers["X-API-KEY"], scenario.serper);
      assert.equal(calls[1].options.headers["x-goog-api-key"], scenario.gemini);
      assert.match(JSON.parse(calls[1].options.body).contents.at(-1).parts[0].text, /Результаты поиска в интернете/);
    });
  }
});
