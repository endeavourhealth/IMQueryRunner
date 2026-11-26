/* globals gauge */

const { chromium, expect } = require("@playwright/test");
const { pw } = require("./playwright");
const path = require("path");
const fs = require("fs");
const assert = require("node:assert");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
// Must stay below gauge's per-step test_timeout (40000ms in env/default)
const SUBMIT_TIMEOUT = Number.parseInt(process.env.submit_timeout || "35000");
const JOB_TIMEOUT = Number.parseInt(process.env.job_timeout || "35000");
let currentSpec, currentScenario;

function isJobAddResponse(response) {
  return response.request().method() === "POST" && response.url().includes("/api/queue/job/add");
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toJob(response) {
  return response
    .json()
    .catch(() => null)
    .then(body => ({ id: body && body.jobId, name: (response.request().postDataJSON() || {}).jobName, status: response.status() }));
}

// Pins $searchDate so expected counts don't drift with the day the specs run; the date picker emits the argument as it is typed
async function setSearchDate() {
  const searchDate = (process.env.search_date || "").trim();
  if (!searchDate) return;
  const input = pw.page.locator('input[data-testid="search-date-input"], [data-testid="search-date-input"] input').first();
  await input.fill(searchDate);
  await input.press("Escape");
  await expect(input).toHaveValue(searchDate);
}

function toFileName(text) {
  return text.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
}

// Rows of a table-driven scenario share its name, so the selected query and a timestamp keep each row's screenshot separate
gauge.customScreenshotWriter = async function () {
  const name = [currentSpec.name, currentScenario.name, pw.screenshotLabel, Date.now()].filter(Boolean).join("-");
  const screenshotFilePath = path.join(process.env["gauge_screenshots_dir"], `${toFileName(name)}.png`);
  await pw.page.screenshot({ path: screenshotFilePath });
  return screenshotFilePath;
};

beforeSpec(async context => {
  currentSpec = context.currentSpec;
});

beforeScenario(async context => {
  currentScenario = context.currentScenario;
  pw.browser = await chromium.launch({
    headless: process.env.headless_chrome === "true" || false
  });
  pw.context = await pw.browser.newContext();
  pw.page = await pw.context.newPage();
  pw.submittedJob = null;
  pw.screenshotLabel = null;
  pw.job = new Promise(resolve => (pw.resolveJob = resolve));
  pw.page.on("response", response => {
    if (isJobAddResponse(response)) pw.resolveJob(toJob(response));
  });
});

afterScenario(async () => {
  await pw.context.close();
  await pw.browser.close();
});

// In a parallel run every stream runs the suite hooks, and the first to finish must not clear jobs another stream is still checking.
// Each stream registers itself here while it runs; only the last one to finish clears the queue. Files left by dead processes are ignored
const RUNNERS_DIR = path.join(__dirname, "..", "outputs", "runners");
const CLEAR_LOCK = path.join(RUNNERS_DIR, "clear.lock");
const runnerFile = () => path.join(RUNNERS_DIR, `runner-${process.pid}`);

function isAlive(file) {
  const pid = Number.parseInt(fs.readFileSync(file, "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function removeIfDead(file) {
  try {
    if (!isAlive(file)) fs.rmSync(file, { force: true });
  } catch (error) {
    // Already removed by another stream
  }
}

// True when no other stream is still running and this stream won the right to clear the queue
function isLastRunner() {
  fs.rmSync(runnerFile(), { force: true });
  const others = fs.readdirSync(RUNNERS_DIR).filter(name => name.startsWith("runner-"));
  others.forEach(name => removeIfDead(path.join(RUNNERS_DIR, name)));
  if (fs.readdirSync(RUNNERS_DIR).some(name => name.startsWith("runner-"))) return false;
  try {
    fs.writeFileSync(CLEAR_LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    return false;
  }
}

beforeSuite(async context => {
  if (!context.runnerId) return;
  fs.mkdirSync(RUNNERS_DIR, { recursive: true });
  if (fs.existsSync(CLEAR_LOCK)) removeIfDead(CLEAR_LOCK);
  fs.writeFileSync(runnerFile(), String(process.pid));
});

// Once every spec has run, sign in as the test user in a fresh browser and clear the jobs the run left in the queue
afterSuite(async context => {
  if (context.runnerId && !isLastRunner()) {
    console.log("Other streams are still running, leaving the queue for the last one to clear");
    return;
  }
  const browser = await chromium.launch({ headless: process.env.headless_chrome === "true" || false });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${BASE_URL}/`);
    await login(page);
    await clearAllJobs(page);
  } finally {
    await browser.close();
    if (context.runnerId) fs.rmSync(CLEAR_LOCK, { force: true });
  }
});

step("Open IMQueryRunner", async () => {
  await pw.page.goto(`${BASE_URL}/`);
});

async function login(page) {
  const username = process.env.TEST_USERNAME || "testuser";
  const password = process.env.TEST_PASSWORD || "testpass";

  await page.fill('input[placeholder="username, Email or phone"]', username);
  await page.fill('input[placeholder="Password"]', password);
  await page.click("button >> text=Sign In");

  //dev login loop
  //page.locator("button").filter({ hasText: "cypress" }).click();

  await page.waitForSelector('[data-testid="accept-all-cookies"]', { state: "visible" });
  await page.click('[data-testid="accept-all-cookies"]');
}

// Deletes every finished job of the test user through the queue page's "Clear all jobs" button (running jobs are kept by the app)
async function clearAllJobs(page) {
  await page.goto(`${BASE_URL}/QueryRunner`);
  await expect(page.locator('[data-testid="job-table"]')).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".p-datatable-loading-icon")).toBeHidden({ timeout: 30000 });
  const clearButton = page.locator('[data-testid="job-table-clear"]');
  // The button stays disabled until the job list has loaded, so give it time to enable before deciding there is nothing to clear
  try {
    await expect(clearButton).toBeEnabled({ timeout: 15000 });
  } catch (error) {
    console.log("No jobs to clear");
    return;
  }
  await clearButton.click();
  const dialog = page.locator(".p-confirmdialog");
  await dialog.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".p-toast-message").filter({ hasText: "Jobs cleared" })).toBeVisible({ timeout: 120000 });
  console.log(await page.locator(".p-toast-message").filter({ hasText: "Jobs cleared" }).innerText());
}

step("Login", async () => {
  await login(pw.page);
});

step("Clear all jobs", async () => {
  await clearAllJobs(pw.page);
});

step("Goto route <route>", async route => {
  await pw.page.goto(`${process.env.BASE_URL || "http://localhost:8082"}${route}`);
});

step("Click logo to return to homepage", async () => {
  await pw.page.locator('[data-testid="im-logo"]').click();
  await pw.page.waitForSelector("#shortcuts-container");
});

step("Click <text> button", async text => {
  await pw.page.getByRole("button", { name: text, exact: true }).click();
});

step("Type <text> into <input>", async (text, input) => {
  await pw.page.getByPlaceholder(input).fill(text);
});

step("Search for <text>", async text => {
  await pw.page.waitForSelector('[data-testid="search-input"]');
  const txt = await pw.page.inputValue('[data-testid="search-input"]');
  if (txt === text) {
    pw.page.click('button >> text="Search"');
  } else {
    await pw.page.fill('[data-testid="search-input"]', text);
  }
  await pw.page.waitForSelector("#search-results-main-container >> tr");
});

step("Select <text> result", async text => {
  const node = pw.page.locator("#search-results-main-container >> tr").filter({ hasText: text }).first();
  await node.waitFor({ state: "visible" });
  await node.click();
  await pw.page.waitForSelector(".back-to-search", { state: "visible" });
});

step("Click dialog confirm", async () => {
  await pw.page.locator(".p-confirmdialog").locator(".p-confirmdialog-accept-button").click();
});

step("Search for <text> and select", async text => {
  pw.screenshotLabel = text;
  await pw.page.waitForSelector("#autocomplete-search", { state: "visible" });
  await pw.page.locator("#autocomplete-search").nth(0).fill(text);
  await pw.page.locator(".p-autocomplete-option").filter({ hasText: text }).click();
  await expect(pw.page.locator(".p-autocomplete-overlay")).toBeHidden();
  await expect(pw.page.locator(".p-datatable")).toBeVisible({ timeout: 30000 });
  await setSearchDate();
  await expect(pw.page.getByRole("button", { name: "Add to queue" })).toBeEnabled();
});

step("Search for <search> and select <select>", async (search, select) => {
  pw.screenshotLabel = select;
  await pw.page.waitForSelector("#autocomplete-search", { state: "visible" });
  await pw.page.locator("#autocomplete-search").nth(0).fill(search);
  await pw.page.locator(".p-autocomplete-option").filter({ hasText: select }).click();
  await expect(pw.page.locator(".p-autocomplete-overlay")).toBeHidden();
  await expect(pw.page.locator(".p-datatable")).toBeVisible({ timeout: 30000 });
  await setSearchDate();
  await expect(pw.page.getByRole("button", { name: "Add to queue" })).toBeEnabled();
});

step("Wait <time> seconds", async time => {
  await pw.page.waitForTimeout(Number.parseInt(time) * 1000);
});

step("Wait for job to submit", async () => {
  await pw.page.waitForSelector(".p-treetable", { state: "visible" });
  // The queue page can show its datatable before the add request has responded. Building the job calls IMAPI for each query,
  // which can be slow on the first run, so a late response is not an error here: "Wait for job to complete" keeps waiting for it
  const started = Date.now();
  pw.submittedJob = await withTimeout(pw.job, SUBMIT_TIMEOUT, "timeout").catch(() => null);
  console.log(pw.submittedJob ? `Job add responded after ${Date.now() - started}ms` : `Job add had not responded after ${SUBMIT_TIMEOUT}ms`);
});

step("Wait for job to complete", async () => {
  // Each step has its own timeout, so a slow add response gets a second full window here
  const job = pw.submittedJob || (await withTimeout(pw.job, JOB_TIMEOUT, `No job add response within ${SUBMIT_TIMEOUT + JOB_TIMEOUT}ms of clicking Run`));
  const deadline = Date.now() + JOB_TIMEOUT;
  assert.ok(job.id, `Queueing job "${job.name}" returned no jobId (HTTP ${job.status}); check the RabbitMQ connection`);
  let status;
  while (Date.now() < deadline) {
    const response = await pw.page.request.get(`${BASE_URL}/api/queue/job/${job.id}`);
    assert.ok(response.ok(), `Job ${job.id} status request failed with HTTP ${response.status()}`);
    const data = await response.json();
    status = data.status;
    if (["COMPLETED", "ERRORED", "CANCELLED"].includes(status)) {
      console.log(`Job ${job.id} "${job.name}" finished with status ${status}`);
      await pw.page.getByRole("button", { name: "Refresh", exact: true }).click();
      const loading = pw.page.locator(".p-datatable-loading-icon");
      await expect(loading).toBeHidden({ timeout: 30000 });
      await expect(pw.page.locator('[data-testid="job-table"]')).toBeVisible();
      const row = pw.page.locator("table tbody tr").filter({ hasText: job.name }).nth(0);
      await expect(row).toBeVisible();
      await expect(row.locator(".p-tag")).toContainText(status);
      return;
    }
  }
  assert.fail(`Job ${job.id} still "${status}" after ${JOB_TIMEOUT}ms`);
});

step("Wait for job table to finish loading", async () => {
  const loading = pw.page.locator(".p-datatable-loading-icon");
  await expect(loading).toBeHidden({ timeout: 30000 });
  await expect(pw.page.locator('[data-testid="job-table"]')).toBeVisible();
});
