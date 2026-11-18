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
  </TreeTable>
</template>

<script setup lang="ts">
import type { ComparisonPatient, PatientInclusionNode } from "~~/models";

import type { TreeNode } from "primevue/treenode";

const props = withDefaults(defineProps<{ jobId: number | string; queryIri: string; patients: ComparisonPatient[]; rows?: number }>(), { rows: 25 });

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
        ? [queryNode(inclusion.tree, entityId)]
        : inclusion?.error
          ? [{ key: `${entityId}/error`, data: { name: inclusion.error, found: null, error: true }, leaf: true }]
          : []
    };
  })
);

/** Keyed by position as well as iri: the same sub query can appear more than once in a tree */
function queryNode(query: PatientInclusionNode, parentKey: string, index = 0): TreeNode {
  const key = `${parentKey}/${index}:${query.iri}`;
  return {
    key,
    data: { name: query.name || query.iri, iri: query.iri, found: query.found },
    leaf: !query.children.length,
    children: query.children.map((child, i) => queryNode(child, key, i))
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
</script>
