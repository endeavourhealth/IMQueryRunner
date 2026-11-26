import { ref } from "vue";

import { defineStore } from "pinia";

/** The entity ids read from the uploaded CSV, handed from the comparison dialog to the comparison page. Kept in memory only, so a page refresh loses them. */
export const useComparisonStore = defineStore("comparison", () => {
  const csvIds = ref<string[]>([]);
  const fileName = ref<string>("");

  function setCsvIds(ids: string[], name: string) {
    csvIds.value = ids;
    fileName.value = name;
  }

  return { csvIds, fileName, setCsvIds };
});
