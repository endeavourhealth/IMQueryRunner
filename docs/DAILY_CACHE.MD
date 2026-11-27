# Daily Query Cache: Specification

Status: Implemented
Date: 2026-11-26 (revised from 2026-11-24)

## 1. Summary

The daily cache is on by default and shared by all users. It lets a query that depends on other queries reuse their results
from earlier the same day, so those sub queries do not run again.

There are two rules:

- **Saving.** Every query result a job completes is saved as daily cache. That covers top-level queries and sub queries.
- **Using.** Only **sub queries** (the queries that a job's query depends on) are looked up in the cache. The **top-level
  queries**, the ones added to the job in `queryRequests`, always run.

A sub query counts as a hit when an earlier result matches all of these:

- same query IRI
- same arguments
- flagged as daily cache
- completed today

It does not matter which user produced the result. On a hit, the job reuses that result. On a miss, the sub query runs as
normal, and its own sub queries are then checked against the cache in the same way.

**Example.** `GMS` has no sub queries. `QOF_X` uses `GMS` as a sub query.

| Run | Job contains | What happens                                                                                                            |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `GMS`        | `GMS` is top-level, so it runs. Its result is saved as cache.                                                           |
| 2   | `GMS`        | `GMS` is top-level, so it runs again. The cached result is **not** used. The new result is also saved as cache.         |
| 3   | `QOF_X`      | `QOF_X` is top-level, so it runs. Its sub query `GMS` is looked up, hits the cache from run 2, and is reused, not run.  |
| 4   | `QOF_X`      | `QOF_X` runs again. `GMS` is reused from the cache again.                                                               |

Run 3 can reuse `GMS` whichever user ran jobs 1 and 2.

## 2. Goals and non-goals

**Goals**

- Avoid running the same expensive sub query again within a day, for example a population that many indicators and cohort
  queries depend on, across all users.
- Always run the queries the user asked for directly, so a job that explicitly includes a query gets fresh results for it.
- A job's results must look the same whether a sub query was computed or taken from the cache: summaries, patient lists,
  downloads, comparisons, the sub query tree and the executed SQL.
- Make it visible which results came from the cache.

**Non-goals**

- Using the cache for top-level queries.
- Invalidating the cache when the source clinical data changes during the day. The cache is a snapshot by design.
- A cache that lasts longer than a day, or a configurable TTL.
- Caching debug-patient queries (`$debugPatientId`).

## 3. API

### 3.1 `POST /api/queue/job/add`

The cache needs no request fields. Two optional boolean fields are added to `jobRequestSchema` (`models/jobRequest.schema.ts`)
so a caller can opt out:

| Field              | Type    | Default | Meaning                                                                                  |
| ------------------ | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `saveAsDailyCache` | boolean | `true`  | Every query result this job completes is available as daily cache for today.             |
| `useDailyCache`    | boolean | `true`  | Before running each **sub query**, look for a matching daily-cache result and reuse it.  |

```json
{
  "jobName": "Morning QOF run",
  "queryRequests": [ ... ],
  "useDailyCache": false
}
```

- `useDailyCache` never affects top-level queries. They run whatever its value.
- With both flags at their defaults, a job reuses whatever sub query results are already cached, and every result it ends up
  with, computed or reused, is saved as cache.
- The API uses camelCase like the existing fields. The database columns are `save_as_daily_cache` and `use_daily_cache`.
- This changes behaviour for existing callers: their jobs start saving cache and reusing cached sub query results.
- The old request fields `startOfDaySnapshot` / `useStartOfDaySnapshot` are no longer read. A client that still sends them is not
  rejected (unknown fields are stripped) and gets the defaults.

### 3.2 Responses

The response of `add` does not change. Result and summary endpoints return a `fromDailyCache` boolean for each query result
(see §6), so the UI can label reused results. Top-level results are never `fromDailyCache`.

## 4. Data model

### 4.1 Reuse the existing, unused snapshot columns

`job`, `query_result_set`, `query_result` and `indicator_result` already have `start_of_day_snapshot` and
`use_start_of_day_snapshot`. They were written from the job request but nothing read them. They now hold the cache flags.
**The database columns, and the drizzle / Zod property names, keep their old names.** Only the API fields are new:

| API field          | Column (unchanged)          | Property (unchanged)    |
| ------------------ | --------------------------- | ----------------------- |
| `saveAsDailyCache` | `start_of_day_snapshot`     | `startOfDaySnapshot`    |
| `useDailyCache`    | `use_start_of_day_snapshot` | `useStartOfDaySnapshot` |

`createJobEntry` maps the API fields onto the columns. The column defaults are left alone: the application always writes both
columns. `createResultSetEntry` now copies the flags from the **job**. Before this change it read them from the query request,
which never carried them.

### 4.2 New column on `query_result`

| Column                         | Type       | Purpose                                                                   |
| ------------------------------ | ---------- | ------------------------------------------------------------------------- |
| `cached_from_query_result_id`  | `int NULL` | The source result this one was copied from. `NULL` means it was computed. |

No user column is needed, because the lookup is not scoped to a user.

### 4.3 Index

```sql
CREATE INDEX idx_query_result_daily_cache
  ON dataset.query_result (query_iri, version, save_as_daily_cache, status, end_time);
```

## 5. Behaviour

### 5.1 Top-level queries and sub queries

- A **top-level query** is a query request the job was given in `queryRequests`. That includes cohort, dataset and indicator
  requests.
- A **sub query** is any query a top-level query depends on, at any depth: sub queries reached through `runSubQueries`, and an
  indicator's sub queries (`prepareIndicatorSubQueries` / `getIndicatorSubQueryRequests`).

If the same IRI is both top-level in this job and a sub query of another top-level query in this job, the top-level run wins.
The existing in-job reuse (`getQueryResultIfExistsInJob`) then shares that fresh result with the dependent query, and the
cache is not consulted for it.

### 5.2 Saving (`saveAsDailyCache`)

- `createJobEntry`, `createResultSetEntry`, `createQueryResultEntry` and `createIndicatorResultEntry` copy the job's flag onto
  every row they create. That includes top-level results and sub query results created on demand in `runSubQueries`.
- Top-level results are saved as cache even though they are never read from it. That is what lets a later job reuse them as
  sub queries (run 1 → run 3 in §1).
- A result only counts as cache once it is `COMPLETED`. Results that are `QUEUED`, `RUNNING`, `ERRORED` or `CANCELLED` never
  match.
- Debug-patient queries are never saved as cache, whatever the flag says.

### 5.3 Lookup (`useDailyCache`)

For each **sub query** result the job is about to compute (never a top-level one), search for a source result where all of
the following hold:

| Condition                                   | Why                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `query_result.query_iri = :iri`             | Same query.                                                                 |
| `query_result.version = :hash`              | Same arguments (see §5.4).                                                  |
| `query_result.save_as_daily_cache = 1`      | Offered as cache.                                                           |
| `query_result.status = 'COMPLETED'`         | Finished and successful.                                                    |
| `DATE(query_result.end_time) = :today`      | Produced today (see §5.5).                                                  |
| `query_result.cached_from_query_result_id IS NULL` *or* follow it to the source | Avoid chains of copies; always point at the original (see §5.6). |
| `query_result_set.job_id <> :currentJobId`  | Reuse inside a job is already handled by `getQueryResultIfExistsInJob`.     |

There is no user condition. A result from any user's job can be a source.

The source can have been top-level or a sub query in its own job. Either way it is a match.

When several rows match, take the most recent (`ORDER BY end_time DESC LIMIT 1`).

The lookup is `findDailyCacheResult(iri, hash, today, currentJobId)` in `server/helpers/mysqlHelper.ts`. It compares `end_time`
with the bounds of the day (`>= today 00:00`, `< tomorrow 00:00`) rather than `DATE(end_time)`, so the index can be used.
The copy itself is `useDailyCache` in `server/utils/executeQuery.ts`.

### 5.4 Matching on arguments as well as the IRI

This spec matches on `version` as well as the IRI. `version` is `hashQueryRequest`: a hash of the IRI and the resolved
arguments. Without it, a result for `$searchDate = 2025-04-01` could be reused for a request with `$searchDate = 2026-11-24`,
or a result filtered to one set of organisations could be reused for another. Because the cache is shared between users, this
also stops one user's organisation-filtered result being served to a user who asked for different organisations. The
defaults (`$searchDate` / `$achievementDate` = today) are filled in by `resolveArgs` before hashing, so a default run still
matches any other default run of the same query that day.

### 5.5 "Today"

`today` is `getToday()`, which is the **UTC** date (`new Date().toISOString().slice(0, 10)`). That matches how default
`$searchDate` values are produced. Between 00:00 and 01:00 BST, the UTC date is still the previous day, so the cache would be
treated as yesterday's. The date compared is the date the **result completed** (`end_time`), not the date the job was
queued. drizzle writes every `datetime` column as a UTC string, so `end_time` is stored in UTC and the comparison is consistent.

### 5.6 Reusing a hit

The cache reuses a result by **copying it into the current job**. Read endpoints do not redirect to the source result. On a hit
for a sub query result with planned id `R` (the row created by `runSubQueries` or `prepareIndicatorSubQueries`) and source
result `S`:

1. Mark `R` `RUNNING` as now.
2. Copy the result rows server-side (`copyResultRows`), about `DELETE_BATCH_SIZE` rows per statement so no single statement holds a
   long lock. Batches are ranges of `entity_id`, so an entity with several rows is always copied whole:
   - cohort: `INSERT INTO cohort_results (query_result_id, entity_id, entity_org_id) SELECT :R, entity_id, entity_org_id FROM cohort_results WHERE query_result_id = :S`
   - dataset: the same for `dataset_results` (`entity_id, column_group, json, entity_org_id`).
3. Copy `executed_sql` from `S` to `R`, and set `R.cached_from_query_result_id = S` (or `S.cached_from_query_result_id` if `S` is
   itself a copy, so the column always points at the original).
4. **Copy the sub query tree.** Job summaries (`jobSummaries.ts`) and patient inclusion (`patientInclusion.ts`) read
   `query_dependency`, so `S`'s sub query results must exist in the current job too. Walk `query_dependency` from `S`. For each
   sub result, reuse the matching result already in the current job (`getQueryResultIfExistsInJob`) or create one, and copy
   it the same way. Then insert the dependency edges with `createQueryDependencies`. Sub results found this way are copied
   from `S`'s tree whether or not they carry the cache flag, because they belong to a result that does. They are not looked
   up in the cache separately.
5. Mark `R` `COMPLETED`, which sets `end_time`, and emit the queue update as usual.
6. Skip `runSubQueries`, `getValidatedSQL` and SQL execution for `R`.

Sub results are copied before the results that use them. If any step fails, the result being copied is undone
(`discardCopiedQueryResult`): its rows are deleted, then the result is deleted if the copy created it, or set back to `QUEUED`
(a sub result) or `RUNNING` (`R`). Sub results already copied in full are kept, and they are not run again. Then a warning is
logged and the job **falls back to running the sub query normally**. A failed lookup also falls back. A cache failure must
never fail the job.

A copy can complete a sub result the current job had `QUEUED` to run later. `runSubQueries` then takes it off its list, so it
is not run on top of the copy.

On a miss, `R` runs as today, and `runSubQueries` checks each of `R`'s own sub queries against the cache. So the cache is tried
at every level below the top, and the first hit on a branch covers everything beneath it.

**Why copy rather than reference?** Every read path (results, ids, download, summaries, patient inclusion, comparison, SQL view)
and `deleteJobData` keys on `query_result_id`. Copying keeps all of them unchanged, and deleting the source job leaves the
copies intact. The cost is extra rows and an `INSERT … SELECT`, which is still far cheaper than running the query. A
reference-based variant is noted in §9.

### 5.7 Where the check runs

| Path                                       | Change                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `executeQuery` for a top-level request     | No cache lookup. The query always runs. Its sub queries go through `runSubQueries`, which does the lookup.     |
| `runSubQueries`                            | After `getQueryResultIfExistsInJob` misses, if `useDailyCache` is set, try §5.6 before executing the SQL.     |
| Indicator sub queries (`executeQuery`)     | They are sub queries of the indicator, so after the existing `getQueryResultIfExists` check, try §5.6.        |
| `runPlannedRequest`                        | No change. The top-level request always runs, so `getValidatedSQL` is always needed.                          |
| Indicators                                 | `indicator_result` itself is not copied, and the indicator is always computed. Only its sub queries can hit. |

`executeQuery` serves both top-level requests and indicator sub queries, so `runPlannedRequest` passes `isSubQuery` for an
indicator's queries. The flag reaches the runner as `QueryResultSet.useStartOfDaySnapshot`. The sub queries of a debug-patient
run never use the cache, whether or not they carry `$debugPatientId` themselves.

### 5.8 Interaction with jobs still running

If job A is still running when job B reaches the same sub query, B finds no `COMPLETED` row and runs the sub query itself. B
does not wait for A, which keeps the consumer simple and avoids deadlocks. This is accepted behaviour.

### 5.9 Cancel and delete

- Deleting a job removes its results from the cache. Jobs that already copied them keep their copies. Because the cache is
  shared, one user deleting a job can turn another user's later lookup into a miss. The query then just runs.
- Cancelling a job: only its results that had already `COMPLETED` remain usable as cache.

## 6. UI (minimal)

- Job submission UI, if and when there is one: two checkboxes, both ticked by default: "Save as today's cache" and "Use
  today's cache for sub queries".
- The queue view shows a `CACHED` tag next to the status of results where `cached_from_query_result_id` is not null
  (`fromDailyCache` in the job summaries). The tooltip says the result was copied from earlier today. Showing the source job id
  and completion time is left for later. The source user is never shown.
- The queue list shows when a job has opted out of either flag.

## 7. Logging

- `LOG.info` for each hit: `Daily cache hit: iri, hash, source result S → R (n rows)`.
- `LOG.debug` for a miss. `LOG.warn` for a failed copy that fell back to running the sub query.

## 8. Testing

**Unit (`tests/unit/`)**

- `jobRequestSchema`: both flags default to `true`, and booleans are accepted.
- `findDailyCacheResult` matches only when every condition in §5.3 holds. Cover each negative separately:
  - other IRI
  - other arguments
  - flag not set
  - not `COMPLETED`
  - yesterday
  - same job
- A result from another user's job matches.
- A source that was top-level in its own job matches.
- Several matches: the most recent wins.
- A top-level query with a cached result available still runs, and its result is saved as cache.
- A sub query hit copies cohort and dataset rows, `executed_sql`, `cached_from_query_result_id` and the sub query tree with
  its dependency edges, and does not call IMAPI or run any SQL for it.
- A sub query miss runs, and its own sub queries are each looked up.
- Indicator sub queries are looked up. The indicator itself is always computed.
- An IRI that is both top-level and a sub query in the same job runs once, fresh, and is shared within the job.
- A copy failure falls back to running the sub query, and the job still completes.
- A debug-patient request never saves and never uses the cache.
- `useDailyCache: false` behaves exactly like today's code.
- Copied results are themselves flagged as cache, and their `cached_from_query_result_id` points at the original.
- Deleting the source job leaves the copies readable.

**E2E**

- User A runs a job with `GMS`. User B runs a job with `GMS`: it runs again and is not tagged as cached. User B then runs a job
  with a query that has `GMS` as a sub query: the job completes, `GMS` is tagged as cached, and the counts and patient lists
  match a run with `useDailyCache: false`.

## 9. Alternatives considered

- **Reference instead of copy.** Point `R` at `S` and resolve reads through `cached_from_query_result_id`. This stores nothing
  extra, but every read path and the sub query tree resolution would need to follow the pointer, and deleting the source job
  would break every job that references it. Revisit only if copying large datasets is measured to be too slow.
- **Using the cache for top-level queries too.** Rejected. A user who adds a query to a job expects it to run, and the
  top-level run is what keeps the cache fresh for the queries that depend on it.
- **Cache scoped to each user.** Rejected. Sub queries such as registered populations are shared by many users' queries, and
  sharing is where most of the saving comes from. Matching on arguments (§5.4) keeps different filters apart.
- **Flags per query request instead of per job.** More flexible, but not needed now. The flags are stored on each
  `query_result`, so per-request flags can be added later without a schema change.

## 10. Open questions

1. **Data access between users.** Does any user have narrower data access than another, enforced other than through the query
   arguments? If so, a shared cache could expose results computed under someone else's access, and the lookup would need to
   match on that access scope too.
2. **Cleanup.** Every job now produces cache rows. Should a scheduled task (`server/tasks/`) clear earlier days' cache flags or
   jobs, or are they ordinary jobs that the user manages?
