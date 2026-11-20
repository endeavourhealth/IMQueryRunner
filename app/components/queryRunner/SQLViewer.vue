<template>
  <div class="relative min-w-0">
    <pre
      ref="pre"
      class="max-w-full cursor-pointer overflow-auto rounded bg-gray-900 p-4 text-sm text-green-400"
      title="Click to copy"
      @click="copyToClipboard"
    ><template v-for="(segment, index) in segments" :key="index"><mark
      v-if="segment.kind !== 'text'"
      :class="segment.kind === 'definition' ? 'cte-definition' : 'cte-reference'"
      :data-cte-kind="segment.kind"
    >{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></pre>
    <span v-if="copied" class="absolute right-2 top-2 rounded bg-green-600 px-2 py-1 text-xs text-white">Copied!</span>
  </div>
</template>

<script setup lang="ts">
import { splitSqlByCte } from "~/helpers/sqlHighlight";

interface Props {
  sql: string;
  /** A CTE (WITH) name to highlight: its definition and every reference to it */
  highlight?: string | null;
}

const props = defineProps<Props>();
const copied = ref(false);
const pre = ref<HTMLPreElement>();

const segments = computed(() => splitSqlByCte(props.sql, props.highlight));

async function copyToClipboard() {
  if (!props.sql) return;
  await navigator.clipboard.writeText(props.sql);
  copied.value = true;
  setTimeout(() => (copied.value = false), 2000);
}

/** Scrolls the definition of the highlighted CTE (or its first reference) into view */
function scrollToHighlight() {
  const target = pre.value?.querySelector('[data-cte-kind="definition"]') ?? pre.value?.querySelector("[data-cte-kind]");
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

defineExpose({ scrollToHighlight });
</script>

<style scoped>
.cte-definition {
  background-color: var(--p-yellow-400);
  color: var(--p-gray-900);
  font-weight: bold;
  border-radius: 2px;
  padding: 0 2px;
}

.cte-reference {
  background-color: var(--p-sky-300);
  color: var(--p-gray-900);
  border-radius: 2px;
  padding: 0 2px;
}
</style>
