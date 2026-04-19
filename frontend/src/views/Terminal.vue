<template>
  <!--
    /terminal — MiroShark Operator Terminal.

    The terminal UI is the standalone HTML dashboard served by the
    execution-router on :5004 (vanilla JS + EventSource so it has zero
    runtime deps and stays usable when the Vue dev server is down).

    We embed it via iframe rather than re-implementing the panes in Vue
    because the standalone dashboard is the source of truth: every
    polish pass on positions/health/SSE lands there first, and the
    operator runs it directly when the Vue shell isn't up.
  -->
  <div class="terminal-shell">
    <iframe
      :src="terminalUrl"
      class="terminal-frame"
      title="MiroShark Terminal"
      allow="clipboard-write"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'

// Allow override at build time (vite env) or by hostname so this works
// in `npm run dev` (vue on :3000, router on :5004) and in any future
// deploy where the router lives behind the same origin.
const terminalUrl = computed(() => {
  const env = import.meta.env.VITE_EXECUTION_ROUTER_URL
  if (env) return env
  const host = window.location.hostname || 'localhost'
  return `http://${host}:5004/`
})
</script>

<style scoped>
.terminal-shell {
  position: fixed;
  inset: 0;
  background: #ffffff;
}
.terminal-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
</style>
