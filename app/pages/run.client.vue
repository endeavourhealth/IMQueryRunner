<template>
  <div>
    <div class="flex gap-2 m-2">
      <div class="m-2">
        <Button icon="fa-solid fa-arrow-left" label="Discard and exit" severity="secondary" @click="discardJob" />
      </div>
    </div>
    <Dialog v-model:visible="showAddDialog" header="Add to job" :closable="false" :style="{ width: '60rem' }" :breakpoints="{ '960px': '95vw' }" modal>
      <div class="mb-4">
        <div class="mb-2">Find a query:</div>
        <AutocompleteSearchBar
          id="autocomplete-search"
          v-model:selected="selected"
          :im-query="request"
          :root-entities="[IM.MODULE_QUERIES]"
          placeholder="Search queries"
        />
      </div>
      <ArgumentDisplay
        v-if="selected && args?.length"
        :arguments="args"
        :showFooterButtons="false"
        :editArguments="true"
        @hide-dialog="cancelAdd"
        @arguments-completed="passArguments"
      />
      <template #footer>
        <Button class="m-1" label="Cancel" variant="outlined" @click="cancelAdd" />
        <Button class="m-1" label="Add" :disabled="selected === undefined || loading" @click="addToQueue" />
      </template>
    </Dialog>
    <DataTable v-if="queuedQueries.length" class="m-6" :value="queuedQueries">
      <template #empty>None</template>
      <Column header="Query">
        <template #body="{ data }: { data: QueuedQuery }">{{ data.selected.name }}</template>
      </Column>
      <Column>
        <template #body="{ index }">
          <Button icon="fa-solid fa-trash" severity="danger" variant="outlined" @click="removeFromQueue(index)" />
        </template>
      </Column>
    </DataTable>
    <div class="mx-6 my-2 flex gap-2">
      <Button icon="fa-solid fa-plus" label="Add to job" @click="showAddDialog = true" />
      <Button icon="fa-solid fa-play" label="Queue job" :disabled="!queuedQueries.length" @click="showDialog = true" />
    </div>
    <Dialog v-model:visible="showDialog" :closable="false" modal>
      Run <span class="font-bold">{{ jobName }}</span
      >?
      <template #footer>
        <Button class="m-1" label="Cancel" variant="outlined" @click="showDialog = false" autofocus />
        <Button class="m-1" label="Run" @click="runQueries" :disabled="disableRunButton" autofocus />
      </template>
    </Dialog>
    <Dialog v-model:visible="showDiscardDialog" header="Discard job?" :closable="false" modal>
      This job has {{ queuedQueries.length }} {{ queuedQueries.length === 1 ? "query" : "queries" }} that will be lost if you go back.
      <template #footer>
        <Button class="m-1" label="Keep editing" variant="outlined" @click="showDiscardDialog = false" autofocus />
        <Button class="m-1" label="Discard" severity="danger" @click="confirmDiscard" />
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import ArgumentDisplay from "~/components/queryRunner/ArgumentDisplay.vue";
import AutocompleteSearchBar from "~/components/queryRunner/AutocompleteSearchBar.vue";
import QueryService from "~/services/QueryService";
import type { JobRequest } from "~~/models";

import { watch } from "vue";

import { IM, RDF } from "@endeavour/vue-library/enums";
import { type Argument, type ArgumentReference, type SearchResultSummary } from "@endeavour/vue-library/models";

import { cloneDeep } from "lodash-es";

interface ArgumentSelection extends ArgumentReference {
  valueData?: any;
}

interface QueuedQuery {
  selected: SearchResultSummary;
  argument: Argument[];
}

const selected: Ref<SearchResultSummary | undefined> = ref();
const args: Ref<ArgumentSelection[] | undefined> = ref([]);
const completedArguments: Ref<Argument[]> = ref([]);
const queuedQueries: Ref<QueuedQuery[]> = ref([]);
const loading = ref(false);
const toast = useToast();

const jobName = computed(() => {
  if (!queuedQueries.value.length) return "";
  const first = queuedQueries.value[0]!.selected.name;
  const others = queuedQueries.value.length - 1;
  if (!others) return `Job: ${first}`;
  return `Job: ${first} and ${others} other ${others === 1 ? "query" : "queries"}`;
});
const request: any = {
  query: {
    where: {
      and: [
        {
          iri: RDF.TYPE,
          is: [
            {
              iri: IM.QUERY
            },
            {
              iri: IM.INDICATOR
            }
          ]
        }
      ]
    }
  }
};

const showDialog = ref(false);
const showAddDialog = ref(false);
const showDiscardDialog = ref(false);
const missingArgs = ref(true);
const disableRunButton = ref(false);

watch(
  selected,
  async (newValue, oldValue) => {
    loading.value = true;
    if (newValue !== oldValue && newValue) {
      args.value = [];
      const index = selected.value?.type.findIndex(tp => tp.iri === IM.INDICATOR);
      if (index === -1) {
        await getArguments();
      }
    }
    loading.value = false;
  },
  { deep: true }
);

watch(
  () => cloneDeep(completedArguments.value),
  (newValue, oldValue) => {
    if (newValue !== oldValue) {
      if (completedArguments.value && completedArguments.value.length) {
        for (const arg of completedArguments.value) {
          missingArgs.value = !arg.valueData;
        }
      }
    }
  },
  { deep: true }
);

function passArguments(args: Argument[], runOnConfirm: boolean) {
  completedArguments.value = args;
  missingArgs.value = !runOnConfirm;
}

function resetSelection() {
  selected.value = undefined;
  args.value = [];
  completedArguments.value = [];
  missingArgs.value = true;
}

function addToQueue() {
  if (!selected.value) return;
  queuedQueries.value.push({ selected: selected.value, argument: completedArguments.value });
  resetSelection();
  showAddDialog.value = false;
}

function cancelAdd() {
  resetSelection();
  showAddDialog.value = false;
}

function removeFromQueue(index: number) {
  queuedQueries.value.splice(index, 1);
}

async function runQueries() {
  disableRunButton.value = true;
  const jobRequest = {
    jobName: jobName.value,
    queryRequests: queuedQueries.value.map(queuedQuery => ({
      query: {
        iri: queuedQuery.selected.iri
      },
      argument: queuedQuery.argument
    }))
  } as JobRequest;

  await $fetch("/api/queue/job/add", {
    method: "post",
    body: jobRequest
  });
  showDialog.value = false;
  backToQueue();
}

async function getArguments() {
  let query;
  try {
    query = await QueryService.getQueryFromIri(selected.value!.iri);
  } catch (error: any) {
    toast.add({ severity: "error", summary: `${selected.value!.name} can't be run`, detail: error?.data?.data?.message ?? String(error), life: 10000 });
    selected.value = undefined;
    return;
  }
  query.iri = selected.value!.iri;
  // args.value = await QueryService.findMissingArguments({
  //   query: query
  // } as QueryRequest);
  args.value = [
    { parameter: "$organisationId" } as ArgumentSelection,
    { parameter: "$patientId" } as ArgumentSelection,
    { parameter: "$debugPatientId" } as ArgumentSelection,
    { parameter: "$searchDate" } as ArgumentSelection
  ];
  missingArgs.value = !!args.value.length;
}

function discardJob() {
  if (queuedQueries.value.length) showDiscardDialog.value = true;
  else backToQueue();
}

function confirmDiscard() {
  showDiscardDialog.value = false;
  backToQueue();
}

function backToQueue() {
  disableRunButton.value = false;
  navigateTo("/QueryRunner");
}
</script>

<style scoped></style>
