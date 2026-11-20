<template>
  <Dialog
    v-model:visible="showDialog"
    modal
    :header="suite ? QUERY_REPORT_SUITES[suite].label : 'Query report'"
    :style="{ width: '32rem' }"
    pt:mask:class="backdrop-blur-sm"
  >
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-2">
        <label class="font-semibold">Organisations</label>
        <OrganisationSelect v-model="organisationIds" />
      </div>
      <div class="flex flex-col gap-2">
        <label class="font-semibold" for="report-search-date">Search date</label>
        <DatePicker
          v-model="searchDate"
          inputId="report-search-date"
          dateFormat="yy-mm-dd"
          showIcon
          showButtonBar
          iconDisplay="input"
          placeholder="Today"
          data-testid="report-search-date-input"
        />
        <small class="text-color-secondary"> Run the queries on a specific date. </small>
      </div>
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <Checkbox v-model="singleJob" inputId="report-single-job" binary data-testid="report-single-job" />
          <label for="report-single-job">Run as a single job</label>
        </div>
        <small class="text-color-secondary"> Send all the queries in one job instead of a job each. The first query to fail stops the rest. </small>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDialog = false" />
      <Button label="Run report" icon="fa-solid fa-play" @click="run" data-testid="report-run" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { QUERY_REPORT_SUITES } from "#shared/queryReport";
import type { QueryReportSuite } from "#shared/queryReport";
import OrganisationSelect from "~/components/queryRunner/OrganisationSelect.vue";
import type { QueryReportOptions } from "~/utils/queryReport";

defineProps<{ suite: QueryReportSuite | undefined }>();
const emit = defineEmits<{ run: [options: QueryReportOptions] }>();

const showDialog = defineModel<boolean>("showDialog");

// Kept while the page is open, so running another suite starts from the last choices
const organisationIds = ref<string | string[] | undefined>([]);
const searchDate = ref<Date | null>(null);
const singleJob = ref(false);

function run() {
  const orgs = ([] as string[]).concat(organisationIds.value ?? []).filter(Boolean);
  emit("run", { singleJob: singleJob.value, organisationIds: orgs.length ? orgs : undefined, searchDate: formatDate(searchDate.value) });
  showDialog.value = false;
}

function formatDate(date: Date | null): string | undefined {
  if (!date) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
</script>
