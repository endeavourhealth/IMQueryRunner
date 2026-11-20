<template>
  <div class="comparison-page">
    <div class="comparison-actions">
      <Button icon="fa-solid fa-arrow-left" label="Back to queue" @click="navigateTo('/')" />
      <Button icon="fa-duotone fa-solid fa-list" label="View results" severity="secondary" @click="viewResults" data-testid="comparison-view-results" />
    </div>
    <Message v-if="!comparisonStore.csvIds.length" severity="warn" :closable="false" data-testid="comparison-no-csv">
      No CSV loaded. Go back to the queue and compare again.
    </Message>
    <Message v-else-if="error" severity="warn" :closable="false" data-testid="comparison-error">{{ error }}</Message>
    <ProgressSpinner v-else-if="loading" />
    <template v-else>
      <div class="comparison-overview" data-testid="comparison-summary">
        <div v-for="(column, index) in overview" :key="index" class="comparison-overview-column">
          <div v-for="item in column" :key="item.label" class="comparison-overview-item">
            <span class="font-semibold">{{ item.label }}:</span> {{ item.value }}
            <span v-if="item.note" class="comparison-overview-note">({{ item.note }})</span>
          </div>
        </div>
      </div>
      <div class="comparison-sections">
        <Panel
          v-for="section in sections"
          :key="section.key"
          toggleable
          :header="`${section.title} (${section.ids.length})`"
          :data-testid="`comparison-${section.key}`"
        >
          <ComparisonTreeTable
            :jobId="route.params.jobId as string"
            :queryIri="route.params.queryIri as string"
            :queryArguments="queryArguments"
            :patients="section.patients"
          />
        </Panel>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import ComparisonTreeTable from "~/components/queryRunner/ComparisonTreeTable.vue";
import { useComparisonStore } from "~/stores/comparisonStore";
import type { ComparisonContext, ComparisonPatient } from "~~/models";

import type { Argument } from "@endeavour/vue-library/models";

const route = useRoute();
const comparisonStore = useComparisonStore();

const resultIds = ref<string[]>([]);
const queryName = ref("");
const queryArguments = ref<Argument[]>([]);
const loading = ref(true);
const error = ref("");

const comparison = computed(() => {
  const csv = new Set(comparisonStore.csvIds);
  const results = new Set(resultIds.value);
  return {
    csvOnly: [...csv].filter(id => !results.has(id)),
    both: [...csv].filter(id => results.has(id)).length,
    resultsOnly: [...results].filter(id => !csv.has(id))
  };
});

const sections = computed(() =>
  [
    { key: "csv-only", title: "In CSV only", ids: comparison.value.csvOnly },
    { key: "results-only", title: "In results only", ids: comparison.value.resultsOnly }
  ].map(section => ({ ...section, patients: toPatients(section.ids) }))
);

type OverviewItem = { label: string; value: string | number; note?: string };

/** The overview's three columns: what was compared, the counts, and the query's arguments */
const overview = computed<OverviewItem[][]>(() => {
  const csvOnly = comparison.value.csvOnly.length;
  const resultsOnly = comparison.value.resultsOnly.length;
  const both = comparison.value.both;
  const csvCount = csvOnly + both;
  const union = csvOnly + both + resultsOnly;
  const duplicates = comparisonStore.csvIds.length - csvCount;
  return [
    [
      { label: "Query", value: queryName.value },
      { label: "Iri", value: route.params.queryIri as string },
      { label: "CSV file", value: comparisonStore.fileName }
    ],
    [
      { label: "In CSV", value: csvCount, note: duplicates ? `${duplicates} duplicate${duplicates === 1 ? "" : "s"} ignored` : "" },
      { label: "In query results", value: resultIds.value.length },
      { label: "In both", value: both },
      { label: "Difference", value: csvOnly + resultsOnly, note: `${csvOnly} CSV only, ${resultsOnly} results only` },
      { label: "Match", value: `${union ? Math.round((both / union) * 1000) / 10 : 100}%`, note: "in both, out of all ids" }
    ],
    argumentItems()
  ];
});

/** $searchDate → Search date, as on the queue's arguments table */
function formatArgumentName(parameter: string): string {
  const name = parameter
    .replace("$", "")
    .replace(/([A-Z])/g, " $1")
    .toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The query's arguments, always with an organisation line: a query run without one shows the all organisations default */
function argumentItems(): OverviewItem[] {
  const args = queryArguments.value.some(arg => arg.parameter === "$organisationId")
    ? queryArguments.value
    : [...queryArguments.value, { parameter: "$organisationId" } as Argument];
  return args.map(arg => {
    const value = formatArgumentValue(arg);
    // A query run without organisations runs against all of them
    if (arg.parameter === "$organisationId" && value === "null")
      return { label: formatArgumentName(arg.parameter), value: "All organisations", note: "default" };
    return { label: formatArgumentName(arg.parameter ?? ""), value };
  });
}

function formatArgumentValue(arg: Argument): string {
  const value = arg.valueData ?? arg.valueDataList ?? arg.valueIri?.iri ?? arg.valueIriList?.map(v => v.iri);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "null";
  return value === undefined || value === null || value === "" ? "null" : String(value);
}

function viewResults() {
  const { jobId, queryType, queryIri } = route.params;
  navigateTo(`/results/${jobId}/${queryType}/${encodeURIComponent(queryIri as string)}`);
}

/** The tree table loads each patient's query and sub query details when their row is expanded */
function toPatients(ids: string[]): ComparisonPatient[] {
  return ids.map(entityId => ({ entityId }));
}

onMounted(async () => {
  if (!comparisonStore.csvIds.length) return;
  const { jobId, queryType, queryIri } = route.params;
  try {
    const base = `/api/queue/job/results/${jobId}/${queryType}/${encodeURIComponent(queryIri as string)}`;
    // The context has the name and arguments of the compared query, which can be a sub query: those ran with their top level query's arguments
    const [ids, context] = await Promise.all([$fetch<string[]>(`${base}/ids`), $fetch<ComparisonContext>(`${base}/context`)]);
    resultIds.value = ids;
    queryName.value = context.queryName;
    queryArguments.value = context.arguments;
  } catch (e: any) {
    error.value = e?.data?.message ?? "Could not load the results";
  } finally {
    loading.value = false;
  }
});
</script>

<!-- Layout is plain CSS: Tailwind does not pick up classes from this file (its path has [brackets]) -->
<style scoped>
.comparison-page {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.5rem;
  overflow: auto;
  padding: 0.5rem;
  background-color: var(--p-content-background);
}

.comparison-actions {
  display: flex;
  gap: 0.5rem;
}

.comparison-overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem 2rem;
}

.comparison-overview-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.25rem;
}

.comparison-overview-item {
  overflow-wrap: break-word;
}

.comparison-overview-note {
  color: var(--p-text-muted-color);
}

.comparison-sections {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.5rem;
}
</style>
