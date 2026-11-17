/**
 * Runs every query listed in one or more gauge spec tables straight against the API (no UI steps), then writes an HTML and JSON report
 * with each query's iri, name, status and result count, plus the definition, executed SQL and SQL error for any that errored. Queries that
 * ran can be expanded to their sub queries, as in the UI's job table.
 * The running and the report are shared with the UI's "Query reports" menu (shared/queryReport.ts).
 *
 * Usage: pnpm test:queries [options] [suite | spec.md ...]   (suites: default, qof, smh, all; defaults to "default")
 *        pnpm test:queries:qof | test:queries:smh | test:queries:all [options]
 *
 * Options:
 *   --single-job              Send all the queries as one job (or QUERY_SINGLE_JOB=true)
 *   --org=<id|ods>[,...]      Run against these organisations only, as the organisation filter of "Search and run" does. Takes
 *                             organisation ids or ODS codes (or QUERY_ORG)
 *   --search-date=yyyy-mm-dd  Overrides search_date
 *
 * --single-job (or QUERY_SINGLE_JOB=true) sends all the queries as one job instead of a job each. QUERY_TIMEOUT then applies per query,
 * so the job gets QUERY_TIMEOUT times the number of queries. The first query to fail errors the job and cancels those not yet run.
 *
 * Env: BASE_URL, TEST_USERNAME, TEST_PASSWORD, QUERY_CONCURRENCY (jobs in flight, default 50), QUERY_TIMEOUT (ms per job, default 120000),
 *      QUERY_SINGLE_JOB, QUERY_ORG, search_date (yyyy-mm-dd; defaults to search_date in env/default/default.properties, shared with the e2e specs),
 *      headless_chrome (set to "false" to watch the login)
 *
 * The API needs a nuxt-auth-utils session, which only the Casdoor OIDC flow can create, so a headless browser signs in once and its
 * cookies are then used for plain API requests.
 */

const { chromium } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { QUERY_REPORT_SUITES, fileStamp, formatDuration, htmlReport, readSpec, runQueries } = require("../../shared/queryReport.ts");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const CONCURRENCY = Number.parseInt(process.env.QUERY_CONCURRENCY || "50");
const JOB_TIMEOUT = Number.parseInt(process.env.QUERY_TIMEOUT || "120000");
const SPEC_DIR = "tests/e2e/specs/queries";
const OUTPUT_DIR = path.join(__dirname, "outputs");
const OPTIONS = ["--single-job", "--org", "--search-date"];

/** A value from the gauge default env, so these runs use the same settings as test:e2e */
function gaugeProperty(name) {
  const file = path.join(__dirname, "../../env/default/default.properties");
  if (!fs.existsSync(file)) return undefined;
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .find(line => line.split("=")[0].trim() === name);
  return line && line.slice(line.indexOf("=") + 1);
}

async function login(browser) {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/auth/login?redirect=/`);
  await page.fill('input[placeholder="username, Email or phone"]', process.env.TEST_USERNAME || "testuser");
  await page.fill('input[placeholder="Password"]', process.env.TEST_PASSWORD || "testpass");
  await page.click("button >> text=Sign In");
  await page.waitForURL(url => url.origin === new URL(BASE_URL).origin, { timeout: 60000 });
  await page.close();

  const session = await (await context.request.get("/api/_auth/session")).json().catch(() => ({}));
  if (!session.user) throw new Error("Login did not create a session");
  return context.request;
}

/** The body of a Playwright response, throwing the server's message if it failed. */
async function body(response) {
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {}
  if (!response.ok())
    throw new Error((parsed && (parsed.message || parsed.statusMessage)) || (typeof parsed === "string" && parsed) || `HTTP ${response.status()}`);
  return parsed;
}

/** QueryReportApi over the signed-in Playwright request context. */
function reportApi(request) {
  return {
    addJob: async data => body(await request.post("/api/queue/job/add", { data, timeout: JOB_TIMEOUT })),
    getJob: async jobId => body(await request.get(`/api/queue/job/${jobId}`)),
    getSummaries: async jobId => body(await request.get(`/api/queue/job/results/${jobId}/summary`)),
    getDefinition: async iri => body(await request.get(`/api/imapi/query/queryFromIri?queryIri=${encodeURIComponent(iri)}`))
  };
}

/** "--name=value" or "--name value" options, and the remaining arguments. */
function parseArgs(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const [name, inline] = [arg.split("=")[0], arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined];
    if (!OPTIONS.includes(name)) throw new Error(`Unknown option ${name} (options: ${OPTIONS.join(", ")})`);
    if (name === "--single-job") options[name] = true;
    else if (inline !== undefined) options[name] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) options[name] = argv[++i];
    else throw new Error(`${name} needs a value`);
  }
  return { options, rest };
}

/** Organisation ids for the given ids or ODS codes, failing on any that match no organisation. */
async function organisationIds(request, values) {
  if (!values.length) return [];
  const organisations = await body(await request.get("/api/organisation"));
  return values.map(value => {
    const match = organisations.find(org => String(org.id) === value || org.odsCode?.toLowerCase() === value.toLowerCase());
    if (!match) throw new Error(`No organisation with id or ODS code "${value}"`);
    return String(match.id);
  });
}

/** Suite names expand to their spec files; anything else is taken as a spec path. */
function specFiles(args) {
  return (args.length ? args : ["default"]).flatMap(arg =>
    QUERY_REPORT_SUITES[arg] ? QUERY_REPORT_SUITES[arg].specs.map(spec => path.join(SPEC_DIR, spec)) : [arg]
  );
}

async function main() {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const singleJob = !!options["--single-job"] || process.env.QUERY_SINGLE_JOB === "true";
  const orgs = (options["--org"] ?? process.env.QUERY_ORG ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const searchDate = (options["--search-date"] ?? process.env.search_date ?? gaugeProperty("search_date") ?? "").trim();
  if (searchDate && !/^\d{4}-\d{2}-\d{2}$/.test(searchDate)) throw new Error(`Search date "${searchDate}" is not yyyy-mm-dd`);
  const specs = specFiles(rest);
  const queries = specs.flatMap(file => readSpec(path.basename(file), fs.readFileSync(file, "utf8")));
  console.log(
    `Running ${queries.length} queries from ${specs.join(", ")} against ${BASE_URL} (${singleJob ? "as a single job" : `${CONCURRENCY} at a time`}, search date ${searchDate || "today"}${orgs.length ? `, organisations ${orgs.join(", ")}` : ""})`
  );

  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();
  const browser = await chromium.launch({ headless: process.env.headless_chrome !== "false" });
  let results;
  let organisations;
  try {
    const request = await login(browser);
    organisations = await organisationIds(request, orgs);
    const api = reportApi(request);
    results = await runQueries(api, queries, {
      concurrency: CONCURRENCY,
      timeout: JOB_TIMEOUT,
      singleJob,
      searchDate: searchDate || undefined,
      organisationIds: organisations,
      onProgress: (done, total, r) =>
        r &&
        console.log(
          `[${done}/${total}] ${r.status.padEnd(14)} ${String(r.count ?? "").padStart(8)} ${(r.durationMs === null ? "-" : formatDuration(r.durationMs)).padStart(8)}  ${r.name || r.iri}`
        )
    });
  } finally {
    await browser.close();
  }

  const durationMs = Date.now() - startTime;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = fileStamp(startedAt);
  const htmlFile = path.join(OUTPUT_DIR, `query-report-${stamp}.html`);
  fs.writeFileSync(htmlFile, htmlReport(results, { baseUrl: BASE_URL, startedAt, durationMs, singleJob, searchDate, organisationIds: organisations }));
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `query-report-${stamp}.json`),
    JSON.stringify(
      { baseUrl: BASE_URL, startedAt, durationMs, singleJob, searchDate: searchDate || null, organisationIds: organisations ?? [], specs, results },
      null,
      2
    )
  );

  const failed = results.filter(r => r.status !== "COMPLETED");
  console.log(`\n${results.length - failed.length}/${results.length} passed in ${formatDuration(durationMs)}. Report: ${htmlFile}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
