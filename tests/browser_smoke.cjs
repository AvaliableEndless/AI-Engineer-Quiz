/* Run against an isolated catalog created by scripts/seed_quiz.py. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const baseURL = process.env.KEEPSTACK_TEST_URL || "http://127.0.0.1:8001";
const output = path.resolve("data/browser-output");
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;

async function main() {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(baseURL);
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin");
  await page.locator('#login-form button[type="submit"]').click();

  async function ready(info) {
    await page.waitForFunction(() => document.querySelector("#grid").getAttribute("aria-busy") === "false" &&
      !document.querySelector("#export-csv").disabled);
    if (info) assert.equal(await page.locator("#page-info").textContent(), info);
  }
  async function tag(group, name, checked = true) {
    const details = page.locator("#" + group + "-tags").locator("..");
    if (!(await details.evaluate(el => el.open))) await details.locator("summary").click();
    await page.getByRole("checkbox", { name: (group === "include" ? "Include" : "Exclude") + " tag " + name, exact: true }).setChecked(checked);
    await ready();
    if (await details.evaluate(el => el.open)) await details.locator("summary").click();
  }
  async function search(q) { await page.locator("#search").fill(q); await ready(); }
  async function ids() { return page.locator("#grid .card").evaluateAll(cards => cards.map(c => c.dataset.uuid)); }
  async function download(name) {
    const event = page.waitForEvent("download");
    await page.locator("#export-csv").click();
    const file = await event;
    const target = path.join(output, name + ".csv");
    await file.saveAs(target);
    const script = "import csv,json,sys; f=open(sys.argv[1],encoding='utf-8-sig',newline=''); print(json.dumps(list(csv.DictReader(f)),ensure_ascii=True))";
    return JSON.parse(execFileSync(process.env.KEEPSTACK_TEST_PYTHON || "python", ["-c", script, target], { encoding: "utf8" }));
  }
  async function api(url, opts) {
    return page.evaluate(([url, opts]) => api(url, opts), [url, opts]);
  }
  async function save(title, description) {
    await page.locator("#e-title").fill(title);
    await page.locator("#e-description").fill(description);
    const response = page.waitForResponse(r => r.request().method() === "PATCH" && r.url().includes("/api/assets/"));
    await page.locator("#d-save").click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(title => document.querySelector(".detail-title")?.textContent === title, title);
    await ready();
  }

  await ready("1-20 of 52");
  await search("harbor");
  await page.locator("#collection-filter").selectOption("1"); await ready();
  await page.locator("#media-filter").selectOption("image"); await ready();
  await tag("include", "approved"); await tag("include", "campaign"); await tag("exclude", "internal");
  await ready("1-20 of 45");
  const newest = await ids();
  await page.locator("#next-page").click(); await ready("21-40 of 45");
  newest.push(...await ids());
  const csv = await download("all-45");
  assert.equal(csv.length, 45);
  await page.locator("#next-page").click(); await ready("41-45 of 45");
  newest.push(...await ids());
  assert.equal(new Set(newest).size, 45);
  assert.deepEqual(csv.map(row => row.uuid), newest);
  await page.locator("#sort").selectOption("oldest"); await ready("1-20 of 45");
  assert.deepEqual(await ids(), [...newest].reverse().slice(0, 20));
  assert.deepEqual((await download("oldest")).map(row => row.uuid), [...newest].reverse());
  await page.locator("#prev-page").isDisabled().then(value => assert(value));
  await page.locator("#grid .thumb").first().evaluate(img => img.decode());
  await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });

  await tag("exclude", "approved");
  await ready("0 results");
  assert.equal((await download("empty")).length, 0);
  await tag("exclude", "approved", false);
  await ready("1-20 of 45");
  await page.locator("#next-page").click(); await ready("21-40 of 45");
  const specialTag = '客户, "宣传" & 50%_';
  await tag("include", specialTag); await ready("1-1 of 1");
  assert(JSON.parse((await download("special-tag"))[0].tags).includes(specialTag));
  await tag("include", specialTag, false); await ready("1-20 of 45");
  await page.locator("#next-page").click(); await ready("21-40 of 45");
  await page.locator("#prev-page").click(); await ready("1-20 of 45");
  const uuid = (await ids())[0];
  const original = (await api("/api/assets/" + uuid)).asset;
  try {
    await page.locator("#grid .card").first().click();
    await page.locator("#e-title").waitFor();
    await save("Browserneedle 中文, \"标题\"", "Browsercaption, \"引号\"\n下一行");
    await page.locator("#drawer-close").click();
    await search("browserneedle"); await ready("1-1 of 1");
    const edited = await download("edited");
    assert.equal(edited[0].title, "Browserneedle 中文, \"标题\"");
    assert.equal(edited[0].description, "Browsercaption, \"引号\"\n下一行");
    await page.locator("#grid .card").first().click(); await page.locator("#e-title").waitFor();
    await save(original.title, original.description || "");
    await page.locator("#drawer-close").click();
    await search("harbor"); await ready("1-20 of 45");
    await page.locator("#grid .card").first().click(); await page.locator("#tag-add").waitFor();
    await page.locator('#tag-row .rm[data-tag="campaign"]').click();
    await page.waitForFunction(() => !document.querySelector('#tag-row .rm[data-tag="campaign"]'));
    await ready("1-20 of 44");
    await page.locator("#drawer-close").click();
    assert.equal((await download("removed-tag")).length, 44);
    // Reopen the edited asset through the existing detail function.
    await page.evaluate(uuid => openAsset(uuid), uuid);
    await page.locator("#tag-add").fill("campaign");
    await page.locator("#tag-add").press("Enter");
    await page.locator('#tag-row .rm[data-tag="campaign"]').waitFor();
    await ready("1-20 of 45");
    await page.locator("#drawer-close").click();
  } finally {
    // Keep the demonstration catalog reusable even after an assertion fails.
    await api("/api/assets/" + uuid, { method: "PATCH", json: { title: original.title, description: original.description } });
    await api("/api/assets/" + uuid + "/tags", { json: { name: "campaign" } });
  }

  await page.route("**/api/assets?**", route => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.locator("#search").fill("failureprobe");
  await page.locator("#library-error").waitFor({ state: "visible" });
  assert(await page.locator("#export-csv").isDisabled());
  await page.unroute("**/api/assets?**");
  await page.locator("#retry-library").click(); await ready("0 results");
  await search("harbor"); await ready("1-20 of 45");
  await page.route("**/api/assets/export.csv?**", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.locator("#export-csv").click();
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("CSV download failed"));
  await page.unroute("**/api/assets/export.csv?**");

  // Ignore abort in this test so a deliberately late response exercises the version guard.
  await page.evaluate(() => {
    const fetchOriginal = window.fetch;
    window.fetch = (url, opts) => fetchOriginal(url, String(url).startsWith("/api/assets?") ? { ...opts, signal: undefined } : opts);
  });
  let slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  await page.route("**/api/assets?**", async route => {
    if (new URL(route.request().url()).searchParams.get("q") !== "slowprobe") return route.continue();
    slowStarted();
    await pause(900);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 999, items: [], facets: {} }) });
  });
  await page.locator("#search").fill("slowprobe"); await started;
  await search("harbor"); await ready("1-20 of 45"); await pause(1100);
  await ready("1-20 of 45");
  await page.unroute("**/api/assets?**");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("hidden"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const includeDetails = page.locator("#include-tags").locator("..");
  await includeDetails.locator("summary").click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await includeDetails.locator("summary").click();
  await page.locator("#clear-filters").click(); await ready("1-20 of 52");
  assert.equal(await page.locator("#search").inputValue(), "");
  assert.equal(await page.locator("#collection-filter").inputValue(), "");
  assert.equal(await page.locator("#media-filter").inputValue(), "");
  assert.equal(await page.locator("#sort").inputValue(), "oldest");
  assert.deepEqual(errors, []);
  console.log("PASS: login, combined filters, stable pages, full/empty CSV, edits, failures, late responses, mobile, clear filters");
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
