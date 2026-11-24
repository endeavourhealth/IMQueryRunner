<template>
  <div class="flex-auto overflow-auto">
    <div class="h-[calc(100% - 3.5rem)] overflow-auto">
      <div class="flex h-full flex-auto flex-col flex-nowrap overflow-auto bg-(--p-content-background)">
        <div class="m-2">
          <Button icon="fa-solid fa-arrow-left" label="Back to queue" @click="backToQueue" />
        </div>
        <div v-if="executedSql" ref="sqlPanel" class="m-2 min-w-0">
          <Panel v-model:collapsed="sqlCollapsed" :toggleable="true">
            <template #header>
              <div class="flex items-center gap-2">
                <span class="font-bold">Executed SQL</span>
                <Tag v-if="highlightedCte" severity="warn" data-testid="query-results-highlighted-cte">
                  <span>{{ highlightedCte }}</span>
                  <i class="fa-solid fa-xmark ml-1 cursor-pointer" title="Clear highlight" @click.stop="highlightedCte = null" />
                </Tag>
              </div>
            </template>
            <SQLViewer ref="sqlViewer" :sql="executedSql" :highlight="highlightedCte" />
          </Panel>
        </div>
        <Message v-if="resultsError" class="m-2" severity="warn" :closable="false" data-testid="query-results-error">{{ resultsError }}</Message>
        <DataTable
          v-else
          ref="dt"
          :size="'small'"
          :value="queryResults"
          :paginator="true"
          :rows="rows"
          :scrollable="true"
          scroll-height="600px"
          :autoLayout="true"
          @page="onPage($event)"
          :lazy="true"
          :total-records="totalCount"
          :rows-per-page-options="[originalSize, originalSize * 2, originalSize * 4, originalSize * 8]"
          :loading="loading"
          :paginatorTemplate="'FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown'"
          data-testid="query-results-table"
        >
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xl font-bold">Total results: {{ totalCount }}</span>
            </div>
          </template>
          <template #empty>None</template>
          <Column v-for="col of columns" :key="col.field" :field="col.field" :header="col.header">
            <template v-if="col.field === CTE_NAME_FIELD && executedSql" #body="{ data }">
              <Button
                :label="data[col.field]"
                link
                size="small"
                class="p-0!"
                :class="{ 'font-bold': data[col.field] === highlightedCte }"
                title="Show in the executed SQL"
                @click="showCteInSql(data[col.field])"
              />
            </template>
          </Column>
        </DataTable>
      </div>
      <div class="im-dialog-footer">
        <div class="button-footer">
          <Button
            class="m-2"
            :disabled="!queryResults.length"
            data-testid="query-results-download"
            label="Download"
            :loading="downloadLoading"
            @click="downloadQueryResults()"
            autofocus
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from "vue";
import { nextTick, onMounted, ref, useTemplateRef } from "vue";

import { isArrayHasLength } from "@endeavour/vue-library";
import { useUserStore } from "@endeavour/vue-library/stores";

import { isArray } from "lodash-es";

import SQLViewer from "./SQLViewer.vue";

interface Props {
  jobId: string | string[] | undefined;
  queryIri: string | string[] | undefined;
  queryType: string | string[] | undefined;
}

const props = defineProps<Props>();
const { currentUser } = useUserStore();

const loading = ref(false);
const downloadLoading = ref(false);
const queryResults: Ref<any[]> = ref([]);
const page = ref(1);
const rows = ref(25);
const originalSize = ref(25);
const totalCount = ref();
const columns: Ref<any[]> = ref([]);
const executedSql = ref<string | null>(null);
const resultsError = ref<string | null>(null);
const sqlCollapsed = ref(true);
const highlightedCte = ref<string | null>(null);
const sqlPanel = useTemplateRef<HTMLDivElement>("sqlPanel");
const sqlViewer = useTemplateRef<InstanceType<typeof SQLViewer>>("sqlViewer");

/** The debug results column naming the WITH (CTE) each row checked */
const CTE_NAME_FIELD = "cteName";

onMounted(async () => {
  // Independent: a query that failed has no results, but its SQL is what you came to see
  const [results, sql] = await Promise.allSettled([getQueryResults(), getExecutedSql()]);
  if (results.status === "rejected") resultsError.value = results.reason?.data?.message ?? "Could not load the results";
  if (sql.status === "rejected") console.warn("Could not load the executed SQL:", sql.reason);
  sqlCollapsed.value = !resultsError.value;
  formatResultsForTable();
});

async function getQueryResults() {
  if (props.jobId && props.queryIri && props.queryType) {
    const value = await $fetch<{ totalCount: number; result: any[] }>(
      `/api/queue/job/results/${props.jobId}/${props.queryType}/${encodeURIComponent(props.queryIri as string)}`,
      {
        query: {
          userId: currentUser?.id,
          page: page.value,
          size: rows.value
        }
      }
    );
    if (value && isArray(value.result)) {
      totalCount.value = value.totalCount;
      queryResults.value = value.result;
    }
  }
}

function formatResultsForTable() {
  if (!isArrayHasLength(queryResults.value)) return;
  for (const key of Object.keys(queryResults.value[0])) {
    if (key !== "hashcode") columns.value.push({ field: key, header: key.replace("_", " ") });
  }
}

// The server streams the whole result as CSV, so a large result never has to fit in the browser first
function downloadQueryResults() {
  const link = document.createElement("a");
  link.href = `/api/queue/job/results/${props.jobId}/${props.queryType}/${encodeURIComponent(props.queryIri as string)}/download`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function onPage(event: any) {
  page.value = ++event.page;
  rows.value = event.rows;
  await getQueryResults();
}

async function showCteInSql(cteName: string) {
  highlightedCte.value = cteName;
  sqlCollapsed.value = false;
  await nextTick();
  sqlPanel.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  // Let the panel finish expanding before scrolling the definition into view
  setTimeout(() => sqlViewer.value?.scrollToHighlight(), 300);
}

function backToQueue() {
  navigateTo("/QueryRunner");
}

async function getExecutedSql() {
  if (props.jobId && props.queryIri) {
    const value = await $fetch<{ executedSQL: string | null }>(
      `/api/queue/job/sql/${props.jobId}/${props.queryType}/${encodeURIComponent(props.queryIri as string)}`
    );
    if (value?.executedSQL) {
      executedSql.value = value.executedSQL;
    }
  }
}
</script>

<style scoped>
:deep(.p-panel-content-container),
:deep(.p-panel-content-wrapper),
:deep(.p-panel-content) {
  min-width: 0;
}
</style>
