# Daily Query Cache: Specification

Status: Draft
Date: 2026-11-24

## 1. Summary

The daily cache is optional. It lets a job reuse query results that the same user already produced earlier the same day,
so those queries do not run again.

- A job sent with `saveAsDailyCache: true` marks every query result it produces as the user's daily cache.
- A job sent with `useDailyCache: true` checks the cache before it runs each query. A query counts as a hit when an earlier
  result matches all of these:
  - same query IRI
  - same arguments
  - same user
  - flagged as daily cache
  - completed today

  On a hit, the job reuses that result. On a miss, the query runs as normal.

Both flags default to `false`, so existing callers see no change in behaviour.

## 2. Goals and non-goals

**Goals**

- Avoid running the same expensive query again within a day, for example across a dashboard's several jobs or repeated runs.
- A job's results must look the same whether they were computed or taken from the cache: summaries, patient lists, downloads,
  comparisons, the sub query tree and the executed SQL.
- Make it visible which results came from the cache.

**Non-goals**

- Sharing the cache between users. It is always scoped to the user.
- Invalidating the cache when the source clinical data changes during the day. The cache is a snapshot by design.
- A cache that lasts longer than a day, or a configurable TTL.
- Caching debug-patient queries (`$debugPatientId`).

## 3. API

### 3.1 `POST /api/queue/job/add`

Two optional boolean fields are added to `jobRequestSchema` (`models/jobRequest.schema.ts`):

| Field              | Type    | Default | Meaning                                                                                   |
| ------------------ | ------- | ------- | ----------------------------------------------------------------------------------------- |
| `saveAsDailyCache` | boolean | `false` | Every query result this job completes is available as the user's daily cache for today.  |
| `useDailyCache`    | boolean | `false` | Before running each query, look for a matching daily-cache result and reuse it if found.  |

```json
{
  "jobName": "Morning QOF run",
  "queryRequests": [ ... ],
  "saveAsDailyCache": true,
  "useDailyCache": true
}
```

- A job can set both flags. It reuses whatever is already cached, and every result it ends up with, computed or reused, is
  saved as cache.
- The API uses camelCase like the existing fields. The database columns are `save_as_daily_cache` and `use_daily_cache`.

### 3.2 Responses

The response of `add` does not change. Result and summary endpoints return a `fromDailyCache` boolean for each query result
(see §6), so the UI can label reused results.

## 4. Data model

### 4.1 Reuse the existing, unused snapshot columns (recommended)

`job`, `query_result_set`, `query_result` and `indicator_result` already have `start_of_day_snapshot` and
`use_start_of_day_snapshot`. They are written from the job request but nothing reads them. They are the same concept as this
feature, so having both sets of columns would be confusing. Proposal:

| Existing column             | Becomes               |
| --------------------------- | --------------------- |
| `start_of_day_snapshot`     | `save_as_daily_cache` |
| `use_start_of_day_snapshot` | `use_daily_cache`     |

Rename them across all four tables, in `server/db/mysql/schema.ts`, `0000_create_tables.sql` / `dataset.sql`, the Zod models
and `mysqlHelper.ts`. The request fields `startOfDaySnapshot` / `useStartOfDaySnapshot` are replaced by the new names. If
existing API clients still send the old names, keep them as deprecated aliases for one release (see §10, Q1).

Alternative: keep the old columns and add new ones. Not recommended.

### 4.2 New columns on `query_result`

| Column                         | Type          | Purpose                                                                          |
| ------------------------------ | ------------- | -------------------------------------------------------------------------------- |
| `cached_from_query_result_id`  | `int NULL`    | The source result this one was copied from. `NULL` means it was computed.       |
| `user_id`                      | `varchar(45)` | Denormalised from `job.user_id`, so the cache lookup needs no join to `job`.     |

`user_id` is optional. The lookup can join through `query_result_set` to `job` instead (see §5.2). Add it only if the join
turns out to be slow.

### 4.3 Index

```sql
CREATE INDEX idx_query_result_daily_cache
  ON dataset.query_result (query_iri, version, save_as_daily_cache, status, end_time);
```

If `user_id` is added, put it first in the index.

## 5. Behaviour

### 5.1 Saving (`saveAsDailyCache`)

- `createJobEntry`, `createResultSetEntry`, `createQueryResultEntry` and `createIndicatorResultEntry` copy the job's flag onto
  every row they create. That includes sub query results created on demand in `runSubQueries`.
- A result only counts as cache once it is `COMPLETED`. Results that are `QUEUED`, `RUNNING`, `ERRORED` or `CANCELLED` never
  match.
- Debug-patient queries are never saved as cache, whatever the flag says.

### 5.2 Lookup (`useDailyCache`)

For each query result the job is about to compute (top-level cohort or dataset request, indicator sub query, or sub query
reached through `runSubQueries`), search for a source result where all of the following hold:

| Condition                                   | Why                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `query_result.query_iri = :iri`             | Same query.                                                                 |
| `query_result.version = :hash`              | Same arguments (see §5.3).                                                  |
| `job.user_id = :userId`                     | Same user.                                                                  |
| `query_result.save_as_daily_cache = 1`      | Explicitly offered as cache.                                                |
| `query_result.status = 'COMPLETED'`         | Finished and successful.                                                    |
| `DATE(query_result.end_time) = :today`      | Produced today (see §5.4).                                                  |
| `query_result.cached_from_query_result_id IS NULL` *or* follow it to the source | Avoid chains of copies; always point at the original (see §5.5). |
| `query_result_set.job_id <> :currentJobId`  | Reuse inside a job is already handled by `getQueryResultIfExistsInJob`.     |

When several rows match, take the most recent (`ORDER BY end_time DESC LIMIT 1`).

The lookup goes in a new helper, `findDailyCacheResult(userId, iri, hash, today)`, in `server/utils/executeQuery.ts` next to
`getQueryResultIfExists` / `getQueryResultIfExistsInJob`.

### 5.3 Matching on arguments as well as the IRI

The request says "same IRI". This spec also matches on `version`, which is `hashQueryRequest`: a hash of the IRI and the
resolved arguments. Without it, a result for `$searchDate = 2025-04-01` could be reused for a request with
`$searchDate = 2026-11-24`, or a result filtered to one set of organisations could be reused for another. The defaults
(`$searchDate` / `$achievementDate` = today) are filled in by `resolveArgs` before hashing, so a default run still matches any
other default run of the same query that day. See §10, Q2.

### 5.4 "Today"

`today` is `getToday()`, which is the **UTC** date (`new Date().toISOString().slice(0, 10)`). That matches how default
`$searchDate` values are produced. Between 00:00 and 01:00 BST, the UTC date is still the previous day, so the cache would be
treated as yesterday's. If the business day should follow UK local time, both `getToday()` and this lookup need to use
`Europe/London` (see §10, Q3). The date compared is the date the **result completed** (`end_time`), not the date the job was
queued.

### 5.5 Reusing a hit

The cache reuses a result by **copying it into the current job**. Read endpoints do not redirect to the source result. On a hit
for a result with planned id `R` (the row already created by `planJob` or `runSubQueries`) and source result `S`:

1. Mark `R` `RUNNING` as now.
2. Copy the result rows server-side, in batches of `DELETE_BATCH_SIZE` so no single statement holds a long lock:
   - cohort: `INSERT INTO cohort_results (query_result_id, entity_id, entity_org_id) SELECT :R, entity_id, entity_org_id FROM cohort_results WHERE query_result_id = :S`
   - dataset: the same for `dataset_results` (`entity_id, column_group, json, entity_org_id`).
3. Copy `executed_sql` from `S` to `R`, and set `R.cached_from_query_result_id = S` (or `S.cached_from_query_result_id` if `S` is
   itself a copy, so the column always points at the original).
4. **Copy the sub query tree.** Job summaries (`jobSummaries.ts`) and patient inclusion (`patientInclusion.ts`) read
   `query_dependency`, so `S`'s sub query results must exist in the current job too. Walk `query_dependency` from `S`. For each
   sub result, reuse the matching result already in the current job (`getQueryResultIfExistsInJob`) or create one, and copy
   it the same way. Then insert the dependency edges with `createQueryDependencies`. Sub results found this way are copied
   from `S`'s tree whether or not they carry the cache flag, because they belong to a result that does.
5. Mark `R` `COMPLETED`, which sets `end_time`, and emit the queue update as usual.
6. Skip `runSubQueries`, `getValidatedSQL` and SQL execution for `R`.

If any step fails, delete the partly copied rows for `R`, log a warning and **fall back to running the query normally**. A
cache failure must never fail the job.

**Why copy rather than reference?** Every read path (results, ids, download, summaries, patient inclusion, comparison, SQL view)
and `deleteJobData` keys on `query_result_id`. Copying keeps all of them unchanged, and deleting the source job leaves the
copies intact. The cost is extra rows and an `INSERT … SELECT`, which is still far cheaper than running the query. A
reference-based variant is noted in §9.

### 5.6 Where the check runs

| Path                                                              | Change                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `executeQuery` (top-level cohort or dataset, indicator sub query) | After the existing `getQueryResultIfExists` check, if `job.useDailyCache` is set, try §5.5 before `runSubQueries`. |
| `runSubQueries`                                                   | After `getQueryResultIfExistsInJob` misses, try §5.5 for that sub query before executing its SQL.       |
| `runPlannedRequest`                                               | If every query to run for the request was a hit, skip `getValidatedSQL` (it calls IMAPI).               |
| Indicators                                                        | `indicator_result` itself is not copied. Its sub queries hit or miss one by one through `executeQuery`. |

The current job is already available in `runPlannedRequest`. Pass `useDailyCache` and `userId` down through `QueryResultSet`,
which already carries `userId` and `useStartOfDaySnapshot`, so function signatures do not change.

### 5.7 Interaction with jobs still running

If job A (`saveAsDailyCache`) is still running when job B (`useDailyCache`) reaches the same query, B finds no `COMPLETED` row and
runs the query itself. B does not wait for A, which keeps the consumer simple and avoids deadlocks. This is accepted behaviour.

### 5.8 Cancel and delete

- Deleting a job with `saveAsDailyCache` removes it from the cache. Jobs that already copied its results keep their copies.
- Cancelling a job: only its results that had already `COMPLETED` remain usable as cache.

## 6. UI (minimal)

- Job submission UI, if and when there is one: two checkboxes, "Save as today's cache" and "Use today's cache".
- Results and summary views show a small "cached" tag on results where `cached_from_query_result_id` is not null. The tooltip
  shows the source job id and completion time.
- The queue list shows the job flags as icons or tags.

## 7. Logging

- `LOG.info` for each hit: `Daily cache hit: iri, hash, source result S → R (n rows)`.
- `LOG.debug` for a miss. `LOG.warn` for a failed copy that fell back to running the query.

## 8. Testing

**Unit (`tests/unit/`)**

- `jobRequestSchema`: both flags default to `false`, and booleans are accepted.
- `findDailyCacheResult` matches only when every condition in §5.2 holds. Cover each negative separately:
  - other user
  - other IRI
  - other arguments
  - flag not set
  - not `COMPLETED`
  - yesterday
  - same job
- Several matches: the most recent wins.
- A hit copies cohort and dataset rows, `executed_sql`, `cached_from_query_result_id` and the sub query tree with its
  dependency edges, and does not call IMAPI or run any SQL.
- A copy failure falls back to running the query, and the job still completes.
- A debug-patient request never saves and never uses the cache.
- `useDailyCache` with no cache available behaves exactly like today's code.
- Both flags set: copied results are themselves flagged as cache, and their `cached_from_query_result_id` points at the
  original.
- Deleting the source job leaves the copies readable.

**E2E**

- Run a job with `saveAsDailyCache`. Then run the same queries with `useDailyCache`. The second job completes, shows the same
  counts and patient lists, and its results are tagged as cached.

## 9. Alternatives considered

- **Reference instead of copy.** Point `R` at `S` and resolve reads through `cached_from_query_result_id`. This stores nothing
  extra, but every read path and the sub query tree resolution would need to follow the pointer, and deleting the source job
  would break every job that references it. Revisit only if copying large datasets is measured to be too slow.
- **Flags per query request instead of per job.** More flexible, but the stated requirement is per job. The flags are stored on
  each `query_result`, so per-request flags can be added later without a schema change.

## 10. Open questions

1. **Old field names.** Do any API clients send `startOfDaySnapshot` / `useStartOfDaySnapshot` today? If so, accept them as
   deprecated aliases. If not, drop them.
2. **Matching key.** Is matching on the IRI plus the argument hash (§5.3) acceptable? Or should the match really ignore
   arguments? Ignoring them would be unsafe for non-default dates and organisation filters.
3. **Day boundary.** UTC (current `getToday()`) or `Europe/London`?
4. **Cleanup.** Should a scheduled task (`server/tasks/`) delete earlier days' cache-only jobs, or are they ordinary jobs that
   the user manages?
