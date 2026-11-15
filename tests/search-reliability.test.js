import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/index.js";

function configureKeys(t, serper = "test-serper") {
  const names = ["GEMINI_API_KEY", "GEMINI_API", "SERPER_API_KEY", "SERPER_API", "GEMINI_MODEL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  for (const name of names) delete process.env[name];
  process.env.GEMINI_API = "test-gemini";
  if (serper) process.env.SERPER_API = serper;
}

async function ask(command = "Найди последние новости о космосе") {
  let payload;
  const res = {
    status(code) { assert.equal(code, 200); return this; },
    json(value) { payload = value; return value; }
  };
  await handler({ method: "POST", body: { request: { command } } }, res);
  return payload;
}

const sources = { organic: [{ title: "Космическая новость", snippet: "Зонд передал новые снимки.", link: "https://example.com/space" }] };

test("a search taking longer than 600 ms still reaches Gemini", async t => {
  configureKeys(t);
  let geminiPrompt;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://google.serper.dev/search") {
      await new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Request aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          options.signal.removeEventListener("abort", abort);
          resolve();
        }, 800);
        options.signal.addEventListener("abort", abort, { once: true });
      });
      return { ok: true, json: async () => sources };
    }
    geminiPrompt = JSON.parse(options.body).contents.at(-1).parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Зонд передал новые снимки." }] } }] }) };
  });
  const result = await ask();
  assert.match(geminiPrompt || "", /Результаты поиска в интернете/);
  assert.match(geminiPrompt, /Зонд передал новые снимки/);
  assert.equal(result.response.text, "Зонд передал новые снимки.");
});

test("failed search is reported without asking Gemini to invent fresh information", async t => {
  const cases = [
    { name: "missing key", key: "", expected: /Поиск.*не подключён/, calls: 0 },
    { name: "rejected key", status: 403, expected: /ключ.*Serper/, calls: 1 },
    { name: "quota exhausted", status: 429, expected: /лимит.*поиск/, calls: 1 },
    { name: "HTTP failure", status: 500, expected: /не удалось выполнить поиск/, calls: 1 },
    { name: "network failure", error: new TypeError("fetch failed"), expected: /не удалось выполнить поиск/, calls: 1 },
    { name: "search timeout", error: new DOMException("Request aborted", "AbortError"), expected: /Поиск не успел/, calls: 1 },
    { name: "no results", status: 200, expected: /не нашёл.*результат/, calls: 1 }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      configureKeys(t, scenario.key ?? "test-serper");
      const calls = [];
      t.mock.method(globalThis, "fetch", async url => {
        calls.push(url);
        assert.equal(url, "https://google.serper.dev/search");
        if (scenario.error) throw scenario.error;
        return { ok: scenario.status === 200, status: scenario.status, json: async () => ({ organic: [] }) };
      });
      const result = await ask();
      assert.match(result.response.text, scenario.expected);
      assert.equal(calls.length, scenario.calls);
      assert.deepEqual(result.session_state.history, []);
    });
  }
});

test("Gemini timeout returns the actual search excerpts", async t => {
  configureKeys(t);
  t.mock.method(globalThis, "fetch", async url => {
    if (url === "https://google.serper.dev/search") return { ok: true, json: async () => sources };
    throw new DOMException("Request aborted", "AbortError");
  });
  const result = await ask();
  assert.match(result.response.text, /Зонд передал новые снимки/);
  assert.doesNotMatch(result.response.text, /https?:\/\//);
  assert.ok(result.response.text.length <= 1024);
  assert.equal(result.session_state.history.at(-1).text, result.response.text);
});

test("ordinary questions still work without a search key", async t => {
  configureKeys(t, "");
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Небо голубое из-за рассеяния света." }] } }] }) };
  });
  const result = await ask("Почему небо голубое?");
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(result.response.text, /рассеяния света/);
});

test("search plus a slow Gemini stays within Alice's response deadline", async t => {
  configureKeys(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://google.serper.dev/search") {
      await new Promise(resolve => setTimeout(resolve, 1100));
      return { ok: true, json: async () => sources };
    }
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), { once: true });
    });
  });
  const startedAt = performance.now();
  const result = await ask();
  assert.ok(performance.now() - startedAt < 4400);
  assert.match(result.response.text, /Зонд передал новые снимки/);
});

test("an aborted response body is reported as a search timeout", async t => {
  configureKeys(t);
  const fetch = t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://google.serper.dev/search");
    return { ok: true, json: async () => { throw new DOMException("Request aborted", "AbortError"); } };
  });
  const result = await ask();
  assert.match(result.response.text, /Поиск не успел/);
  assert.equal(fetch.mock.callCount(), 1);
});
