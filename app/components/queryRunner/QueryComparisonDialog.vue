<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Compare with CSV"
    :style="{ width: '40rem' }"
    :breakpoints="{ '640px': '95vw' }"
    data-testid="query-comparison-dialog"
    @hide="reset"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <label class="font-semibold">CSV file</label>
        <FileUpload
          mode="basic"
          accept=".csv,text/csv"
          :auto="false"
          customUpload
          chooseLabel="Choose CSV"
          chooseIcon="fa-solid fa-file-csv"
          @select="onSelect"
          @clear="reset"
          data-testid="query-comparison-file"
        />
        <small v-if="error" class="text-red-500">{{ error }}</small>
      </div>
      <div v-if="headers.length" class="flex flex-col gap-2">
        <label class="font-semibold">Entity id column</label>
        <Select v-model="idColumn" :options="headers" placeholder="Select a column" data-testid="query-comparison-id-column" />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" outlined @click="visible = false" />
      <Button label="Compare" icon="fa-solid fa-diagram-venn" :disabled="!idColumn" @click="compare" data-testid="query-comparison-submit" />
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { parseCsv } from "~/helpers/csv";
import { useComparisonStore } from "~/stores/comparisonStore";

import type { FileUploadSelectEvent } from "primevue/fileupload";

/** The query (or sub query) of a job whose results are compared */
const props = defineProps<{ jobId: number; queryIri: string; queryType: string }>();
const visible = defineModel<boolean>("visible", { default: false });

const comparisonStore = useComparisonStore();

const fileName = ref("");
const rows = ref<string[][]>([]);
const headers = ref<string[]>([]);
const idColumn = ref<string>();
const error = ref("");

async function onSelect(event: FileUploadSelectEvent) {
  reset();
  const file = (Array.isArray(event.files) ? event.files[0] : event.files) as File | undefined;
  if (!file) return;
  const parsed = parseCsv(await file.text());
  if (!parsed.length) {
    error.value = "The file is empty";
    return;
  }
  fileName.value = file.name;
  headers.value = parsed[0]!.map(h => h.trim());
  rows.value = parsed.slice(1);
  idColumn.value = headers.value.find(h => h.toLowerCase() === "entityid" || h.toLowerCase() === "entity_id");
}

function reset() {
  fileName.value = "";
  rows.value = [];
  headers.value = [];
  idColumn.value = undefined;
  error.value = "";
}

async function compare() {
  const index = headers.value.indexOf(idColumn.value!);
  const ids = rows.value.map(r => r[index]?.trim() ?? "").filter(Boolean);
  comparisonStore.setCsvIds(ids, fileName.value);
  visible.value = false;
  await navigateTo(`/compare/${props.jobId}/${props.queryType}/${encodeURIComponent(props.queryIri)}`);
}
</script>
