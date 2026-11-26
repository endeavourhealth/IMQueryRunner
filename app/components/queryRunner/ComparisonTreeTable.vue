<template>
  <TreeTable
    :value="nodes"
    :paginator="nodes.length > rows"
    :rows="rows"
    :rows-per-page-options="[rows, rows * 2, rows * 4, rows * 8]"
    :paginatorTemplate="'FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown'"
    loadingMode="icon"
    size="small"
    data-testid="comparison-tree-table"
    @nodeExpand="onNodeExpand"
  >
    <template #empty>No patients</template>
    <Column field="name" header="Patient / query" expander>
      <template #body="{ node }">
        <span v-if="node.data.error" class="text-red-500">{{ node.data.name }}</span>
        <span v-else v-tooltip.top="node.data.iri">{{ node.data.name }}</span>
      </template>
    </Column>
    <Column field="found" header="Found" class="w-24">
      <template #body="{ node }">
        <i v-if="node.data.found === true" class="fa-solid fa-check text-green-500" v-tooltip.left="'Returned by this query'" />
        <i v-else-if="node.data.found === false" class="fa-solid fa-xmark text-red-500" v-tooltip.left="'Not returned by this query'" />
        <i v-else-if="node.data.iri" class="fa-solid fa-minus text-gray-400" v-tooltip.left="'Not known: an indicator, or the query did not complete'" />
      </template>
    </Column>
    <Column class="w-24">
      <template #body="{ node }">
        <div v-if="typeof node.data.found === 'boolean'" class="flex items-center justify-end gap-1">
          <Button
            :icon="debugRuns.has(debugKey(node)) ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play'"
            severity="success"
            class="p-button-rounded p-button-text"
            :pt="{ icon: { class: 'text-green-500' } }"
            :disabled="debugRuns.has(debugKey(node)) || debugJobIds.has(debugKey(node))"
            @click="runDebug(node)"
            v-tooltip.left="runTooltip(node)"
            data-testid="comparison-debug-run"
          />
          <Button
            v-if="debugJobIds.has(debugKey(node))"
            icon="fa-duotone fa-solid fa-list"
            class="p-button-rounded p-button-text p-button-plain"
            @click="viewResults(node)"
            v-tooltip.left="'View results'"
            data-testid="comparison-debug-results"
          />
        </div>
      </template>
    </Column>
  </TreeTable>
</template>

<script setup lang="ts">
import { JobStatus } from "~~/enums";
import type { ComparisonPatient, Job, JobRequest, PatientInclusionNode } from "~~/models";

import type { Argument } from "@endeavour/vue-library/models";

import type { TreeNode } from "primevue/treenode";

const props = withDefaults(
  defineProps<{
    jobId: number | string;
    queryIri: string;
    queryArguments?: Argument[];
    patients: ComparisonPatient[];
    rows?: number;
  }>(),
  { rows: 25, queryArguments: () => [] }
);

const toast = useToast();

const debugPatientParameter = "$debugPatientId";
const pollIntervalMs = 2000;
const finishedStatuses = [JobStatus.COMPLETED, JobStatus.ERRORED, JobStatus.CANCELLED];

const debugRuns = reactive(new Set<string>());
const debugJobIds = reactive(new Map<string, number>());
let unmounted = false;
onBeforeUnmount(() => (unmounted = true));

type Inclusion = { loading: boolean; tree?: PatientInclusionNode; error?: string };

/** Each patient's inclusion tree, by entity id, once their row has been expanded */
const inclusions = reactive(new Map<string, Inclusion>());

/** patient → compared query → its sub queries, as deep as they go */
const nodes = computed<TreeNode[]>(() =>
  props.patients.map(({ entityId }) => {
    const inclusion = inclusions.get(entityId);
    return {
      key: entityId,
      data: { name: entityId, found: null },
      leaf: false,
      loading: inclusion?.loading ?? false,
      children: inclusion?.tree
        ? [queryNode(inclusion.tree, entityId, entityId)]
        : inclusion?.error
          ? [{ key: `${entityId}/error`, data: { name: inclusion.error, found: null, error: true }, leaf: true }]
          : []
    };
  })
);

/** Keyed by position as well as iri: the same sub query can appear more than once in a tree */
function queryNode(query: PatientInclusionNode, entityId: string, parentKey: string, index = 0): TreeNode {
  const key = `${parentKey}/${index}:${query.iri}`;
  return {
    key,
    data: { name: query.name || query.iri, iri: query.iri, queryType: query.queryType, found: query.found, entityId },
    leaf: !query.children.length,
    children: query.children.map((child, i) => queryNode(child, entityId, key, i))
  };
}

async function onNodeExpand(node: TreeNode) {
  // Only a patient row (its key is the entity id) loads anything; the tree under it is already there
  const entityId = node.key;
  if (!props.patients.some(patient => patient.entityId === entityId) || inclusions.get(entityId)?.tree) return;
  if (!/^\d+$/.test(entityId) || Number(entityId) <= 0) {
    inclusions.set(entityId, { loading: false, error: "Not a valid patient id" });
    return;
  }
  inclusions.set(entityId, { loading: true });
  try {
    const tree = await $fetch<PatientInclusionNode>(`/api/queue/job/results/${props.jobId}/patient`, {
      method: "POST",
      body: { patientId: Number(entityId), queryIri: props.queryIri }
    });
    inclusions.set(entityId, { loading: false, tree });
  } catch (e: any) {
    inclusions.set(entityId, { loading: false, error: e?.data?.message ?? "Could not load this patient's queries" });
  }
}

function debugKey(node: TreeNode): string {
  return `${node.data.entityId}|${node.data.iri}`;
}

function runTooltip(node: TreeNode): string {
  if (debugRuns.has(debugKey(node))) return "Running in debug mode";
  if (debugJobIds.has(debugKey(node))) return "Already run in debug mode";
  return "Run this query in debug mode for this patient";
}

async function runDebug(node: TreeNode) {
  const key = debugKey(node);
  if (debugRuns.has(key) || debugJobIds.has(key)) return;
  const { entityId, iri, name } = node.data;
  debugRuns.add(key);
  try {
    const job = await runDebugJob(entityId, iri, name);
    if (job) debugJobIds.set(key, job.id);
  } catch (e: any) {
    if (!unmounted)
      toast.add({ severity: "error", summary: `Debug run for patient ${entityId}`, detail: e?.data?.message ?? e?.message ?? String(e), life: 10000 });
  } finally {
    debugRuns.delete(key);
  }
}

function viewResults(node: TreeNode) {
  const jobId = debugJobIds.get(debugKey(node));
  if (jobId) window.open(`/results/${jobId}/${node.data.queryType}/${encodeURIComponent(node.data.iri)}`, "_blank");
}

async function runDebugJob(entityId: string, iri: string, name: string): Promise<Job | undefined> {
  const argument = [...props.queryArguments.filter(arg => arg.parameter !== debugPatientParameter), { parameter: debugPatientParameter, valueData: entityId }];
  const jobRequest = {
    jobName: `Debug patient ${entityId}: ${name || iri}`,
    queryRequests: [{ query: { iri }, argument }]
  } as JobRequest;
  const queued = await $fetch<{ jobId?: number } | undefined>("/api/queue/job/add", { method: "POST", body: jobRequest });
  if (!queued?.jobId) throw new Error("The debug run could not be queued");

  const job = await waitForJob(queued.jobId);
  if (job && job.status !== JobStatus.COMPLETED) throw new Error(`The debug run ${job.status === JobStatus.CANCELLED ? "was cancelled" : "failed"}`);

  return job;
}

async function waitForJob(jobId: number): Promise<Job | undefined> {
  while (!unmounted) {
    const job = await $fetch<Job>(`/api/queue/job/${jobId}`);
    if (job.status && finishedStatuses.includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return undefined;
}
</script>
