<template>
  <TreeTable
    :value="nodes"
    :paginator="nodes.length > rows"
    :rows="rows"
    :rows-per-page-options="[rows, rows * 2, rows * 4, rows * 8]"
    :paginatorTemplate="'FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown'"
    size="small"
    data-testid="comparison-tree-table"
  >
    <template #empty>No patients</template>
    <Column field="name" header="Patient / query" expander />
    <Column field="found" header="Found" class="w-24">
      <template #body="{ node }">
        <i v-if="node.data.found === true" class="fa-solid fa-check text-green-500" v-tooltip.left="'Returned by this query'" />
        <i v-else-if="node.data.found === false" class="fa-solid fa-xmark text-red-500" v-tooltip.left="'Not returned by this query'" />
      </template>
    </Column>
  </TreeTable>
</template>

<script setup lang="ts">
import type { ComparisonPatient, ComparisonQueryRow } from "~~/models";

import type { TreeNode } from "primevue/treenode";

const props = withDefaults(defineProps<{ patients: ComparisonPatient[]; rows?: number }>(), { rows: 25 });

/** patient → compared query → its sub queries */
const nodes = computed<TreeNode[]>(() =>
  props.patients.map(patient => ({
    key: patient.entityId,
    data: { name: patient.entityId, found: null },
    children: patient.query
      ? [
          {
            ...queryNode(patient.query, patient.entityId),
            children: patient.query.subQueries.map(sub => ({ ...queryNode(sub, `${patient.entityId}/${patient.query!.queryIri}`), leaf: true }))
          }
        ]
      : []
  }))
);

function queryNode(query: ComparisonQueryRow, parentKey: string): TreeNode {
  return {
    key: `${parentKey}/${query.queryIri}`,
    data: { name: query.queryName, found: query.found }
  };
}
</script>
